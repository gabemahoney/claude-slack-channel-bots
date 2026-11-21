/** run the real scenario assertions over synthetic AD/receipt evidence.
 * No scenario is sourced, no native process is launched, and clocks are fake. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { TEST_MEASUREMENTS_KEY, TEST_MEASUREMENT_TIMINGS_KEY, CHANNEL_ID_RE, parsePersonaConfigBytes, DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS } from '../src/config.ts'
import { decideDelivery } from '../src/delivery-decision.ts'
import { buildDeliveryDispatchLine } from '../src/delivery-notices.ts'
import { createPersonaEventRouter } from '../src/persona-event-router.ts'
import { RELOAD_NOOP } from '../src/reload-apply.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX } from './test-helpers/credentials.ts'
import { test29ClosingFixture, test29EvidencePrinter, test29PrinterFixture, test29PrinterBindings, test29SwitchBindings, test29SwitchCallOrder } from './test-helpers/test29-controls.ts'
import { TEST29_ROOT, test29RestartFixture, test29CompactionFixture, test29DiagnosticFixture, test29WatchdogFixture, test29DiagnosticExpectedItem } from './test-helpers/test29-queue.ts'
import { percentile } from './integration/fixtures/transcript-receipts.ts'
import { SR8_DISPATCH_ALLOWANCE_MS, SR8_ACK_LIMIT_MS, SR8_STORE_LIMIT_MS, ackVerdict, storeVerdict, postHoldVerdict,
  n4Verdict, n2Verdict, n2Samples, sealVerdict, requireSeedPopulation, startupVerdict, compactionVerdict, storeWindow, faultWindow, faultRewriters, joinsVerdict,
  windowsVerdict, turnEndVerdict, resultLine, summary, evidenceExit, printResults, type Measurement, type Times, type Result,
  SR8_PENDING_POST_MS, SR8_LARGE_BYTES, SR8_SHARED_CHANNELS, pendingPostVerdicts, sharedListVerdicts,
  scanDiagnostics, membershipFaultVerdicts, membershipFaultRows, cpuThrottle, cpuConditionFields, membershipRepairVerdict, membershipLateVerdict, zeroAckVerdict,
  accountingVerdicts, personaStoreVerdicts, lookupFaultVerdicts, orderedWriteVerdicts, membershipWriteVerdicts,
  faultLoadVerdicts, faultWaves, faultTail, faultTailOption, SR8_FAULT_TAIL_ITEMS, postHoldOverlapVerdicts, concurrentOverlapVerdicts, envelopeTimings, type FaultPlan, type FaultPush, type FaultLoadEvidence,
  type SharedListEvidence, type PendingProbe, type AccountedEvent, type LookupProbe,
  burstAckVerdicts, pendingBurstVerdict, type BurstItem, type PendingWindow,
  SR8_DIAGNOSTIC_KINDS, SR8_USER_HZ, cgroupCpuCounters, procCpuTicks, phasePids, phaseCpuSample, phaseCpuResults, ackClockSamples, ackClockResults,
  ackBinResults, ackEventResults, serverWaves, serverPhase, appendResults, saveResults, observeResults, membershipAckDiagnostics, membershipAppendDiagnostics, type PhaseCpuSample, type ClockSample,
  SR8_SERVER_CPUS, SR8_CONTAINER_HEADROOM_CPUS, SR8_GUARDED_CGROUP_FILES, cgroupPathOf, cgroupChain, cpuMaxCpus, driverCpuVerdict, guardedCgroups, cgroupWriteAccess, cgroupOpenFailure,
  type CgroupWriteAccess, type CgroupOpenOutcome,
} from './integration/fixtures/sr8-evidence.ts'
import { CPUS_PER_SHARD, DRIVER_CPUS } from '../scripts/ci-run.ts'
import { serializeTestMeasurement, ackTimingMeasurement, durableAppendMeasurement, threadSaveMeasurement, threadCompactionMeasurement,
  type TestMeasurement, type TestMeasurementRecord } from '../src/test-measurements.ts'
import { QUEUE_COMPACT_INTERVAL_MS, type AcceptedRecord } from '../src/delivery-queue.ts'
import { THREAD_REPLY_HOLD_MS, DELIVERY_MAX_AD_CALLS_PER_S } from '../src/delivery-constants.ts'
import { NAME_LOOKUP_TIMEOUT_MS } from '../src/tag-wrapper.ts'
import { buildThreadMemoryChangedWhileStoppedLine } from '../src/thread-memory-reports.ts'
import { THREAD_MEMORY_CHANGED_WHILE_STOPPED, THREAD_MEMORY_JOINS_LOST, UNCLAIMED_CHANNEL, fungibleUnclaimedChannelCause, formatPersonaDiagnostic } from '../src/persona-diagnostics.ts'
import { MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_ATTEMPT_TIMEOUT_MS, MEMBERSHIP_RETRY_MAX_MS, MEMBERSHIP_PAGE_LIMIT, membershipRetryDelay } from '../src/channel-membership-retry.ts'
import { startSlackStub, type StubAnswers } from './integration/fixtures/slack-stub-server.ts'
import { WebClient } from '@slack/web-api'
import { longLivedWebClientOptions, PERSONA_WEB_API_REQUEST_TIMEOUT_MS } from '../src/persona-slack-clients.ts'
import { judgeOwnPostLookup } from '../src/own-post-lookup.ts'
import { outputDuringAsync } from './test-helpers/slack-logger-probes.ts'
import { MEMBERSHIP_INVENTORY_INCOMPLETE, MEMBERSHIP_INVENTORY_COMPLETE, membershipScanDiagnostic } from '../src/channel-membership-scan.ts'
import { MEMBERSHIP_STORAGE_FAILED, membershipDiagnostic } from '../src/channel-membership.ts'
import { burstSpec, sr8Personas, sr8Combinations, SR8_BURST_JOINS, SR8_BURST_REPLIES, SR8_BURST_DROPPED, readThreads, threadJoin, joinRecord } from './test-helpers/thread-memory.ts'
import { makeQueue, slackInput, heldSlackInput, postHold, queuePath, readQueue } from './test-helpers/delivery-queue.ts'
import { makeRoutingHarness, observedMembership, resetRoutingState, NEVER_FIRE_RESTART_DELAY_S, type RoutingHarness } from './test-helpers/persona-routing-harness.ts'

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
/** A measurement line exactly as the server's recorder serializes it. */
const serverLine = (entry: TestMeasurement, at: number) => serializeTestMeasurement({ ...entry, v: 1, at_mono_ms: at } as TestMeasurementRecord)
/** A completed Thread Memory compaction as the server writes it; `at_mono_ms` is its end. */
const compactionLine = (key: string, startMonoMs: number, endMonoMs: number, outcome: 'rewritten' | 'skipped') =>
  serverLine(threadCompactionMeasurement({ key, startMonoMs, endMonoMs, outcome }), endMonoMs)
/** That line as the verdicts read it back. */
const compactionRow = (key: string, startMonoMs: number, endMonoMs: number, outcome: 'rewritten' | 'skipped'): Measurement =>
  JSON.parse(compactionLine(key, startMonoMs, endMonoMs, outcome))
const serverRows = {
  ack: serverLine(ackTimingMeasurement({ keys: ['alpha'], ts: '1700000000.000001', targets: [{ key: 'alpha', seq: 1 }], outcome: 'acked', receiveToAckMs: 4, ackCallMs: 1, atMonoMs: 9 }), 9),
  append: serverLine(durableAppendMeasurement({ dir: '/s/queue', path: '/s/queue/alpha.jsonl', records: 2, bytes: 10, appendMs: 3,
    fileFsyncMs: 2, dirFsyncMs: 1, fsyncs: 2, atMonoMs: 9 }, '/s')!, 9),
  save: serverLine(threadSaveMeasurement({ key: 'alpha', records: 1, joins: 1, intents: 0, outcomes: 0 }), 9),
  compaction: compactionLine('alpha', 3, 9, 'rewritten'),
}
/** A full SR-8.2 burst ledger and stub record, in burst's order, with the
 * pending-post probes leading the second wave. Stub seqs start after mark 10. */
function pendingBurst(keys: string[], channel: string, probes: { channel: string; ts: string; envelope_id: string }[]) {
  const items: BurstItem[] = keys.flatMap(key => ([['roots', SR8_BURST_JOINS], ['replies', SR8_BURST_REPLIES], ['dropped', SR8_BURST_DROPPED]] as const)
    .flatMap(([phase, count]) => Array.from({ length: count }, (_, n) => ({ key, phase, channel, ts: `${phase}.${n}`, sender: 'UHUMAN', envelope_id: `${key}-${phase}-${n}` }))))
  const roots = items.filter(i => i.phase === 'roots'), later = items.filter(i => i.phase !== 'roots')
  const led = probes.map(p => ({ key: keys[0], phase: 'probes', channel: p.channel, ts: p.ts, sender: 'UHUMAN', envelope_id: p.envelope_id }))
  const stub: { seq: number; event: string; envelope_id: string }[] = []
  const add = (event: string, rows: { envelope_id?: string }[]) => { for (const r of rows) stub.push({ seq: stub.length + 11, event, envelope_id: r.envelope_id! }) }
  add('push', roots); add('ws-message', roots); add('push', led); add('push', later); add('ws-message', led); add('ws-message', later)
  return { ledger: [...roots, ...led, ...later], stub, end: stub.length + 10 }
}
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
  test.each([0, 1].flatMap(index => ['valid', 'missing-first', 'missing-middle', 'missing-last', 'non-string'].map(variant => [index, variant] as const)))
  ('test-44 envelope lookup %i validates every row: %s', (index, variant) => {
    const lookups = source('test-44-fmk-thread-burst.sh').split('\n').filter(line => line.includes('> "${RESULTS}/envelopes"'))
    expect(lookups).toHaveLength(2)
    const rows: Record<string, unknown>[] = ['first', 'middle', 'last'].map(envelope_id => ({ envelope_id }))
    if (variant.startsWith('missing-')) delete rows[['first', 'middle', 'last'].indexOf(variant.slice('missing-'.length))].envelope_id
    if (variant === 'non-string') rows[1].envelope_id = 123
    const result = shell([
      'RESULTS="$HOME"', 'fail() { printf "FAIL %s\\n" "$*"; exit 1; }', lookups[index], 'cat "$RESULTS/envelopes"',
    ].join('\n'), { 'burst.jsonl': jsonl(rows) })
    expect(result.status).toBe(variant === 'valid' ? 0 : 1)
    if (variant === 'valid') expect(result.stdout).toBe('first\nmiddle\nlast\n')
    else expect(result.stdout).toContain('FAIL burst push has no string envelope_id\n')
  })
  test.each([
    ['lib/membership-load.sh', 'shared_persona_facts "${P}" >>'],
    ['test-44-fmk-thread-burst.sh', 'shared_persona_facts "${key}" >>'],
    ['lib/shared-channel-recovery.sh', 'shared_delivery_expectation "${KEY[${who}]}" "${NAME[${who}]}" slack'],
    ['lib/shared-channel-recovery.sh', 'shared_delivery_expectation "${KEY[${who}]}" "${NAME[${who}]}" "${source}"'],
    ['test-47-shared-channel-upgrade.sh', 'shared_assert_content "${key}" "${LOG}"'],
  ].flatMap(([file, prefix]) => ['bytes', 'silent-failure'].map(mode => [file, prefix, mode])))
  ('printer append in %s (%s): %s', (file, prefix, mode) => {
    // Execute each swept command verbatim; only its reader is synthetic.
    const text = source(file).replaceAll('\\\n', '')
    const command = text.split('\n').find(line => line.includes(prefix.replace(' >>', '')) && line.includes('>>'))
    expect(command).toBeDefined()
    const result = shell([
      declaration(scenario, 'fail'), 'TEST_NAME=reader-control',
      'P=alpha; key=alpha; who=p; source=cron; sender=sender; ts=1; channel=C; HUMAN=U; via=-; LOG=-; text=-; parts=-',
      'declare -A KEY=([p]=alpha) NAME=([p]=alpha) SNAP=([alpha]=snapshot)',
      'EXPECTED="$HOME/out"; EVIDENCE="$HOME"; phase=out; set -- "$HOME/out"',
      'shared_persona_facts() { bun "$HOME/printer.ts"; }',
      'shared_delivery_expectation() { bun "$HOME/printer.ts"; }',
      'shared_assert_content() { bun "$HOME/printer.ts"; }',
      // Point every real command at the same seeded output.
      'printf "prior\\n" > "$HOME/out"',
      command!.replaceAll('${EVIDENCE}/${phase}.facts.jsonl', '${HOME}/out').replaceAll('${EVIDENCE}/${key}-old-content.jsonl', '${HOME}/out'),
      'cat "$HOME/out"',
    ].join('\n'), { 'printer.ts': mode === 'silent-failure' ? 'process.exit(1)\n' : 'await Bun.write(Bun.stdout, "next".repeat(5000) + "\\n")\n' })
    if (mode === 'silent-failure') {
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/^FAIL: reader-control: .+\n$/)
      expect(result.stdout).toBe('')
    } else {
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
      expect(result.stdout).toBe('prior\n' + 'next'.repeat(5000) + '\n')
    }
  })
  test.each([
    ['late_state', 'facts-p'], ['late_state', 'order'], ['late_state', 'joins'], ['write_states', 'facts-q'],
  ])('%s emits FAIL when its %s reader exits silently', (name, reader) => {
    const load = source('lib/membership-load.sh')
    const result = shell([
      declaration(scenario, 'fail'), 'TEST_NAME=reader-control',
      declaration(load, 'read_jsonl'), declaration(load, name), 'P=p; Q=q',
      'shared_persona_facts() { bun "$HOME/reader.ts" "facts-$1"; }',
      'shared_attempt_order() { bun "$HOME/reader.ts" order; }',
      'shared_thread_joins() { bun "$HOME/reader.ts" joins; }',
      `${name} "$HOME/state"`, 'echo continued',
    ].join('\n'), { 'reader.ts': `if (process.argv[2] === ${JSON.stringify(reader)}) process.exit(1)\nprocess.stdout.write('{"saved":true}')\n` })
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('FAIL: reader-control: evidence reader failed\n')
    expect(result.stdout).toBe('')
  })
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
    ['switch-off', 'kept', ''], ['open', 'kept', ''],
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

  test.each([
    ['20', 'first', true], ['20', 'last', false],
    ['100', 'first', true], ['100', 'last', false],
  ] as const)('measures only the last %s of n+1 timings: one extra slow %s timing', (count, slow, passes) => {
    const n = Number(count), fast = { typing_ms: 40, delivery_ms: 1600 }, late = { typing_ms: 3000, delivery_ms: 1600 }
    // One slow timing cannot move a nearest-rank p95, so n/20 in-window slow
    // timings hold p95 at its edge: the extra one fails only inside the window.
    const extra = slow === 'first' ? 0 : n
    const timings = Array.from({ length: n + 1 }, (_, i) => i === extra || (i >= 5 && i < 5 + n / 20) ? late : fast)
    const check = new Function('result', 'count', 'percentile', 'console', block(source('fixtures/transcript-receipts.ts'), '        const n = Number(count)', '\n      }'))
    const recorded: string[] = []
    const run = () => check({ timings }, count, percentile, { log: (line: string) => recorded.push(line) })
    if (passes) expect(run).not.toThrow()
    else expect(run).toThrow('latency exceeded')
    expect(recorded).toEqual([`recorded: p95 typing_start_ms=${passes ? 40 : 3000} delivery_ms=1600 samples=${n}`])
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
  // Decision 29 ruling: stub order 10 mark | 11 root push | 12 root ACK | 13-15 probe
  // pushes | 16 reply, 17 drop push | 18-20 probe ACKs | 21-22 burst ACKs | 30 mark.
  function window() {
    const p = pending()
    const items: BurstItem[] = [...[['roots', 'r'], ['replies', 'q'], ['dropped', 'd']].map(([phase, id]) => ({ key, phase, channel, ts: id, sender: 'U', envelope_id: id })),
      ...p.probes.map(probe => ({ key, phase: 'probes', channel: probe.channel, ts: probe.ts, sender: 'U', envelope_id: probe.envelope_id }))]
    const order: [string, string][] = [['push', 'r'], ['ws-message', 'r'], ...p.probes.map(probe => ['push', probe.envelope_id] as [string, string]),
      ['push', 'q'], ['push', 'd'], ...p.probes.map(probe => ['ws-message', probe.envelope_id] as [string, string]), ['ws-message', 'q'], ['ws-message', 'd']]
    const stub = order.map(([event, envelope_id], i) => ({ seq: 11 + i, event, envelope_id }))
    const w: PendingWindow = { startSeq: 10, endSeq: 30, compactMs: QUEUE_COMPACT_INTERVAL_MS, startMs: 5, endMs: 5 + QUEUE_COMPACT_INTERVAL_MS - 1, before: '64768:12\n', after: '64768:12\n' }
    return { probes: p.probes, items, stub, w, run() { return pendingBurstVerdict(this.items, this.stub, this.probes, this.w) } }
  }
  test('pending post and probes inside the burst, below the production interval, pass and record it', () => {
    const r = window().run()
    expect(r.verdict).toBe('pass')
    expect(r.stats).toEqual({ compact_interval_ms: QUEUE_COMPACT_INTERVAL_MS, window_ms: QUEUE_COMPACT_INTERVAL_MS - 1, probes_inside: 3, burst_in_pending: 'yes', same_journal: 'yes' })
    output([r], 0)
  })
  test('an end mark equal to the last burst ACK still contains the burst', () => {
    const v = window(); v.w.endSeq = 22
    expect(v.run().verdict).toBe('pass')
  })
  test.each(['journal-replaced', 'window-at-interval'] as const)('pending burst fails when %s', defect => {
    const v = window()
    if (defect === 'journal-replaced') v.w.after = '64768:13\n'
    if (defect === 'window-at-interval') v.w.endMs++
    expect(v.run().verdict).toBe('fail'); output([v.run()], 1)
  })
  test.each(['probe-before-burst', 'probe-after-burst', 'probe-at-last-ack', 'burst-before-mark', 'ack-after-mark', 'unledgered-probe', 'burst-ack',
    'journal', 'before-journal', 'malformed-journal', 'stub', 'interval', 'start'] as const)('pending burst missing %s never passes', defect => {
    const v = window()
    if (defect === 'probe-before-burst') v.stub[2].seq = 11
    if (defect === 'probe-after-burst') v.stub[4].seq = 23
    // Only the tie moves: the third probe push takes the last burst ACK's seq.
    if (defect === 'probe-at-last-ack') v.stub[4].seq = 22
    if (defect === 'before-journal') v.w.before = undefined
    if (defect === 'malformed-journal') v.w.before = 'x'
    if (defect === 'burst-before-mark') v.w.startSeq = 11
    if (defect === 'ack-after-mark') v.w.endSeq = 21
    if (defect === 'unledgered-probe') v.items = v.items.filter(i => i.phase !== 'probes' || i.envelope_id !== v.probes[0].envelope_id)
    if (defect === 'burst-ack') v.stub = v.stub.filter(r => !(r.event === 'ws-message' && r.envelope_id === 'q'))
    if (defect === 'journal') v.w.after = undefined
    if (defect === 'stub') v.stub = undefined as never
    if (defect === 'interval') v.w.compactMs = NaN
    if (defect === 'start') v.w.startMs = NaN
    expect(v.run().verdict).toBe('missing'); output([v.run()], 1)
  })
  test('burst ACK verdicts keep check counts, N1 and stored-drop rules, and ignore probes', () => {
    const counts = { roots: 1, replies: 1, dropped: 1 }
    const items: BurstItem[] = ['roots', 'replies', 'dropped', 'probes'].map(phase => ({ key, phase, channel, ts: phase, sender: 'U', envelope_id: phase }))
    const times = () => items.map(i => timing(i.envelope_id!, i.phase === 'probes' ? SR8_ACK_LIMIT_MS + 1 : SR8_ACK_LIMIT_MS))
    const run = (rows = items, t = times(), queues: Record<string, any[] | undefined> = { [key]: [] }) => burstAckVerdicts([key], rows, t, queues, counts)
    expect(run().map(r => [r.measure, r.samples, r.verdict])).toEqual([['ack-accepted', 2, 'pass'], ['ack-dropped', 1, 'pass']])
    expect(run(items.filter(i => i.phase !== 'replies'))[0].verdict).toBe('missing')
    expect(burstAckVerdicts([key], undefined, times(), { [key]: [] }, counts).map(r => r.verdict)).toEqual(['missing', 'missing'])
    expect(run(items, times(), { [key]: [{ kind: 'accepted', channel, ts: 'dropped', seq: 9 }] })[1].verdict).toBe('fail')
    const slow = times(); slow[0].acks[0].ack_mono_ms++
    expect(run(items, slow)[0].verdict).toBe('fail')
    const slowDrop = times(); slowDrop[2].acks[0].ack_mono_ms++
    expect(run(items, slowDrop).map(r => r.verdict)).toEqual(['pass', 'fail'])
    expect(run(items.filter(i => i.phase !== 'dropped')).map(r => r.verdict)).toEqual(['pass', 'missing'])
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
    if (kind !== 'hang') faults.push(...[0, 1].map(i => ({ event: 'api', request_id: `request-${i}`, ts: iso(clock + i * gap), cursor: page === 'later' ? 'later' : '',
      answer, status: kind === 'rate' ? 429 : 200 })))
    else faults.push(...[0, 1].map(i => ({ seq: i * 2 + 2, event: 'fault-settled', request_id: `request-${i}`, resolution: 'abort', ts: iso(clock + i * gap + duration) })))
    const log = [0, 1].map(i => scanLine(clock + i * gap + duration, false, page === 'later' ? 1 : 0, problem,
      kind === 'rate' ? after : undefined, clock + i * gap + MEMBERSHIP_ATTEMPT_TIMEOUT_MS)).join('\n')
    return { kind, page, faults, log, before: '{"assignment":"kept"}', after: '{"assignment":"kept"}', retryAfter: after, wait,
      run() { return membershipFaultVerdicts(this.kind, this.page, key, this.faults, diag(this.log), this.before, this.after, this.retryAfter, this.wait, MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_ATTEMPT_TIMEOUT_MS) } }
  }
  test.each(['hang', 'transient', 'scope', 'denied', 'rate'])('membership %s first and later page published outcomes', kind => {
    for (const page of ['first', 'later']) { const f = member(kind, page); output(f.run(), 0) }
  })
  // The split strict/open later-denied runs: each refusal resets the scan
  // (pages=0) and republishes reason=none before the next attempt.
  function reset(kind: string) {
    const f = member(kind, 'later')
    const [first, second] = f.log.replace(/ pages=1 positives=1 /g, ' pages=0 positives=0 ').split('\n')
    const idle = `[${iso(f.faults[1].arrival_epoch_ms - 1)}] ${membershipScanDiagnostic(key, { state: 'unverified', pages: 0, positives: 0 })}`
    f.log = [first, idle, second].join('\n')
    return f
  }
  test('membership denied later page passes the credentials-refusal reset: pages=0 reason=authentication slack=invalid_auth', () => {
    const f = reset('denied')
    expect(f.log).toContain('pages=0 positives=0 reason=authentication slack_error=invalid_auth')
    expect(f.run().map(r => r.verdict)).toEqual(['pass', 'pass'])
    expect(f.run()[0].stats).toMatchObject({ case: 'denied', page: 'later', fired: 2, incomplete: 2 }); output(f.run(), 0)
  })
  test.each(['other-reason', 'no-slack-error', 'other-slack-error', 'first-page-cursor', 'one-first-page-cursor', 'before-its-fault', 'no-diagnostic'] as const)
  ('membership denied later page reset does not pass with %s', defect => {
    const f = reset('denied')
    const api = f.faults.filter(r => r.event === 'api')
    if (defect === 'other-reason') f.log = f.log.replaceAll('reason=authentication slack_error=invalid_auth', 'reason=storage')
    if (defect === 'no-slack-error') f.log = f.log.replaceAll(' slack_error=invalid_auth', '')
    if (defect === 'other-slack-error') f.log = f.log.replaceAll('slack_error=invalid_auth', 'slack_error=missing_scope')
    // The faulted requests asked for the first page, so pages=0 proves nothing about a later one.
    if (defect === 'first-page-cursor') for (const r of api) r.cursor = ''
    if (defect === 'one-first-page-cursor') api[1].cursor = ''
    // Diagnostic 0 is published before fault 0, so membership-retry's correlation rejects it.
    if (defect === 'before-its-fault') f.log = [0, 1].map(i => scanLine(clock - 1 + i * f.wait, false, 0, 'authentication')).join('\n')
    if (defect === 'no-diagnostic') f.log = f.log.split('\n').filter(l => l.includes('reason=none')).join('\n')
    const rows = f.run(), verdicts = rows.map(r => r.verdict)
    if (defect === 'before-its-fault') {
      expect(verdicts).toEqual(['pass', 'fail'])
      expect(rows[1].stats.min_ms).toBeDefined()
    } else if (defect === 'no-diagnostic') expect(verdicts).toEqual(['missing', 'missing'])
    else expect(verdicts).toEqual(['fail', 'missing'])
    output(rows, 1)
  })
  test.each(['hang', 'transient', 'scope', 'rate'])('membership %s later page with pages=0 still fails', kind => {
    const f = reset(kind)
    expect(f.log).toContain('pages=0 positives=0')
    expect(f.run()[0]).toMatchObject({ verdict: 'fail', stats: { page: 'later', incomplete: 0 } }); output(f.run(), 1)
  })
  test('membership denied first page still requires pages=0', () => {
    const f = member('denied', 'first')
    f.log = f.log.replace(/ pages=0 positives=0 /g, ' pages=1 positives=1 ')
    expect(f.run()[0]).toMatchObject({ verdict: 'fail', stats: { page: 'first', incomplete: 0 } }); output(f.run(), 1)
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
  test.each(['first', 'later'])('membership measured deadlines on %s pages, at the dispatch allowance and the 900000 ms regression', page => {
    const T = MEMBERSHIP_REQUEST_TIMEOUT_MS, allowed = T + SR8_DISPATCH_ALLOWANCE_MS
    for (const elapsed of [T - 1, T, T + 1, allowed, allowed + 1, 900_000]) {
      const f = member('hang', page), gap = elapsed + f.wait
      for (const [i, r] of f.faults.slice(0, 2).entries()) {
        r.arrival_epoch_ms = clock + i * gap; r.arrival_mono_ms = 100 + i * gap; r.ts = iso(clock + i * gap)
        f.faults[i + 2].ts = iso(clock + i * gap + elapsed)
      }
      f.log = [0, 1].map(i => scanLine(clock + i * gap + elapsed, false, page === 'first' ? 0 : 1,
        'deadline', undefined, clock + i * gap + MEMBERSHIP_ATTEMPT_TIMEOUT_MS)).join('\n')
      expect(f.run().map(r => r.verdict)).toEqual(elapsed > allowed ? ['fail', 'fail'] : ['pass', 'pass'])
      expect(f.run()[0].stats).toMatchObject({ max_request_ms: elapsed, excess_ms: elapsed - T, allowance_ms: SR8_DISPATCH_ALLOWANCE_MS })
      output(f.run(), elapsed > allowed ? 1 : 0)
    }
  })
  test('membership hang correlates expiries only: idle-request republications pass, an expiry without deadline_at is missing', () => {
    const f = member('hang')
    const republished = (i: number) => {
      const at = clock + i * (MEMBERSHIP_REQUEST_TIMEOUT_MS + f.wait) + MEMBERSHIP_REQUEST_TIMEOUT_MS
      return `[${iso(at + 1)}] ${membershipScanDiagnostic(key, { state: 'incomplete', pages: 0, positives: 0, problem: 'deadline',
        deadline: undefined, nextAttemptAt: at + f.wait })}`
    }
    const [first, second] = f.log.split('\n')
    f.log = [first, republished(0), second, republished(1)].join('\n')
    expect(f.run().map(r => r.verdict)).toEqual(['pass', 'pass']); output(f.run(), 0)
    f.log = f.log.replace(/ deadline_at=\d+/, '')
    expect(f.run()[0].verdict).toBe('missing'); output(f.run(), 1)
  })
  test('membership hang lines print signed excess and allowance; other cases and absent durations do not invent one', () => {
    const lines = (results: Result[]) => { const logs: string[] = []; printResults(c, results, l => logs.push(l)); return logs }
    const hang = lines(member('hang').run())
    expect(hang[0]).toContain(`excess_ms=0 allowance_ms=${SR8_DISPATCH_ALLOWANCE_MS}`)
    const early = member('hang')
    for (const i of [0, 1]) {
      early.faults[i + 2].ts = iso(clock + i * (MEMBERSHIP_REQUEST_TIMEOUT_MS + early.wait) + MEMBERSHIP_REQUEST_TIMEOUT_MS - 5)
    }
    early.log = [0, 1].map(i => scanLine(clock + i * (MEMBERSHIP_REQUEST_TIMEOUT_MS + early.wait) + MEMBERSHIP_REQUEST_TIMEOUT_MS - 5, false, 0,
      'deadline', undefined, clock + i * (MEMBERSHIP_REQUEST_TIMEOUT_MS + early.wait) + MEMBERSHIP_ATTEMPT_TIMEOUT_MS)).join('\n')
    expect(early.run()[0].stats.excess_ms).toBe(-5)
    const absent = member('hang'); absent.faults.pop(); absent.faults.pop()
    expect(absent.run()[0]).toMatchObject({ verdict: 'missing', stats: { excess_ms: 'missing', allowance_ms: SR8_DISPATCH_ALLOWANCE_MS } })
    expect(lines(member('transient').run())[0]).not.toContain('excess_ms')
  })
  test('membership-fault correlation rows join by fault ordinal and print no text, request ID or token', () => {
    const f = member('hang')
    f.faults.push({ event: 'fault', method: 'users.conversations', label: 'other', request_id: 'foreign', seq: 99, text: token })
    const rows = membershipFaultRows('hang', key, f.faults, diag(f.log))
    expect(rows.filter(r => r.includes('source=fault '))).toEqual([0, 1].map(i =>
      `recorded: sr8 membership-fault-row case=hang source=fault fault=${i} seq=${i * 2 + 1} outcome=hang arrival_epoch_ms=${f.faults[i].arrival_epoch_ms} arrival_mono_ms=${f.faults[i].arrival_mono_ms}`))
    expect(rows.filter(r => r.includes('source=fault-settled'))).toEqual([0, 1].map(i =>
      `recorded: sr8 membership-fault-row case=hang source=fault-settled fault=${i} seq=${i * 2 + 2} resolution=abort ts_epoch_ms=${Date.parse(f.faults[i + 2].ts)}`))
    expect(rows.filter(r => r.includes('source=scan'))).toHaveLength(2)
    expect(rows.find(r => r.includes('scan=0'))).toContain('complete=false pages=0 reason=deadline slack=absent')
    for (const row of rows) { expect(row).not.toContain('request-'); expect(row).not.toContain('foreign'); assertNoLeak(row) }
    const rate = member('rate'), answered = membershipFaultRows('rate', key, rate.faults, diag(rate.log))
    expect(answered.filter(r => r.includes('source=api'))).toEqual([0, 1].map(i => expect.stringContaining(`source=api fault=${i} status=429 answer=ratelimited`)))
    const hostile = member('transient')
    hostile.faults[0].outcome = token; hostile.faults[2].answer = 'Bearer secret'; hostile.faults[0].seq = 'x'
    const scrubbed = membershipFaultRows('transient', key, hostile.faults, undefined)
    expect(scrubbed[0]).toContain('seq=invalid outcome=invalid')
    expect(scrubbed.find(r => r.includes('source=api fault=0'))).toContain('answer=invalid')
    expect(scrubbed.at(-1)).toBe('recorded: sr8 membership-fault-row case=transient source=scan rows=unavailable')
    for (const row of scrubbed) assertNoLeak(row)
    expect(membershipFaultRows('hang', key, undefined, [])).toEqual(['recorded: sr8 membership-fault-row case=hang source=stub rows=unavailable'])
  })
  test('cgroup CPU conditions print quota/period and throttling deltas, unknown when unreadable', () => {
    const v2 = (periods: number, throttled: number, usec: number) => `usage_usec 9\nnr_periods ${periods}\nnr_throttled ${throttled}\nthrottled_usec ${usec}\n`
    expect(cpuThrottle(v2(10, 2, 300))).toEqual({ periods: 10, throttled: 2, throttledUsec: 300 })
    expect(cpuThrottle('nr_periods 4\nnr_throttled 1\nthrottled_time 2500000\n')).toEqual({ periods: 4, throttled: 1, throttledUsec: 2500 })
    expect(cpuThrottle(undefined)).toBeUndefined(); expect(cpuThrottle('')).toBeUndefined()
    expect(cpuConditionFields('200000 100000\n', v2(10, 2, 300), v2(25, 7, 1300)))
      .toBe('cpu_max=200000/100000 nr_periods_delta=15 nr_throttled_delta=5 throttled_usec_delta=1000')
    expect(cpuConditionFields('max 100000', v2(1, 0, 0), v2(1, 0, 0))).toBe('cpu_max=max/100000 nr_periods_delta=0 nr_throttled_delta=0 throttled_usec_delta=0')
    expect(cpuConditionFields(undefined, '', v2(1, 0, 0))).toBe('cpu_max=unknown nr_periods_delta=unknown nr_throttled_delta=unknown throttled_usec_delta=unknown')
    expect(cpuConditionFields('garbage', v2(5, 5, 5), v2(1, 1, 1))).toBe('cpu_max=unknown nr_periods_delta=unknown nr_throttled_delta=unknown throttled_usec_delta=unknown')
  })
  describe('driver-cpu: the burst driver off the server\'s CPU quota', () => {
    const files = (entries: Record<string, string>) => (path: string, file: string) => entries[`${path === '/' ? '' : path}/${file}`]
    const stat = (usec: number) => `usage_usec ${usec}\nuser_usec 1\nsystem_usec 1\nnr_periods 1\nnr_throttled 0\nthrottled_usec 0\n`
    // Before: one 2-CPU container quota holds the server, the stub and the driver.
    const shared = { '/cpu.max': '200000 100000\n', '/cpu.stat': stat(7_806_000) }
    // Five CPUs: server 2, driver 0.9, harness 1, headroom 1.1.
    const split = { '/cpu.max': '500000 100000\n', '/cpu.stat': stat(9_000_000), '/shard/cpu.max': 'max 100000\n',
      '/shard/server/cpu.max': '200000 100000\n', '/shard/server/cpu.stat': stat(5_000_000),
      '/shard/driver/cpu.max': '90000 100000\n', '/shard/driver/cpu.stat': stat(1_860_000) }
    // The server's UID could open none of the guarded files it checked for writing.
    const contained = { checked: 34, writable: 0, unknown: 0 }
    test('today\'s shard, one quota for the server and the driver, is missing; the split shard passes', () => {
      expect(driverCpuVerdict('/', ['/'], files(shared), { checked: 10, writable: 0, unknown: 0 })).toEqual({ measure: 'driver-cpu', samples: 1, stats: { server_cgroup: '/', server_cpu_max: '200000/100000',
        server_cpus: 2, server_usage_ms: 7806, driver_cgroup: '/', driver_cpu_max: '200000/100000', driver_cpus: 2, driver_usage_ms: 7806, shared_cpus: 2,
        guarded_files: 10, writable_files: 0, unprobed_files: 0 }, limit: 2, verdict: 'missing' })
      expect(driverCpuVerdict('/shard/server', ['/shard/driver', '/shard/driver'], files(split), contained)).toEqual({ measure: 'driver-cpu', samples: 2, stats: {
        server_cgroup: '/shard/server', server_cpu_max: '200000/100000', server_cpus: 2, server_usage_ms: 5000, driver_cgroup: '/shard/driver',
        driver_cpu_max: '90000/100000', driver_cpus: 0.9, driver_usage_ms: 1860, shared_cpus: 5, guarded_files: 34, writable_files: 0, unprobed_files: 0 }, limit: 2, verdict: 'pass' })
      expect(SR8_SERVER_CPUS).toBe(CPUS_PER_SHARD)
    })
    // Injected probe outcomes: the tally the real write-only probe feeds, whoever runs the suite.
    test('every present guarded file counts; an opened file is writable and an unexpected probe error is unknown', () => {
      const paths = guardedCgroups('/shard/server', ['/shard/driver'])
      const outcome = (bad: Record<string, CgroupOpenOutcome>) => (path: string, file: string) => bad[`${path} ${file}`] ?? (file === 'memory.max' && path !== '/' ? 'absent' : 'refused')
      const present = paths.length * SR8_GUARDED_CGROUP_FILES.length - (paths.length - 1)
      expect(cgroupWriteAccess(paths, outcome({}))).toEqual({ checked: present, writable: 0, unknown: 0 })
      // A write-only migration file the server's UID may write: R2.2's escape.
      expect(cgroupWriteAccess(paths, outcome({ '/shard cgroup.procs': 'writable' }))).toEqual({ checked: present, writable: 1, unknown: 0 })
      expect(cgroupWriteAccess(paths, outcome({ '/shard/driver cpu.max': 'error' }))).toEqual({ checked: present, writable: 0, unknown: 1 })
      expect(cgroupWriteAccess(paths, () => 'absent')).toEqual({ checked: 0, writable: 0, unknown: 0 })
      expect([undefined, 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EMFILE', 'EISDIR', 'ELOOP', 'ENXIO'].map(code => cgroupOpenFailure(code)))
        .toEqual(['error', 'refused', 'refused', 'refused', 'absent', 'error', 'error', 'error', 'error'])
    })
    test.each<[string, string | undefined, (string | undefined)[] | undefined, Record<string, string>, CgroupWriteAccess | undefined]>([
      ['one driver run in the server\'s group', '/shard/server', ['/shard/driver', '/shard/server'], split, contained],
      ['a driver beside the server under a container quota with no room for it', '/shard/server', ['/shard/driver'], { ...split, '/cpu.max': '200000 100000\n' }, contained],
      ['a container with 0.1 CPU of headroom (b.9p6)', '/shard/server', ['/shard/driver'], { ...split, '/cpu.max': '300000 100000\n' }, contained],
      ['an uncapped driver', '/shard/server', ['/shard/driver'], { ...split, '/shard/driver/cpu.max': 'max 100000\n' }, contained],
      ['a server quota other than the shard\'s', '/shard/server', ['/shard/driver'], { ...split, '/shard/server/cpu.max': '250000 100000\n' }, contained],
      ['an unreadable cpu.max on the path', '/shard/server', ['/shard/driver'], Object.fromEntries(Object.entries(split).filter(([path]) => path !== '/shard/cpu.max')), contained],
      ['an unreadable server cgroup', undefined, ['/shard/driver'], split, contained],
      ['a malformed record line', '/shard/server', [undefined], split, contained],
      ['no recorded driver run', '/shard/server', [], split, contained],
      ['no record', '/shard/server', undefined, split, contained],
      // The server's UID could move a process (for example into shard or shard/driver) or change a limit.
      ['one guarded file the server\'s UID can write', '/shard/server', ['/shard/driver'], split, { checked: 34, writable: 1, unknown: 0 }],
      ['one guarded file it could not probe', '/shard/server', ['/shard/driver'], split, { checked: 34, writable: 0, unknown: 1 }],
      ['no guarded file checked', '/shard/server', ['/shard/driver'], split, { checked: 0, writable: 0, unknown: 0 }],
      ['no permission check', '/shard/server', ['/shard/driver'], split, undefined],
    ])('%s is missing', (_name, server, drivers, entries, access) => {
      const row = driverCpuVerdict(server, drivers, files(entries), access)
      expect(row.verdict).toBe('missing')
      expect(resultLine({ scenario: 'test-56-fmk-membership-load-lookup-strict-lookup', mode: 'strict', population: 100_000, recipients: 2 }, row))
        .toMatch(/^recorded: sr8 driver-cpu scenario=\S+ mode=strict population=100000 recipients=2 samples=\d+ server_cgroup=\S+ server_cpu_max=\S+ server_cpus=\S+ server_usage_ms=\S+ driver_cgroup=\S+ driver_cpu_max=\S+ driver_cpus=\S+ driver_usage_ms=\S+ shared_cpus=\S+ guarded_files=\S+ writable_files=\S+ unprobed_files=\S+ limit=2 verdict=missing$/)
    })
    test('permissions are checked on every cgroup of both paths, once each, root first', () => {
      expect(guardedCgroups('/shard/server', ['/shard/driver', '/shard/driver'])).toEqual(['/', '/shard', '/shard/server', '/shard/driver'])
      expect(guardedCgroups('/', ['/'])).toEqual(['/'])
      expect(guardedCgroups(undefined, undefined)).toEqual([])
      expect(SR8_GUARDED_CGROUP_FILES).toEqual(expect.arrayContaining(['cgroup.procs', 'cgroup.threads', 'cpu.max', 'cpu.max.burst', 'memory.max', 'pids.max']))
    })
    test('cgroup paths, chains and cpu.max values parse strictly', () => {
      expect(cgroupPathOf('0::/shard/server\n')).toBe('/shard/server')
      expect(cgroupPathOf('0::/\n')).toBe('/')
      expect(cgroupPathOf('12:cpu,cpuacct:/x\n0::/a.b/c-d_e\n')).toBe('/a.b/c-d_e')
      for (const text of ['12:cpu,cpuacct:/x\n', '0::/a/../b\n', '0::/a b\n', '0::relative\n', '0::/a//b\n', '', undefined]) expect(cgroupPathOf(text)).toBeUndefined()
      expect(cgroupChain('/shard/server')).toEqual(['/', '/shard', '/shard/server'])
      expect(cgroupChain('/')).toEqual(['/'])
      expect([cpuMaxCpus('200000 100000\n'), cpuMaxCpus('90000 100000'), cpuMaxCpus('max 100000')]).toEqual([2, 0.9, Infinity])
      for (const text of ['200000', '1 0', 'max', '-1 100000', undefined]) expect(cpuMaxCpus(text)).toBeUndefined()
    })
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
    // From the later fault.ts the duration is within the allowance; from arrival it exceeds it by 1 ms.
    const over = MEMBERSHIP_REQUEST_TIMEOUT_MS + SR8_DISPATCH_ALLOWANCE_MS + 1
    const f = member('hang', page)
    f.faults[0].ts = iso(clock + 50)
    f.faults[2].ts = iso(clock + over)
    f.log = scanLine(clock + over, false, page === 'first' ? 0 : 1) + '\n' + f.log.split('\n')[1]
    expect(f.run()[0].verdict).toBe('fail')
    expect(f.run()[0].stats).toMatchObject({ max_request_ms: over, excess_ms: SR8_DISPATCH_ALLOWANCE_MS + 1 })
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
  // The answers25 strict-first-scope shape: a refused page carries no
  // deadline_at, and neither do the repair attempt's republication or its
  // complete line.
  function scope(refusedAt = 1794157684876, next = 1794157704876, clear = 1794157685660, start = 1794157704880, done = 1794157705325) {
    const at = (t: number, status: Parameters<typeof membershipScanDiagnostic>[1]) => `[${iso(t)}] ${membershipScanDiagnostic(key, status)}`
    const lines = [at(refusedAt, { state: 'incomplete', pages: 0, positives: 0, problem: 'access', slackError: 'missing_scope', nextAttemptAt: next }),
      at(start, { state: 'unverified', pages: 0, positives: 0, nextAttemptAt: start }),
      at(done, { state: 'complete', pages: 6, positives: 1100 })]
    const f = { clear, lines, run: (log = lines.join('\n')) => membershipRepairVerdict(f.clear, diag(log), MEMBERSHIP_ATTEMPT_TIMEOUT_MS, MEMBERSHIP_RETRY_MAX_MS) }
    return f
  }
  test('idle repair after an access refusal: the recorded run passes with no remaining deadline and the attempt\'s own scan time', () => {
    const r = scope().run()
    expect(r.stats).toMatchObject({ elapsed_ms: 19665, remaining_ms: 0, retry_ms: MEMBERSHIP_RETRY_MAX_MS, scan_ms: 445 })
    expect(r.limit).toBe(MEMBERSHIP_RETRY_MAX_MS + 445); expect(r.verdict).toBe('pass'); output([r], 0)
  })
  test.each([0, 1])('idle repair after an access refusal at its bound +%d', extra => {
    const clear = clock, start = clear + MEMBERSHIP_RETRY_MAX_MS + extra
    const r = scope(clear - 1, start, clear, start, start + 20).run()
    expect(r.stats).toMatchObject({ remaining_ms: 0, scan_ms: 20 }); expect(r.verdict).toBe(extra ? 'fail' : 'pass'); output([r], extra ? 1 : 0)
  })
  test('idle repair after an access refusal fails a scan beyond its attempt deadline and never passes without completion', () => {
    const f = scope(), slow = scope(undefined, undefined, undefined, undefined, 1794157704880 + MEMBERSHIP_ATTEMPT_TIMEOUT_MS + 1)
    expect(slow.run().verdict).toBe('fail'); output([slow.run()], 1)
    const never = f.run(f.lines.slice(0, 2).join('\n'))
    expect(never.stats.elapsed_ms).toBe('missing'); expect(never.verdict).toBe('missing'); output([never], 1)
  })
  test.each(['no-attempt', 'attempt-before-next', 'attempt-before-clear', 'refusal-without-slack', 'transport-without-deadline', 'hang-complete-without-deadline'] as const)
  ('idle repair stays missing on %s', shape => {
    const f = scope()
    let log = f.lines.join('\n')
    if (shape === 'no-attempt') log = [f.lines[0], f.lines[2]].join('\n')
    if (shape === 'attempt-before-next') log = log.replace(iso(1794157704880), iso(1794157704875))
    if (shape === 'attempt-before-clear') { f.clear = 1794157704881; log = [f.lines[0].replace(iso(1794157684876), iso(1794157704870)), f.lines[1], f.lines[2]].join('\n') }
    if (shape === 'refusal-without-slack') log = log.replace(' slack_error=missing_scope', '')
    if (shape === 'transport-without-deadline') log = log.replace('reason=access slack_error=missing_scope', 'reason=transport slack_error=internal_error')
    if (shape === 'hang-complete-without-deadline') log = [scanLine(f.clear - 1, false, 0, 'deadline', undefined, f.clear + 1000), f.lines[1], f.lines[2]].join('\n')
    const r = f.run(log)
    expect(r.verdict).toBe('missing'); output([r], 1)
  })
  // The denied case publishes the same shape, with its own reason and code.
  const denied = (log: string) => log.replace('reason=access slack_error=missing_scope', 'reason=authentication slack_error=invalid_auth')
  test('idle repair after an authentication refusal: pass, over-bound fail and missing', () => {
    const f = scope(), r = f.run(denied(f.lines.join('\n')))
    expect(r.stats).toMatchObject({ elapsed_ms: 19665, remaining_ms: 0, scan_ms: 445 }); expect(r.verdict).toBe('pass'); output([r], 0)
    for (const extra of [0, 1]) {
      const start = clock + MEMBERSHIP_RETRY_MAX_MS + extra, b = scope(clock - 1, start, clock, start, start + 20)
      const over = b.run(denied(b.lines.join('\n')))
      expect(over.stats).toMatchObject({ remaining_ms: 0, scan_ms: 20 }); expect(over.verdict).toBe(extra ? 'fail' : 'pass'); output([over], extra ? 1 : 0)
    }
    for (const log of [[f.lines[0], f.lines[2]], f.lines.slice(0, 2)].map(l => denied(l.join('\n')))) {
      const missing = f.run(log)
      expect(missing.verdict).toBe('missing'); output([missing], 1)
    }
    const storage = f.run(f.lines.join('\n').replace('reason=access slack_error=missing_scope', 'reason=storage slack_error=missing_scope'))
    expect(storage.verdict).toBe('missing'); output([storage], 1)
  })
  test('idle repair after an access refusal keeps a complete line\'s own deadline_at as its scan start', () => {
    const f = scope(), withDeadline = f.lines[2].replace('reason=none.', `reason=none deadline_at=${1794157704876 + MEMBERSHIP_ATTEMPT_TIMEOUT_MS}.`)
    const r = f.run([f.lines[0], f.lines[1], withDeadline].join('\n'))
    expect(r.stats).toMatchObject({ remaining_ms: 0, scan_ms: 449 }); expect(r.verdict).toBe('pass'); output([r], 0)
  })
  function late() {
    const stub: any[] = [{ seq: 1, event: 'fault', control: 'faults', method: 'users.conversations', label: key, request_id: 'late', outcome: 'late', arrival_mono_ms: 1 },
      { seq: 5, event: 'fault-settled', request_id: 'late', resolution: 'late', socket_open: false },
      { seq: 4, event: 'api', method: 'users.conversations', label: key, request_id: 'late', answer: 'ok', status: 200 }]
    return { stub, mark: 3, log: scanLine(clock, true), before: JSON.stringify({ facts: token }), after: JSON.stringify({ facts: token }),
      run() { return membershipLateVerdict(key, 'late', this.stub, this.mark, diag(this.log), this.before, this.after) } }
  }
  test('abandoned late answer after replacement completion leaves state equal', () => output([late().run()], 0))
  function lateMembershipState() {
    const f = late()
    const facts = { key, incarnation: 'life', assignments: {}, historicalMembership: {} }
    const order = { key, channel, startedOrder: 1, resolvedOrder: 2 }
    const joins = [joinRecord(threadJoin({ channel })),
      joinRecord(threadJoin({ channel, root: '1700000000.000002', source: 'own-post' }), 3)]
    f.before = f.after = jsonl([facts, order, ...joins])
    return { f, facts, order, joins }
  }
  test.each(['join-added', 'join-removed', 'join-changed', 'broadcast-added', 'facts', 'attempt-order',
    'own-post-changed', 'own-post-removed', 'own-post-duplicated', 'join-reordered', 'bytes'] as const)
  ('late membership state still rejects %s', defect => {
    const { f, facts, order, joins } = lateMembershipState()
    if (defect === 'join-added' || defect === 'broadcast-added') joins.push(joinRecord(threadJoin({
      channel, root: '1700000000.000003', source: defect === 'join-added' ? 'mention' : 'broadcast' }), 4))
    if (defect === 'join-removed') joins.shift()
    if (defect === 'join-changed') joins[0].source = 'own-post'
    if (defect === 'facts') facts.historicalMembership = { [channel]: { member: false } }
    if (defect === 'attempt-order') order.resolvedOrder++
    if (defect === 'own-post-changed') joins[1].at++
    if (defect === 'own-post-removed') joins.pop()
    if (defect === 'own-post-duplicated') joins.push({ ...joins[1] })
    if (defect === 'join-reordered') joins.reverse()
    f.after = jsonl([facts, order, ...joins])
    if (defect === 'bytes') f.after = f.after.replace('\n', ' \n')
    // Reject the change alone and when new own posts accompany it.
    const changed = f.after
    for (const extra of ['', jsonl([joinRecord(threadJoin({ channel, root: '1700000000.000004', source: 'own-post' }), 5)])]) {
      f.after = changed + extra
      const r = f.run()
      expect(r.stats.unchanged).toBe('no'); expect(r.verdict).toBe('fail'); output([r], 1)
    }
  })
  test('late membership state excludes only own-post joins first observed after the complete-mark read', () => {
    const { f } = lateMembershipState()
    f.after += jsonl([3, 4].map((n, i) => joinRecord(threadJoin({
      channel, root: `1700000000.00000${n}`, source: 'own-post' }), i + 4)))
    const r = f.run()
    expect(r.stats.unchanged).toBe('yes'); expect(r.verdict).toBe('pass'); output([r], 0)
  })
  test.each(['empty-order', 'empty-joins', 'large-readers'] as const)('late_state preserves reader bytes: %s', variant => {
    const facts = JSON.stringify({ persona: key, saved: 'facts' })
    const large = Array.from({ length: 1000 }, (_, n) => JSON.stringify({ ordinal: n, saved: 'x'.repeat(200) })).join('\n')
    const order = variant === 'empty-order' ? '' : large
    const joins = variant === 'empty-joins' ? '' : large
    const expected = [facts, order, joins].filter(Boolean).map(value => value + '\n').join('')
    const result = shell([
      declaration(source('lib/membership-load.sh'), 'read_jsonl'),
      declaration(source('lib/membership-load.sh'), 'late_state'),
      'P=alpha',
      'shared_persona_facts() { bun "$HOME/printer.ts" "$HOME/facts"; }',
      'shared_attempt_order() { bun "$HOME/printer.ts" "$HOME/order"; }',
      'shared_thread_joins() { bun "$HOME/printer.ts" "$HOME/joins"; }',
      'late_state "$HOME/late.state"', 'cat "$HOME/late.state"',
    ].join('\n'), {
      // Match the real printer's stdout call, including its empty-value path.
      'printer.ts': 'await Bun.write(Bun.stdout, await Bun.file(process.argv[2]).text())\n',
      facts, order, joins,
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(result.stdout).toBe(expected)
    const f = late(); f.before = result.stdout; f.after = result.stdout
    // This exercises stateRead through its unchanged public verdict caller.
    expect(f.run().verdict).toBe('pass')
  })
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
  test('ordered writes print Q\'s first/last burst push and ACK seq beside both marks', () => {
    const f = writes(); f.stub.push({ event: 'push', seq: 3, envelope_id: 'tail' }, { event: 'ws-message', seq: 6, envelope_id: 'tail' })
    expect(f.run()[0].stats).toEqual({ overlap: 'yes', retained: 'yes', ordered: 'yes', first_push_seq: 1, last_push_seq: 3,
      first_ack_seq: 6, last_ack_seq: 8, submit_seq: 2, result_seq: 4 })
    f.stub = []
    expect(f.run()[0].stats).toMatchObject({ first_push_seq: 'missing', last_ack_seq: 'missing', submit_seq: 2, result_seq: 4 })
  })
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
  function memberWrites() {
    const [p, q] = sr8Personas(2), write = 'CWRITE', kept = 'CKEPT'
    const facts = (who: string, assignments: any, leaves: any, membership: any) => ({ mode: 'strict', key: who, incarnation: `${who}-life`,
      assignments, leaves, removedDestinations: {}, historicalMembership: membership, threadMemoryCreated: true })
    const hybrid = { [kept]: { delivery: 'thread_hybrid', order: 2, threadHybridSince: 'stamp' } }
    const joinedKept = { [kept]: { member: true, boundary: 2, identity: 'install', observedThrough: '1.000000' } }
    const other = facts(p, structuredClone(hybrid), {}, structuredClone(joinedKept))
    const leave = { event: 'Ev0STUBLEAVE', boundary: 7, incarnation: `${q}-life` }
    const states = {
      before: [facts(q, { ...structuredClone(hybrid), [write]: { delivery: 'off', order: 5 } }, {},
        { ...structuredClone(joinedKept), [write]: { member: true, boundary: 5, identity: 'install', observedThrough: '1.000000' } }), other],
      leave: [facts(q, structuredClone(hybrid), { [write]: leave }, { ...structuredClone(joinedKept), [write]: { member: false, boundary: 7, identity: 'install' } })],
      join: [facts(q, { ...structuredClone(hybrid), [write]: { delivery: 'off', order: 9 } }, { [write]: leave },
        { ...structuredClone(joinedKept), [write]: { member: true, boundary: 9, identity: 'install' } }), structuredClone(other)],
      reopened: [] as any[],
    }
    // A reopen scan refreshes historical membership cutoffs; choices and leaves stay exact.
    states.reopened = structuredClone(states.join)
    for (const f of states.reopened) for (const m of Object.values(f.historicalMembership) as any[]) m.observedThrough = '2.000000'
    const writes = [{ kind: 'leave', envelope_id: 'leave-env', event_id: leave.event, stage_seq: '3' },
      { kind: 'join', envelope_id: 'join-env', event_id: 'Ev0STUBJOIN', stage_seq: '7' }]
    const events = [{ kind: 'leave', event_id: leave.event, applied: { channel: write, member: false, order: 7, boundary: 7 } },
      { kind: 'join', event_id: 'Ev0STUBJOIN', applied: { channel: write, member: true, order: 9, boundary: 9 } }]
    // The case slice holds both personas: P's own push, scan and the control
    // installed before the burst are outside Q's writes and marks.
    const firstPage = (seq: number, label = q) => ({ event: 'api', seq, label, method: 'users.conversations', cursor: '', answer: 'ok' })
    const stub: any[] = [{ event: 'control', seq: 0, source: 'http', labels: [p, q] }, { event: 'push', seq: 1, envelope_id: 'burst', label: q },
      { event: 'inventory', seq: 3, label: q, fields: ['inventory_pages'] },
      { event: 'push', seq: 4, envelope_id: 'leave-env', label: q, channel: write, event_type: 'channel_left' },
      { event: 'ws-message', seq: 5, envelope_id: 'leave-env', label: q }, firstPage(6),
      { event: 'inventory', seq: 7, label: q, fields: ['inventory_pages'] },
      { event: 'push', seq: 8, envelope_id: 'join-env', label: q, channel: write, event_type: 'member_joined_channel' },
      { event: 'ws-message', seq: 9, envelope_id: 'join-env', label: q }, firstPage(10), firstPage(10.5, p),
      { event: 'push', seq: 10.7, envelope_id: 'p-burst', label: p }, { event: 'ws-message', seq: 11, envelope_id: 'burst', label: q }]
    const at = (event: string, envelope?: string) => stub.find(r => r.event === event && (envelope === undefined || r.envelope_id === envelope))
    return { p, q, write, kept, states: { ...states, events, eventsReopened: structuredClone(events) }, writes, stub, at, submit: 2, done: 9,
      times: [timing('burst')], writeTimes: [timing('leave-env'), timing('join-env')],
      run() { return membershipWriteVerdicts(sr8Personas(2), this.q, this.write, 'strict', this.states, this.writes, this.stub, this.submit, this.done, this.times, this.writeTimes) } }
  }
  test('strict ordered writes are a staged, acknowledged live leave then fresh off rejoin, each applied by its own event, overlapping the burst and exact after reopen', () => {
    const got = memberWrites().run()
    expect(got.map(r => [r.measure, r.verdict])).toEqual([['ordered-writes', 'pass'], ['ordered-write-ack', 'pass'], ['membership-write-ack', 'pass']])
    expect(got[0].stats).toEqual({ overlap: 'yes', retained: 'yes', ordered: 'yes', acked: 'yes', staged: 'yes' }); output(got, 0)
  })
  test.each(['refused', 'no-op-join', 'reordered', 'ack-order', 'wrong-default', 'stale-order', 'unrelated-writer', 'unrelated-persona',
    'reopen', 'overlap', 'unacked', 'other-channel', 'slow-write-ack', 'slow-burst-ack', 'scan-leave', 'other-event-leave', 'scan-rejoin',
    'rejoin-order', 'events-reopen', 'unstaged', 'stage-after-push', 'stage-before-submit', 'no-rescan', 'rescan-before-push',
    'rescan-after-restage', 'other-label-rescan', 'control-reset', 'missing-state', 'missing-writes', 'missing-events'] as const)('strict membership writes reject %s', defect => {
    const f = memberWrites(), [q] = f.states.join
    const scans = f.stub.filter(r => r.event === 'api' && r.label === f.q)
    if (defect === 'refused') f.states.leave = structuredClone(f.states.before).slice(0, 1)
    if (defect === 'no-op-join') { q.assignments[f.write] = f.states.before[0].assignments[f.write]; f.states.reopened = structuredClone(f.states.join) }
    if (defect === 'reordered') f.writes.reverse()
    if (defect === 'ack-order') f.at('ws-message', 'leave-env').seq = 8.5
    if (defect === 'wrong-default') { q.assignments[f.write].delivery = 'mentions'; f.states.reopened = structuredClone(f.states.join) }
    if (defect === 'stale-order') {
      q.assignments[f.write].order = 7; q.historicalMembership[f.write].boundary = 7; f.states.reopened = structuredClone(f.states.join)
    }
    if (defect === 'unrelated-writer') { q.assignments[f.kept].delivery = 'off'; f.states.reopened = structuredClone(f.states.join) }
    if (defect === 'unrelated-persona') f.states.reopened[1].assignments[f.kept].delivery = 'all'
    if (defect === 'reopen') f.states.reopened[0].assignments[f.write].order = 10
    if (defect === 'overlap') f.at('ws-message', 'burst').seq = 2
    if (defect === 'unacked') f.stub.splice(f.stub.indexOf(f.at('ws-message', 'leave-env')), 1)
    if (defect === 'other-channel') f.at('push', 'leave-env').channel = f.kept
    if (defect === 'slow-write-ack') f.writeTimes[1].acks[0].ack_mono_ms++
    if (defect === 'slow-burst-ack') f.times[0].acks[0].ack_mono_ms++
    // A scan's absence leave carries every correlation except a live event's identity.
    if (defect === 'scan-leave') {
      const id = `scan:1:absent:${f.write}`
      for (const phase of ['leave', 'join', 'reopened'] as const) f.states[phase][0].leaves[f.write] = { ...f.states[phase][0].leaves[f.write], event: id }
      f.writes[0].event_id = id; f.states.events[0].event_id = id; f.states.eventsReopened[0].event_id = id
    }
    if (defect === 'other-event-leave') { f.writes[0].event_id = 'Ev0OTHER'; f.states.events[0].event_id = 'Ev0OTHER'; f.states.eventsReopened[0].event_id = 'Ev0OTHER' }
    if (defect === 'scan-rejoin') { f.states.events[1].applied = null as any; f.states.eventsReopened[1].applied = null as any }
    if (defect === 'rejoin-order') { f.states.events[1].applied.order = 8; f.states.eventsReopened[1].applied.order = 8 }
    if (defect === 'events-reopen') f.states.eventsReopened[0] = { ...f.states.eventsReopened[0]!, applied: null as any }
    if (defect === 'unstaged') f.stub.splice(f.stub.findIndex(r => r.event === 'inventory' && r.seq === 7), 1)
    if (defect === 'stage-after-push') {
      f.at('push', 'join-env').seq = 7; f.stub.find(r => r.event === 'inventory' && r.seq === 7).seq = 8; f.writes[1].stage_seq = '8'
    }
    if (defect === 'stage-before-submit') { f.stub.find(r => r.event === 'inventory' && r.seq === 3).seq = 2; f.writes[0].stage_seq = '2' }
    if (defect === 'no-rescan') f.stub.splice(f.stub.indexOf(scans[0]), 1)
    if (defect === 'rescan-before-push') scans[1].seq = 7.5
    if (defect === 'rescan-after-restage') scans[0].seq = 7.2
    if (defect === 'other-label-rescan') scans[1].label = f.p
    if (defect === 'control-reset') f.stub.push({ event: 'control', seq: 6.5, source: 'file', labels: [f.p, f.q] })
    if (defect === 'missing-state') f.states.leave = []
    if (defect === 'missing-writes') f.writes.pop()
    if (defect === 'missing-events') f.states.events = []
    const want = defect.startsWith('missing') ? 'missing' : 'fail'
    expect(f.run().some(r => r.verdict === want)).toBe(true); output(f.run(), 1)
  })
  // Test-32's strict write, run for real over recorded facts: the stub I/O is
  // replaced, the staging, event build, timing and validation are the script's
  // own. A stale event left where the old workload prebuilt it must not be sent.
  const leftFacts = { written: null, leave: { event: 'Ev0LEAVE', boundary: 7, incarnation: 'beta-life' }, membership: { member: false, boundary: 7 }, unrelated: ['kept'] }
  const fresh = '1800000000.000042', stale = JSON.stringify({ type: 'prebuilt', event_ts: '1700000000.000001' })
  const freshEvent = (type: string, channel: string) => JSON.stringify({ type, channel, channel_type: 'C', user: 'U0SELF', event_ts: fresh })
  const eventBuilder = [
    'require_ci_image() { :; }', 'slack_stub_identity() { printf \'U0SELF\\n\'; }', declaration(scenario, 'slack_membership_event'),
    `scenario_ts() { printf 'ts\\n' >> "$HOME/calls"; printf '%s\\n' ${fresh}; }`,
    'real_thread_epoch_ms() { local t; t=$(( $(cat "$HOME/clock") + 10 )); printf \'%s\' "${t}" > "$HOME/clock"; printf \'clock %s\\n\' "${t}" >> "$HOME/calls"; printf \'%s\\n\' "${t}"; }',
  ]
  const strictWrite = (n: number, before: any, after: any, event: string, applied: any) => shell([
    ...eventBuilder,
    '_real_thread_write_facts() { cat "$HOME/facts-${1##*.}.json" > "$1"; }',
    'slack_stub_inventory_stage() { printf \'stage %s\\n\' "$*" >> "$HOME/calls"; printf \'7\\n\'; }',
    'slack_push_event_ids() { printf \'push %s %s\\n\' "$1" "$2" >> "$HOME/calls"; printf \'env-1\\t%s\\n\' "$(cat "$HOME/event-id")"; }',
    'slack_wait_one_ack() { printf \'ack %s\\n\' "$*" >> "$HOME/calls"; }',
    'slack_stub_record_field() { printf \'9\\n\'; }',
    'wait_membership_rescan() { printf \'rescan %s\\n\' "$*" >> "$HOME/calls"; }',
    'shared_membership_event() { printf \'applied %s\\n\' "$*" >> "$HOME/calls"; cat "$HOME/applied.json"; }',
    declaration(real, 'real_thread_membership_write'),
    'REAL_THREAD_EVIDENCE="$HOME/ev" REAL_WRITER_LABEL=beta REAL_WRITER_KEY=beta REAL_WRITE_CHANNEL=CWRITE',
    'REAL_WRITER_CHANNELS=(CONE CWRITE CTWO)',
    `rc=0; (real_thread_membership_write ${n}) || rc=$?`,
    'printf \'rc=%s\\n\' "${rc}"; cat "$HOME/calls"; cat "$HOME/ev/operations.tsv" 2>/dev/null || true',
  ].join('\n'), { clock: '1000', 'event-id': event, 'facts-before.json': JSON.stringify(before), 'facts-after.json': JSON.stringify(after),
    'applied.json': JSON.stringify(applied), [`ev/beta-membership-${n}.json`]: stale })
  const leaveCase = () => ({ n: 1, before: { written: { delivery: 'off', order: 5 }, leave: null, membership: { member: true, boundary: 5 }, unrelated: ['kept'] },
    after: structuredClone(leftFacts), event: 'Ev0LEAVE', applied: { channel: 'CWRITE', member: false, order: 7, boundary: 7 } })
  const joinCase = () => ({ n: 2, before: structuredClone(leftFacts),
    after: { ...structuredClone(leftFacts), written: { delivery: 'off', order: 9 }, membership: { member: true, boundary: 9 } },
    event: 'Ev0JOIN', applied: { channel: 'CWRITE', member: true, order: 9, boundary: 9 } })
  test.each(['leave', 'join'] as const)('strict thread write: a staged live %s, built fresh after staging, timed push to ACK, then rescanned and applied by its own event', kind => {
    const f = kind === 'leave' ? leaveCase() : joinCase(), run = strictWrite(f.n, f.before, f.after, f.event, f.applied)
    expect(run.stderr).toBe('')
    const staged = kind === 'leave' ? 'CONE CTWO' : 'CONE CWRITE CTWO'
    const type = kind === 'leave' ? 'channel_left' : 'member_joined_channel'
    expect(run.stdout).toBe([`rc=0`, `stage beta memberships ${staged}`, 'ts', 'clock 1010', `push beta ${freshEvent(type, 'CWRITE')}`, 'ack env-1',
      'clock 1020', 'rescan beta beta 9', `applied beta ${f.event}`, `write\t${f.event}\t1010\t1020`, ''].join('\n'))
  })
  // Alpha's concurrent event, in both modes: built fresh in the worker just
  // before its timed push, same type alternation, persona and channel.
  test.each([['strict', 1], ['strict', 2], ['open', 1], ['open', 2]] as const)('thread worker (%s, sample %d) builds alpha\'s membership event fresh before its timed push', (mode, n) => {
    const run = shell([
      ...eventBuilder,
      'slack_stub_push() { printf \'push %s %s\\n\' "$1" "$2" >> "$HOME/calls"; printf \'env-a\\n\'; }',
      'slack_wait_one_ack() { printf \'ack %s\\n\' "$*" >> "$HOME/calls"; }',
      'real_thread_membership_write() { printf \'strict-write %s\\n\' "$1" >> "$HOME/calls"; }',
      'stub_session_call() { printf \'call %s\\n\' "$2" >> "$HOME/calls"; printf \'{"isError":false,"text":"applied"}\\n\'; }',
      'bun() { printf \'applied\\n\'; }',
      declaration(real, 'real_thread_concurrent_work'),
      `REAL_THREAD_EVIDENCE="$HOME/ev" REAL_THREAD_MODE=${mode} REAL_LABEL=alpha REAL_MEMBER_CHANNEL=CMEMBER REAL_WRITER_WORK=/w`,
      'REAL_THREAD_WRITE_TOOL=set_delivery SCENARIO_FIXTURES=/f REAL_WRITER_KEY=beta REAL_WRITE_CHANNEL=CWRITE',
      `real_thread_concurrent_work ${n}`, 'cat "$HOME/calls" "$HOME/ev/operations.tsv"',
    ].join('\n'), { clock: '1000', [`ev/membership-${n}.json`]: stale, [`ev/write-${n}.json`]: JSON.stringify({ attempt_id: 'att-1', delivery: 'off' }) })
    expect(run.stderr).toBe('')
    const pushed = ['ts', 'clock 1010', `push alpha ${freshEvent(n % 2 ? 'channel_left' : 'member_joined_channel', 'CMEMBER')}`, 'ack env-a', 'clock 1020']
    const tail = mode === 'strict' ? [`strict-write ${n}`] : ['clock 1030', 'call set_delivery', 'clock 1040']
    const ops = [`membership\t${fresh}\t1010\t1020`, ...(mode === 'open' ? ['write\tatt-1\t1030\t1040'] : [])]
    expect(run.stdout).toBe([...pushed, ...tail, ...ops, ''].join('\n'))
  })
  test.each([
    ['leave refused', leaveCase, (f: any) => { f.after = structuredClone(f.before) }],
    ['leave by a scan', leaveCase, (f: any) => { f.event = f.after.leave.event = 'scan:1:absent:CWRITE' }],
    ['leave by another event', leaveCase, (f: any) => { f.after.leave.event = 'Ev0OTHER' }],
    ['leave not later', leaveCase, (f: any) => { f.after.leave.boundary = 5; f.after.membership.boundary = 5; f.applied.order = f.applied.boundary = 5 }],
    ['leave not applied by its event', leaveCase, (f: any) => { f.applied = null }],
    ['leave from a non-member', leaveCase, (f: any) => { f.before.membership.member = false }],
    ['join no-op', joinCase, (f: any) => { f.after = structuredClone(f.before) }],
    ['join reordered before the leave', joinCase, (f: any) => { f.after.written.order = 6; f.after.membership.boundary = 6; f.applied.order = f.applied.boundary = 6 }],
    ['join by a scan', joinCase, (f: any) => { f.applied = null }],
    ['join wrong default', joinCase, (f: any) => { f.after.written.delivery = 'mentions' }],
    ['join changed the leave', joinCase, (f: any) => { f.after.leave.boundary = 8 }],
    ['join changed unrelated state', joinCase, (f: any) => { f.after.unrelated = ['changed'] }],
  ] as const)('strict thread write refuses %s and records no operation', (_name, base, defect) => {
    const f: any = base(); defect(f)
    const run = strictWrite(f.n, f.before, f.after, f.event, f.applied)
    expect(run.stdout).toContain('rc=1'); expect(run.stdout).not.toContain('write\t'); expect(run.stderr).toContain('was not applied by its own event')
  })
  test('test-45 strict writes stage Q\'s inventory before each event, settle its own scan before reading, and record each event identity', () => {
    const load = source('lib/membership-load.sh')
    const run = shell([
      'log() { printf \'%s\\n\' "$*" >> "$HOME/calls"; }',
      'write_states() { log states "${1##*/}"; : > "$1"; }', 'wait_until() { log wait "$2"; }',
      'slack_post_mark() { log mark; printf \'5\\n\'; }', 'slack_stub_inventory_stage() { log stage "$@"; printf \'3\\n\'; }',
      'scenario_ts() { printf \'1.0\\n\'; }', 'slack_push_membership_ids() { log push "$@"; printf \'env-%s\\tEv-%s\\n\' "$1" "$1"; }',
      'slack_wait_one_ack() { log ack "$@"; }', 'slack_stub_record_field() { log seq "$@"; printf \'8\\n\'; }',
      'wait_membership_rescan() { log rescan "$@"; }', 'read_jsonl() { log read "${1##*/}"; }',
      'shared_membership_event() { printf \'{"for":"%s"}\\n\' "$2"; }',
      declaration(load, 'applied_events'), declaration(load, 'membership_writes'),
      'WRITES="$HOME/w" Q=beta PAGE_LIMIT=2 WAIT_S=30 CASE_MARK=1 WRITE_CHANNEL=CWRITE; CHANNELS=(CONE CTWO CWRITE); mkdir -p "${WRITES}"',
      'membership_writes', 'printf \'submit=%s result=%s\\n\' "${WRITE_SUBMIT}" "${WRITE_RESULT}"',
      'cat "$HOME/calls" "${WRITES}/membership.tsv" "${WRITES}/events.jsonl"',
    ].join('\n'))
    expect(run.stderr).toBe('')
    expect(run.stdout.split('\n')).toEqual(['submit=5 result=5', 'states before.jsonl', 'wait burst has no observed push', 'mark',
      'stage beta 2 CONE CTWO', 'push channel_left beta CWRITE 1.0', 'ack env-channel_left 30', 'seq seq push envelope_id=env-channel_left',
      'rescan beta beta 8', 'read leave.jsonl',
      'stage beta 2 CONE CTWO CWRITE', 'push member_joined_channel beta CWRITE 1.0', 'ack env-member_joined_channel 30', 'mark',
      'seq seq push envelope_id=env-member_joined_channel', 'rescan beta beta 8', 'states join.jsonl',
      'leave\tenv-channel_left\tEv-channel_left\t3', 'join\tenv-member_joined_channel\tEv-member_joined_channel\t3',
      '{"kind":"leave","event_id":"Ev-channel_left","applied":{"for":"Ev-channel_left"}}',
      '{"kind":"join","event_id":"Ev-member_joined_channel","applied":{"for":"Ev-member_joined_channel"}}', ''])
  })
  // The session barrier's real declarations; the log and its polling are stand-ins
  // whose poll appends the next staged server lines between checks.
  const barrier = [
    'matcher() { printf "%s\\n" "$*"; }', 'persona_ref() { printf \'"%s" (key=%s)\\n\' "$1" "$1"; }',
    'count_log() { grep -cF -- "$1" "$HOME/server.log" || true; }', '_scenario_check_timeout() { :; }',
    'last_log_line() { local l; l="$(grep -nF -- "$1" "$HOME/server.log" | tail -n 1)" || true; [[ -z "$l" ]] || printf "%s\\n" "${l%%:*}"; }',
    '_scenario_poll_until() { local i; shift; for i in 1 2 3; do "$@" && return 0; if [[ -f "$HOME/more.$i" ]]; then cat "$HOME/more.$i" >> "$HOME/server.log"; fi; done; return 1; }',
    ...['session_connected_match', 'session_barrier_mark', '_scenario_session_reconnected', '_scenario_sessions_reconnected', 'session_barrier_wait']
      .map(name => declaration(scenario, name)),
  ].join('\n')
  const connected = (name: string) => `[slack] Session connected: persona "${name}" (key=${name}) cwd="/w"\n`
  test('the session barrier waits for every marked persona\'s new session, under one timeout', () => {
    const old = connected('alpha') + connected('beta') + connected('alpha2')
    const both = shell([barrier, 'session_barrier_mark alpha beta', 'session_barrier_wait 150 "reopen barrier"', 'echo passed'].join('\n'),
      { 'server.log': old, 'more.1': connected('alpha2') + connected('alpha'), 'more.2': connected('beta') })
    expect({ status: both.status, stdout: both.stdout, stderr: both.stderr }).toEqual({ status: 0, stdout: 'passed\n', stderr: '' })
    // A look-alike persona's session or the old server's lines never satisfy it.
    const one = shell([barrier, 'session_barrier_mark alpha beta', 'session_barrier_wait 150 "reopen barrier"', 'echo passed'].join('\n'),
      { 'server.log': old, 'more.1': connected('alpha'), 'more.2': connected('alpha2') })
    expect(one.status).toBe(1); expect(one.stdout).toBe('')
    expect(one.stderr).toBe('reopen barrier (not within 150s; no new session for: beta)\n')
    const unmarked = shell([barrier, 'session_barrier_wait 150 "reopen barrier"'].join('\n'), { 'server.log': old })
    expect(unmarked.status).toBe(1); expect(unmarked.stderr).toBe('reopen barrier: session_barrier_mark was not run\n')
    const none = shell([barrier, 'session_barrier_mark'].join('\n'))
    expect(none.status).toBe(1); expect(none.stderr).toBe('session_barrier_mark: no persona named\n')
  })
  const dropped = (name: string) => `[slack] persona "${name}" (key=${name}): MCP session dropped — the persona is not up (x); kept\n`
  test('the positional session barrier passes only on a session after the mark and the persona\'s last drop', () => {
    const wait = (mode: string) => [barrier, `session_barrier_mark ${mode} alpha beta`, 'session_barrier_wait 150 "authorization barrier"', 'echo passed'].join('\n')
    // A session admitted in an up window and then dropped raises the count,
    // so the count form passes; the position form waits for a later session.
    const old = dropped('alpha') + connected('alpha') + connected('beta')
    const window = { 'server.log': old, 'more.1': connected('alpha') + connected('beta') + dropped('alpha') }
    const counted = shell(wait(''), window)
    expect({ status: counted.status, stdout: counted.stdout, stderr: counted.stderr }).toEqual({ status: 0, stdout: 'passed\n', stderr: '' })
    const held = shell(wait('--position'), window)
    expect(held.status).toBe(1); expect(held.stdout).toBe('')
    expect(held.stderr).toBe('authorization barrier (not within 150s; no session after the mark and the last drop for: alpha)\n')
    // The pre-mark sessions never satisfy it, nor a look-alike's session or drop.
    const before = shell(wait('--position'), { 'server.log': old, 'more.1': connected('alpha2') + dropped('beta2') })
    expect(before.status).toBe(1)
    expect(before.stderr).toBe('authorization barrier (not within 150s; no session after the mark and the last drop for: alpha beta)\n')
    const recovered = shell(wait('--position'), { ...window, 'more.2': connected('alpha') + dropped('alpha2') })
    expect({ status: recovered.status, stdout: recovered.stdout, stderr: recovered.stderr }).toEqual({ status: 0, stdout: 'passed\n', stderr: '' })
  })
  test('the positional session barrier mark records server.log\'s line count, and a count-form mark resets it', () => {
    const old = dropped('alpha') + connected('alpha') + connected('beta')
    // An unterminated last line at the mark is pre-mark text once completed.
    const partial = shell([barrier, 'session_barrier_mark --position alpha', 'printf "%s" "${SESSION_BARRIER[alpha]}"'].join('\n'),
      { 'server.log': old + '[slack] Session conn' })
    expect({ status: partial.status, stdout: partial.stdout, stderr: partial.stderr }).toEqual({ status: 0, stdout: '4', stderr: '' })
    // A missing log marks line 0, and a later count-form mark resets the mode.
    const missing = shell([barrier, 'session_barrier_mark --position alpha', 'printf "%s %s" "$SESSION_BARRIER_MODE" "${SESSION_BARRIER[alpha]}"'].join('\n'))
    expect({ status: missing.status, stdout: missing.stdout, stderr: missing.stderr }).toEqual({ status: 0, stdout: 'position 0', stderr: '' })
    const reset = shell([barrier, 'session_barrier_mark --position alpha', 'session_barrier_mark alpha',
      'printf "%s %s" "$SESSION_BARRIER_MODE" "${SESSION_BARRIER[alpha]}"'].join('\n'), { 'server.log': old })
    expect({ status: reset.status, stdout: reset.stdout, stderr: reset.stderr }).toEqual({ status: 0, stdout: 'count 1', stderr: '' })
    const unnamed = shell([barrier, 'session_barrier_mark --position'].join('\n'))
    expect(unnamed.status).toBe(1); expect(unnamed.stderr).toBe('session_barrier_mark: no persona named\n')
  })
  test('test-45/48 start_ready marks sessions before the start and lists tools only after the barrier', () => {
    const load = source('lib/membership-load.sh')
    const run = shell([
      'log() { printf \'%s\\n\' "$*" >> "$HOME/calls"; }', 'count_log() { printf "0\\n"; }', 'completion_match() { printf "complete\\n"; }',
      'matcher() { printf "%s\\n" "$*"; }', 'printed() { printf "recorder\\n"; }', 'mono_ms() { log mono; printf "7\\n"; }',
      'start_server() { log start "$@"; }', 'wait_for_count() { log count "$4"; }', 'expect_one_overrides_line() { log overrides; }',
      'session_barrier_mark() { log mark "$@"; }', 'session_barrier_wait() { log barrier "$@"; }',
      'wait_membership_complete() { log membership "$1"; }', 'stub_session_list_tools() { log tools "${1##*/}"; }',
      declaration(load, 'start_ready'), 'KEYS=(alpha beta) ROOT="$HOME" OVERRIDES_STEM=o MEASUREMENTS=m',
      'start_ready measured', 'printf "start=%s ready=%s\\n" "$START_MS" "$READY_MS"', 'cat "$HOME/calls"',
    ].join('\n'))
    expect(run.stderr).toBe('')
    expect(run.stdout.split('\n')).toEqual(['start=7 ready=7', 'mark alpha beta', 'mono', 'start --live', 'count two-persona startup incomplete',
      'overrides', 'count measurement recorder not enabled', 'barrier 150 persona MCP sessions did not reconnect to the new server',
      'membership alpha', 'tools alpha', 'membership beta', 'tools beta', 'mono', ''])
  })
  test('test-45/48 verdict exits print a FAIL line after the verdict\'s own lines', () => {
    const load = source('lib/membership-load.sh'), verdict = load.match(/^verdict\(\) \{.*\}$/m)![0]
    const fixture = (rc: number) => `console.log('recorded: sr8 ' + process.argv[2] + ' verdict=${rc ? 'fail' : 'pass'}'); process.exit(${rc})`
    const failed = shell([verdict, 'E="$HOME/e.ts"', 'verdict membership-fault test-45 strict', 'echo after'].join('\n'), { 'e.ts': fixture(1) })
    expect({ status: failed.status, stdout: failed.stdout, stderr: failed.stderr })
      .toEqual({ status: 1, stdout: 'recorded: sr8 membership-fault verdict=fail\n', stderr: 'sr8 membership-fault verdict did not pass\n' })
    const passed = shell([verdict, 'E="$HOME/e.ts"', 'verdict seal measured', 'echo after'].join('\n'), { 'e.ts': fixture(0) })
    expect({ status: passed.status, stdout: passed.stdout, stderr: passed.stderr })
      .toEqual({ status: 0, stdout: 'recorded: sr8 seal verdict=pass\nafter\n', stderr: '' })
    // Every verdict command goes through it; setup and observation commands do not.
    const direct = [...load.matchAll(/bun "\$\{E\}" ([a-z-]+)/g)].map(m => m[1]).sort()
    expect([...new Set(direct)]).toEqual(['bodies', 'burst', 'conditions', 'config', 'cpu-mark', 'diag-ack', 'envelope-times', 'fault-burst', 'fault-ids', 'fault-plan', 'fault-recover', 'member-cpu', 'plan', 'seed'])
  })
  test('test-45/48 reopen observer prints AD rows, lifecycle, stub hook and MCP session fields only on a reopen failure', () => {
    const load = source('lib/membership-load.sh'), safe = load.match(/^REOPEN_SAFE='[\s\S]*?;'$/m)![0]
    const secret = 'private message text', tok = fakeToken(BOT_TOKEN_PREFIX, 'reopen-observer')
    const files = {
      'state/server.log': `[2030-01-01T00:00:00.000Z] [slack] earlier ${secret}\n`,
      'state/more.log': [`[2030-01-01T00:00:01.000Z] [slack] Session disconnected: persona "alpha" (key=alpha) cwd="/w" ${secret}`,
        `[slack] persona "alpha" (key=alpha): MCP session dropped — ${tok}`, `[2030-01-01T00:00:02.000Z] [slack] persona-start: personas[0] "alpha" (key=alpha): bring-up starting`,
        '[slack] Scheduling restart for persona=alpha in 5s (backoff)', `[2030-01-01T00:00:03.000Z] [slack] Session connected: persona "alpha2" (key=alpha2) cwd="/w"`, ''].join('\n'),
      'bin/stub-claude-hooks.s1.jsonl': jsonl([{ command: `say ${secret}`, event: 'Stop', instance_id: 'cscb_alpha', session_id: 's1', pid: 4, at: '12.5' },
        { command: 'x', event: 'Stop', instance_id: 'cscb_other', session_id: 's9', pid: 9, at: '1' }]),
      'bin/sessions.alpha': jsonl([{ event: 'connected', session_id: 'm1', reason: 'initial', pid: 5, text: secret }, { event: 'closed', session_id: tok, reason: secret, pid: 5 }]),
    }
    const program = (observe: string) => [
      'persona_key() { printf "%s\\n" "$1"; }', 'persona_ref() { printf \'"%s" (key=%s)\\n\' "$1" "$1"; }',
      'printed() { printf "cscb_%s\\n" "$2"; }', '_scenario_stub_dir() { printf "%s\\n" "$HOME/bin"; }',
      '_scenario_session_file() { [[ "$2" == sessions ]] && printf "%s\\n" "$HOME/bin/sessions.${1##*/}"; }',
      `ad_capture() { AD_OUT="$HOME/ad.out" AD_RC=0; jq -nc --arg id "$3" --arg tok "${tok}" '{state:(if $id=="cscb_alpha" then "waiting" else "dead" end),session_id:"s1",launch_started_at:"2030-01-01T00:00:00Z",last_seen_at:"2030-01-01T00:00:04Z",ended_at:(if $id=="cscb_alpha" then null else "2030-01-01T00:00:05Z" end),updated_at:"2030-01-01T00:00:09Z",labels:{t:$tok},cwd:"${secret}"}' > "$AD_OUT"; }`,
      load.match(/^log_slice\(\) .*$/m)![0], 'byte_mark() { wc -c < "$1"; }',
      safe, ...['reopen_ad_rows', 'reopen_lifecycle', 'reopen_stub_records', 'reopen_observe'].map(name => declaration(load, name)),
      'KEYS=(alpha beta) ROOT="$HOME" CASE=test-45-strict-first-hang',
      'REOPEN_OBSERVE_LOG="$(byte_mark "$SLACK_STATE_DIR/server.log")"', 'reopen_ad_rows before-stop > "$ROOT/reopen-observe.rows"',
      'cat "$SLACK_STATE_DIR/more.log" >> "$SLACK_STATE_DIR/server.log"', `REOPEN_OBSERVE=${observe}`, 'reopen_observe',
    ].join('\n')
    const quiet = shell(['SLACK_STATE_DIR="$HOME/state"', program("''")].join('\n'), files)
    expect({ status: quiet.status, stdout: quiet.stdout, stderr: quiet.stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
    const run = shell(['SLACK_STATE_DIR="$HOME/state"', program('1')].join('\n'), files)
    expect(run.stderr).toBe('')
    const lines = run.stdout.trim().split('\n')
    expect(lines).toEqual([
      'reopen-observe: case=test-45-strict-first-hang failed between the reopen stop and its measured seal',
      'reopen-observe: phase=before-stop persona=alpha ad_state=waiting session_id=s1 launch_started_at=2030-01-01T00:00:00Z last_seen_at=2030-01-01T00:00:04Z ended_at=absent',
      'reopen-observe: phase=before-stop persona=beta ad_state=dead session_id=s1 launch_started_at=2030-01-01T00:00:00Z last_seen_at=2030-01-01T00:00:04Z ended_at=2030-01-01T00:00:05Z',
      'reopen-observe: phase=at-failure persona=alpha ad_state=waiting session_id=s1 launch_started_at=2030-01-01T00:00:00Z last_seen_at=2030-01-01T00:00:04Z ended_at=absent',
      'reopen-observe: phase=at-failure persona=beta ad_state=dead session_id=s1 launch_started_at=2030-01-01T00:00:00Z last_seen_at=2030-01-01T00:00:04Z ended_at=2030-01-01T00:00:05Z',
      'reopen-observe: persona=alpha lifecycle=connected count=0 at=none',
      'reopen-observe: persona=alpha lifecycle=disconnected count=1 at=2030-01-01T00:00:01.000Z',
      'reopen-observe: persona=alpha lifecycle=dropped count=1 at=none',
      'reopen-observe: persona=alpha lifecycle=persona-start count=1 at=2030-01-01T00:00:02.000Z',
      'reopen-observe: persona=alpha lifecycle=restart-scheduled count=1 at=none',
      'reopen-observe: persona=alpha stub_hook event=Stop session_id=s1 pid=4 at=12.5',
      'reopen-observe: persona=alpha mcp_session event=connected session_id=m1 reason=initial pid=5',
      'reopen-observe: persona=alpha mcp_session event=closed session_id=invalid reason=invalid pid=5',
      'reopen-observe: persona=beta lifecycle=connected count=0 at=none',
      'reopen-observe: persona=beta lifecycle=disconnected count=0 at=none',
      'reopen-observe: persona=beta lifecycle=dropped count=0 at=none',
      'reopen-observe: persona=beta lifecycle=persona-start count=0 at=none',
      'reopen-observe: persona=beta lifecycle=restart-scheduled count=0 at=none',
      'reopen-observe: persona=beta mcp_sessions=absent',
    ])
    expect(run.stdout).not.toContain(secret); expect(run.stdout).not.toContain('cscb_other')
  })
  const recovery = source('lib/shared-channel-recovery.sh')
  const membershipRecovery = source('test-65-shared-channel-recovery-membership-memory.sh')
  const ownPostRecovery = source('test-66-shared-channel-recovery-own-post.sh')
  const identityRecovery = source('test-67-shared-channel-recovery-identity-repair.sh')
  const test29Script = source('test-29-invited-channels.sh')
  // test-65's real held_push; push, record_after and no_ack are stand-ins.
  test.each([
    ['sent', '[]', 'false', 'env-1', 'env-1', 0, ''],
    ['no-open-socket', '[{"reason":"no-open-socket"}]', 'true', '', '', 0, ''],
    ['send-failed', '[{"reason":"send-failed"}]', 'true', '', '', 0, ''],
    ['records=0', '[]', '', '', '', 1, '  | FAIL: test-46: refused (HTTP 409: no-open-socket)\nauthorization held push was neither sent nor refused for the revoked connection (records=0)\n'],
    ['records=2', '[{"reason":"no-open-socket"},{"reason":"send-failed"}]', '', '', '', 1, '  | FAIL: test-46: refused (HTTP 409: no-open-socket)\nauthorization held push was neither sent nor refused for the revoked connection (records=2)\n'],
    ['other reason', '[{"reason":"invalid_auth"}]', '', '', '', 1, '  | FAIL: test-46: refused (HTTP 409: no-open-socket)\nauthorization held push was neither sent nor refused for the revoked connection (invalid_auth)\n'],
  ] as const)('test-65 held_push classifies the authorization held push: %s', (outcome, refused, state, held, noAcks, rc, stderr) => {
    const run = shell([
      'declare -A LABEL=([p]=label-p)', 'B=CB', 'HELD_REFUSED=unset', 'held=unset', `OUTCOME='${outcome}'`,
      'push() { printf "%s\\n" "$*" >> "$HOME/pushes"; [[ "$OUTCOME" == sent ]] && { echo env-1; return 0; }; echo "FAIL: test-46: refused (HTTP 409: no-open-socket)" >&2; exit 1; }',
      'record_after() { printf "%s\\n" "$*" >> "$HOME/reads"; cat "$HOME/refused.json"; }',
      'no_ack() { printf "%s\\n" "$1" >> "$HOME/no_acks"; }',
      'sed() { local l; while IFS= read -r l; do printf "  | %s\\n" "$l"; done < "$2"; }',
      declaration(membershipRecovery, 'held_push'),
      'held_push 1.5 "held text" 7', 'printf "refused=%s held=%s\\n" "$HELD_REFUSED" "$held"',
      'cat "$HOME/pushes"', 'cat "$HOME/reads" 2>/dev/null || true', 'printf "no_acks:%s\\n" "$(cat "$HOME/no_acks" 2>/dev/null || true)"',
    ].join('\n'), { 'refused.json': refused })
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: rc, stderr })
    if (rc) { expect(run.stdout).toBe(''); return }
    const reads = outcome === 'sent' ? [] : ['7 push-refused label=label-p']
    expect(run.stdout.split('\n')).toEqual([`refused=${state} held=${held}`, 'p CB 1.5 held text', ...reads, `no_acks:${noAcks}`, ''])
  })
  test('test-65 phase7_observe prints p\'s lifecycle counts and whitelisted stub records since the case marks, never content', () => {
    const secret = 'private message text', tok = fakeToken(BOT_TOKEN_PREFIX, 'phase7-observer')
    const old = `[2030-01-01T00:00:00.000Z] [slack] Session connected: persona "p" (key=p) cwd="/w" ${secret}\n`
    const files = {
      'state/server.log': old + [
        `[2030-01-01T00:00:01.000Z] [slack] persona-credentials-refused: personas[0] "p" (key=p): users.conversations: Slack error invalid_auth ${tok}`,
        `[slack] persona "p" (key=p): MCP session dropped — the persona is not up (broken: ${secret})`,
        '[2030-01-01T00:00:02.000Z] [slack] Session connected: persona "p" (key=p) cwd="/w"',
        '[2030-01-01T00:00:03.000Z] [slack] Session connected: persona "p2" (key=p2) cwd="/w"',
        `[2030-01-01T00:00:04.000Z] [slack] channel-membership-inventory-incomplete persona=p: pages=0 positives=0 reason=authentication ${secret}`, ''].join('\n'),
      'slack.jsonl': jsonl([{ seq: 1, event: 'ws-open', label: 'label-p', ts: 'old', hello: true },
        { seq: 2, event: 'ws-close', label: 'label-p', ts: '2030-01-01T00:00:01.000Z', code: 1000, ticket: tok },
        { seq: 3, event: 'push-refused', label: 'label-p', ts: '2030-01-01T00:00:02.000Z', reason: 'no-open-socket' },
        { seq: 4, event: 'push-refused', label: 'label-q', ts: '2030-01-01T00:00:02.000Z', reason: 'send-failed' },
        { seq: 5, event: 'ws-open', label: 'label-p', ts: secret, hello: true, ticket: tok }]) + '{"seq":6,',
    }
    const program = (name: string) => [
      'persona_ref() { printf \'"%s" (key=%s)\\n\' "$1" "$1"; }', 'declare -A NAME=([p]=p) KEY=([p]=p) LABEL=([p]=label-p)',
      'SLACK_STATE_DIR="$HOME/state" SCENARIO_SLACK_RECORD="$HOME/slack.jsonl" incomplete=channel-membership-inventory-incomplete',
      declaration(membershipRecovery, 'phase7_observe'), `PHASE7_CASE=${name} PHASE7_MARK=1 PHASE7_LOG_MARK=${Buffer.byteLength(old)}`, 'phase7_observe',
    ].join('\n')
    const quiet = shell(program("''"), files)
    expect({ status: quiet.status, stdout: quiet.stdout, stderr: quiet.stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
    const run = shell(program('first-authorization'), files)
    expect(run.stderr).toBe('')
    expect(run.stdout.trim().split('\n')).toEqual([
      'phase7-observe: case=first-authorization failed',
      'phase7-observe: lifecycle=credentials-refused count=1 at=2030-01-01T00:00:01.000Z',
      'phase7-observe: lifecycle=connection-lost count=0 at=none',
      'phase7-observe: lifecycle=connection-restored count=0 at=none',
      'phase7-observe: lifecycle=connected count=1 at=2030-01-01T00:00:02.000Z',
      'phase7-observe: lifecycle=disconnected count=0 at=none',
      'phase7-observe: lifecycle=dropped count=1 at=none',
      'phase7-observe: lifecycle=inventory-incomplete count=1 at=2030-01-01T00:00:04.000Z',
      'phase7-observe: lifecycle=inventory-complete count=0 at=none',
      'phase7-observe: stub ws-open seq=5 ts=invalid code=absent reason=absent hello=true',
      'phase7-observe: stub ws-close seq=2 ts=2030-01-01T00:00:01.000Z code=1000 reason=absent hello=absent',
      'phase7-observe: stub push-refused seq=3 ts=2030-01-01T00:00:02.000Z code=absent reason=no-open-socket hello=absent',
    ])
    expect(run.stdout).not.toContain(secret); expect(run.stdout).not.toContain(tok)
  })
  test('recovery accept_observe prints the acceptance journal\'s counts and whitelisted fields, never content', () => {
    const secret = 'private message text', tok = fakeToken(BOT_TOKEN_PREFIX, 'accept-observer')
    const hold = { on: 'post', operations: ['op-a'], thread_ts: '1.0', stamp: { incarnation: 1, threadHybridSince: 2 }, root_unknown: false, arrived_at: 10 }
    const files = {
      'state/queue/p.jsonl': jsonl([
        { v: 1, kind: 'accepted', seq: 1, compact: 'key', key: { channel: 'CX', ts: '0.5' }, received_at: 5, delivered_at: 6 },
        { v: 1, kind: 'accepted', seq: 2, source: 'slack', channel: 'CX', ts: '1.5', via: 'thread', thread_ts: '1.0', user: 'U1', text: secret, received_at: 10, hold },
        { v: 1, kind: 'released', seq: 2, at: 13 },
        { v: 1, kind: 'sent', seq: 2, attempt: 1, part: 1, send_kind: 'text', at: 14, session_id: 's1', transcript_path: `/w/${secret}`, transcript_size: 3 },
        { v: 1, kind: 'accepted', seq: 3, source: 'slack', channel: 'CY', ts: '1.5', via: tok, text: secret, received_at: 11 },
      ]) + '{"v":1,"kind":"acc',
    }
    const program = (who: string, via: string) => [
      'SLACK_STATE_DIR="$HOME/state"', 'declare -A KEY=([p]=p [q]=q)', declaration(recovery, 'accept_observe'), `accept_observe ${who} CX 1.5 '${via}'`,
    ].join('\n')
    const run = shell(program('p', 'thread'), files)
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' })
    const tail = [
      'accept-observe: tail kind=accepted seq=1 compact=key channel=absent ts=absent via=absent hold=absent',
      'accept-observe: tail kind=accepted seq=2 compact=absent channel=CX ts=1.5 via=thread hold=post',
      'accept-observe: tail kind=released seq=2 compact=absent channel=absent ts=absent via=absent hold=absent',
      'accept-observe: tail kind=sent seq=2 compact=absent channel=absent ts=absent via=absent hold=absent',
      'accept-observe: tail kind=accepted seq=3 compact=absent channel=CY ts=1.5 via=invalid hold=absent',
    ]
    const lines = (via: string, withVia: number) => [
      `accept-observe: persona=p channel=CX ts=1.5 via=${via || 'any'} failed`,
      'accept-observe: journal lines=6 records=5 compact=1 max_seq=3',
      `accept-observe: matching accepted=1 with_via=${withVia}`,
      'accept-observe: accepted seq=2 source=slack via=thread thread_ts=1.0 received_at=10 released_at=absent hold=post hold_root_unknown=false hold_operations=1 hold_arrived_at=10',
      'accept-observe: record kind=released seq=2 attempt=absent part=absent send_kind=absent at=13 unknown_outcome=absent',
      'accept-observe: record kind=sent seq=2 attempt=1 part=1 send_kind=text at=14 unknown_outcome=absent',
      ...tail,
    ]
    expect(run.stdout.trim().split('\n')).toEqual(lines('thread', 1))
    expect(run.stdout).not.toContain(secret); expect(run.stdout).not.toContain(tok); expect(run.stdout).not.toContain('op-a')
    expect(shell(program('p', 'mention'), files).stdout.trim().split('\n')).toEqual(lines('mention', 0))
    expect(shell(program('p', ''), files).stdout.trim().split('\n')).toEqual(lines('', 1))
    const absent = shell(program('q', 'thread'), files)
    expect({ status: absent.status, stdout: absent.stdout, stderr: absent.stderr }).toEqual({ status: 0, stderr: '',
      stdout: 'accept-observe: persona=q channel=CX ts=1.5 via=thread failed\naccept-observe: journal=absent\n' })
  })
  test.each([['ok', 0], ['timeout', 1], ['timeout, observer error', 1]] as const)(
    'recovery accepted keeps wait_until\'s check, poll and failure text, and prints the journal only at the timeout: %s', (outcome, status) => {
      const stubs = (poll: string) => [
        '_scenario_check_timeout() { printf "check %s|%s\\n" "$1" "$2"; }',
        `_scenario_poll_until() { printf "poll %s\\n" "$*"; [[ ${poll} == ok ]]; }`,
      ]
      const program = [
        ...stubs(`'${outcome}'`),
        `accept_observe() { printf "observe %s\\n" "$*"; [[ '${outcome}' != *error ]]; }`,
        'shared_delivery_expectation() { printf "expectation %s\\n" "$*"; }',
        'declare -A KEY=([p]=kp) NAME=([p]=np) INPUTS', 'EXPECTED="$HOME/expected" HUMAN=UH EVENT_WAIT_S=30',
        declaration(recovery, 'accepted'), 'accepted p CX 1.5 thread "the text" 1.0', 'printf "expected: %s\\n" "$(cat "$EXPECTED")"',
      ].join('\n')
      const run = shell(program)
      // wait_until itself, given the same step, timeout and predicate.
      const reference = shell([...stubs("'timeout'"), declaration(scenario, 'wait_until'),
        "wait_until 30 'expected one acceptance' queued p CX 1.5 thread"].join('\n'))
      expect(reference.stdout).toBe('check 30|expected one acceptance\npoll 30 queued p CX 1.5 thread\n')
      expect(run.status).toBe(status)
      if (outcome === 'ok') {
        expect(run.stderr).toBe('')
        expect(run.stdout).toBe(reference.stdout + 'expected: expectation kp np slack CX 1.5 UH thread\n')
      } else {
        expect(run.stderr).toBe(reference.stderr)
        expect(run.stdout).toBe(reference.stdout + 'observe p CX 1.5 thread\n')
      }
    })
  test('recovery retain declares every channel the input lists for the persona, as written, and fails on none', () => {
    const config = JSON.stringify({ personas: [
      { name: 'p', channels: [{ id: 'CA', delivery: 'all' }, { id: 'CB', delivery: 'thread_hybrid' }, { id: 'CN', delivery: 'mentions' }] },
      { name: 'q', channels: [{ id: 'CA', delivery: 'off' }] },
      { name: 'r', channels: [] },
    ] })
    const program = (name: string) => ['CONFIG="$HOME/config.json"', declaration(recovery, 'retain'), `retain ${name}`, 'printf "%s\\n" "${RETAIN[@]}"'].join('\n')
    const run = shell(program('p'), { 'config.json': config })
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stderr: '', stdout: 'p/CA/all\np/CB/thread_hybrid\np/CN/mentions\n' })
    for (const name of ['r', 'absent']) {
      const none = shell(program(name), { 'config.json': config })
      expect({ status: none.status, stdout: none.stdout, stderr: none.stderr }).toEqual({ status: 1, stdout: '', stderr: `no configured channel to retain for ${name}\n` })
    }
  })
  // The recovery helper's real pending_post and lose_post build the faults through
  // scenario.sh's real control helpers; pending_post's other steps are
  // stand-ins. The real stub answers a real Web client with the production
  // long-lived options, only its per-attempt timeout and retry spacing
  // shortened (one retry): the library retries a timed-out attempt as a new
  // chat.postMessage, as it does after PERSONA_WEB_API_REQUEST_TIMEOUT_MS.
  test.each([[true, ''], [false, ''], [true, '100']] as const)(
    'recovery lose_post holds the Web client\'s retry of a lost post unperformed, so only the first attempt can settle it: performed=%p delay=%p', async (performed, delay) => {
      const options = longLivedWebClientOptions()
      expect([options.timeout, 'retryConfig' in options]).toEqual([PERSONA_WEB_API_REQUEST_TIMEOUT_MS, false])
      const channel = 'C0LOSTPOST01', stamp = '{"incarnation":"i1","threadHybridSince":"t1"}'
      const built = shell([
        'require_ci_image() { :; }', '_scenario_scratch_file() { :; }', '_scenario_stub_control_http() { :; }', 'write_file() { cat > "$1"; }',
        ...['_scenario_stub_control_patch', 'slack_stub_fault', 'slack_stub_post_lost', 'slack_stub_history_fault', 'slack_stub_faults_clear'].map(name => declaration(scenario, name)),
        `scenario_id() { echo ${channel}; }`, 'slack_stub_inventory_page() { :; }', 'slack_push_member_joined() { echo env-1; }', 'ack() { :; }',
        'scenario_ts() { echo 1.5; }', 'wait_membership_complete() { :; }', 'set_choice() { :; }', `stamp() { echo '${stamp}'; }`,
        `shared_own_post_records() { [[ ! -e "$HOME/posted" ]] || echo '{"kind":"post-intent","operationId":"op-1","channel":"${channel}","stamp":${stamp}}'; }`,
        'slack_post_mark() { echo 0; }', 'scenario_text() { echo "text-$1"; }', 'stub_session_submit() { : > "$HOME/posted"; echo call-1; }',
        'wait_until() { :; }', `record_after() { echo '[{"performed":${performed},"response_ts":"9.1"}]'; }`,
        `shared_persona_facts() { echo '{"incarnation":"i1","assignments":{"${channel}":{"threadHybridSince":"t1"}}}'; }`, 'shared_wait_own_post_state() { :; }',
        'declare -A LABEL=([p]=p) KEY=([p]=p) WORK=([p]=/w)', 'declare -a EXTRA_CHANNELS=()', 'A=CA B=CB NOTICE=CN EVIDENCE="$HOME" SCENARIO_SLACK_CONTROL="$HOME/control.json"',
        declaration(recovery, 'lose_post'), declaration(recovery, 'pending_post'), `pending_post lost ${performed} ${delay}`, 'cat "$SCENARIO_SLACK_CONTROL"',
      ].join('\n'), { 'control.json': JSON.stringify({ tokens: [{ label: 'p', suffix: 'lostp', auth: 'ok', connections: 'ok' }] }) + '\n' })
      expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
      mkdirSync('/tmp/c9', { recursive: true })
      const root = mkdtempSync('/tmp/c9/test46-lost-post-'), recordPath = join(root, 'record.jsonl')
      // The real client's output, its answer or error and every caught error
      // are leak-checked, on a failing assertion too.
      const captured: unknown[] = []
      try { const stub = startSlackStub({ recordPath, control: JSON.parse(built.stdout) }); try {
        const web = new WebClient(fakeToken(BOT_TOKEN_PREFIX, 'lostp'),
          { ...longLivedWebClientOptions(stub.apiUrl), timeout: 300, retryConfig: { retries: 1, minTimeout: 10, maxTimeout: 10 } })
        let answer: unknown
        const output = await outputDuringAsync(async () => {
          answer = await web.chat.postMessage({ channel, text: 'lost post' }).then(r => ({ ok: r.ok, ts: r.ts }), (e: Error) => { captured.push(e); return { error: e.message } })
        })
        captured.push(answer, output)
        // One library warning per timed-out attempt, so the scan sees real output.
        expect(output.filter(call => JSON.stringify(call.args).includes('http request failed'))).toHaveLength(delay ? 0 : 2)
        const posts = readFileSync(recordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.method === 'chat.postMessage')
        const history = await fetch(`${stub.apiUrl}conversations.history`, { method: 'POST', body: new URLSearchParams({ channel }),
          headers: { Authorization: `Bearer ${fakeToken(BOT_TOKEN_PREFIX, 'reader')}`, 'Content-Type': 'application/x-www-form-urlencoded' } }).then(r => r.json())
        captured.push(history)
        const first = posts[0]
        if (delay) {
          // The delayed answer comes inside the attempt: the first attempt's own post, no retry.
          expect(posts.map(r => [r.event, r.outcome ?? r.answer, r.performed ?? null])).toEqual([['fault', 'lost', true], ['api', 'ok', null]])
          expect(answer).toEqual({ ok: true, ts: first.response_ts })
        } else {
          // Each attempt times out unanswered: the retry is held and never performed.
          expect(posts.map(r => [r.event, r.fault_index, r.outcome, r.performed])).toEqual([['fault', 0, 'lost', performed], ['fault', 1, 'lost', false]])
          expect(answer).toEqual({ error: expect.stringContaining('timeout of 300ms exceeded') })
        }
        expect(history.messages.map((m: { ts: string }) => m.ts)).toEqual(performed ? [first.response_ts] : [])
      } catch (error) { captured.push(error); throw error } finally {
        try { await stub.stop() } catch (error) { captured.push(error); throw error }
      }
      } finally {
        try { assertNoLeak({ captured, record: existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : '' }) }
        finally { rmSync(root, { recursive: true, force: true }) }
      }
    })
  test('test-67 confirmed-unsaved\'s held answer comes 5 s inside the Web client\'s per-attempt timeout', () => {
    const delay = Number(/^pending_post confirmed-unsaved true (\d+)$/m.exec(identityRecovery)?.[1])
    expect(delay + 5000).toBeLessThanOrEqual(PERSONA_WEB_API_REQUEST_TIMEOUT_MS)
  })
  // The production lookup judges the situation Phase 13 builds: its live post,
  // with no parent, is P's only own message in range, and the behind-post
  // mention and broadcast joined its root. `found` records joined; `none`
  // and `lost` record none.
  test('test-66 Phase 13 expects the production lookup\'s outcome for its mention-joined live post: none, with the thread still joined', () => {
    const post = { ts: '1794561089.000002', digests: ['digest'], fileIds: [] }
    const judged = (joined: boolean) => judgeOwnPostLookup({ digest: 'digest', hasParent: false, own: [post], leftOut: ts => joined && ts === post.ts })
    expect(judged(false)).toEqual({ kind: 'found', ts: post.ts, holds: 'thread' })
    expect(judged(true)).toEqual({ kind: 'none', holds: 'none' })
    const fifo = block(ownPostRecovery, 'for route in all dm mention broadcast; do', 'inject_sender=')
    for (const route of ['mention', 'broadcast']) expect(fifo).toContain(route + ') channel="${OP_CHANNEL}"; parent="${OP_ROOT}"; via=' + route + ';')
    const restart = block(ownPostRecovery, "'restarted manual FIFO worker did not reconnect'", "'ordinary FIFO worker did not reconnect'")
    expect(restart).toContain('shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" none')
    expect(restart).not.toContain('"${OP_STAMP}" joined')
    expect(restart).toContain('root_saved p "${OP_CHANNEL}" "${OP_ROOT}" || fail')
  })
  // test-66's real newest_first against the production lookup's lost-join
  // threads, read from a history page ordered as the stub and Slack order it
  // (by numeric ts, newest first), whichever of Phase 18's two roots is newer.
  test.each([
    ['the seeded root is newer in the same second', '1794572342.001409', '1794572342.989009'],
    ['the post is newer in the same second', '1794572342.001409', '1794572342.000500'],
    ['the seeded root is a second later', '1794572342.989009', '1794572343.000100'],
  ] as const)('test-66 Phase 18 lists its lost roots in the lookup\'s history order: %s', (_name, opRoot, secondRoot) => {
    const history = [opRoot, secondRoot].sort((a, b) => Number(b) - Number(a))
    const judged = judgeOwnPostLookup({ digest: 'digest', hasParent: false, leftOut: () => false,
      own: history.map(ts => ({ ts, digests: ['digest'], fileIds: [] })) })
    expect(judged).toEqual({ kind: 'lost', reason: 'several', holds: 'none', threads: history })
    const run = shell([declaration(ownPostRecovery, 'newest_first'), `newest_first ${opRoot} ${secondRoot}`].join('\n'))
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: history.join(',') + '\n', stderr: '' })
    const phase = block(ownPostRecovery, 'pending_post ambiguous true', 'for root in "${OP_ROOT}" "${second_root}"; do')
    expect(phase).toContain('lost_roots="$(newest_first "${OP_ROOT}" "${second_root}")"')
    expect(phase.match(/"\$\{lost_roots\}" several/g)).toHaveLength(3)
    expect(phase).not.toContain('"${OP_ROOT},${second_root}"')
  })
  // test-47's real refused_start, queue_items_digest and state_digest, and
  // scenario.sh's real shared_queue_items over the production reader
  // (fmk-texts acceptedQueueItems: parseQueueRecord). Stand-ins replace only
  // the image guards, the printer's refusal texts, Slack, AD and the start
  // itself, whose effect on the case I 0.18.0 journal each case supplies.
  test.each([
    ['start compaction (watermark, allocation row, mode 0600)', 'if .kind == "accepted" then . + {attempt_high_watermark: 0} else . end', 0, ''],
    ['one accepted item dropped', 'select(.seq != 2) | if .kind == "accepted" then . + {attempt_high_watermark: 0} else . end', 1, 'interrupted: refused start changed accepted queue items\n'],
    ['one accepted item altered', 'if .seq == 2 then .text = "altered" else . end | if .kind == "accepted" then . + {attempt_high_watermark: 0} else . end', 1, 'interrupted: refused start changed accepted queue items\n'],
    ['another state file changed', '.', 1, 'interrupted: refused start changed state\n'],
  ] as const)('test-47 refused_start leaves queue journal bytes to start compaction and fails on any accepted item change: %s', (label, filter, status, stderr) => {
    mkdirSync('/tmp/c9', { recursive: true })
    const fixtures = mkdtempSync('/tmp/c9/refused-start-printer-')
    try {
      sharedPrinterControl(fixtures, join(fixtures, 'fmk-texts.ts'))
      const test47 = source('test-47-shared-channel-upgrade.sh')
      const journal = readFileSync(join(import.meta.dir, 'fixtures/shared-channel-upgrade/interrupted-and-invalid-preparation/reference-0.18.0/queue/alpha.jsonl'), 'utf8')
      const program = [
        'SLACK_STATE_DIR="$HOME/state" EVIDENCE="$HOME/evidence" CONFIG="$HOME/state/config.json" PRINTER=printer KEYS_ONLY=false REMOVED_SEEN=0',
        `SCENARIO_FIXTURES=${JSON.stringify(fixtures)} J="$HOME/state/queue/k_alpha.jsonl" FILTER='${filter}' OTHER=${label.startsWith('another') ? 1 : 0}`,
        'mkdir -p "$EVIDENCE"; declare -A P=([alpha]=k_alpha)',
        'require_ci_image() { :; }; require_scenario_state() { :; }; _scenario_scratch_file() { :; }',
        'bun() { if [[ "$2" == removedKeyRefusal ]]; then return 64; fi; command bun "$@"; }',
        'case_json() { echo config.json.last-applied; }; printed() { echo "refused: alpha"; }; rows_of() { ROWS=(alpha); }',
        'slack_post_mark() { echo 0; }; count_log() { echo 0; }; count_in() { echo 1; }; expect_count() { :; }; none_after() { :; }; no_session() { :; }',
        '_scenario_pid_file_live() { return 1; }; references_unchanged() { echo "references checked"; }',
        'cmp() { [[ "$1" == -s ]] && shift; [[ "$(cat "$1")" == "$(cat "$2")" ]]; }',
        // The refused start: its effect on the journal, an allocation row,
        // mode 0600 and a server.log line; OTHER also edits config.json.
        'run_start() {',
        '    START_RC=1 START_OUT="$HOME/start.out"; echo "refused: alpha" > "$START_OUT"',
        '    jq -c "$FILTER" "$J" > "$J.tmp"; echo \'{"v":1,"kind":"accepted","seq":2,"compact":"allocation"}\' >> "$J.tmp"; mv "$J.tmp" "$J"',
        '    python3 -c "import os,sys; os.chmod(sys.argv[1], 0o600)" "$J"; printf x >> "$SLACK_STATE_DIR/server.log"',
        '    if [[ "$OTHER" == 1 ]]; then printf " " >> "$CONFIG"; fi',
        '}',
        declaration(scenario, 'shared_queue_items'),
        ...['state_digest', 'queue_items_digest', 'refused_start'].map(name => declaration(test47, name)),
        'refused_start interrupted',
      ].join('\n')
      const run = shell(program, { 'state/config.json': '{}', 'state/server.log': '', 'state/queue/k_alpha.jsonl': journal })
      expect({ status: run.status, stderr: run.stderr }).toEqual({ status, stderr })
      expect(run.stdout).toBe(status ? '' : 'references checked\n')
    } finally { rmSync(fixtures, { recursive: true, force: true }) }
  })
  test('test-29 exit_observe prints the last queue rows, last hook records, AD row and controls as whitelisted fields only', () => {
    const secret = 'private message text', tok = fakeToken(BOT_TOKEN_PREFIX, 'exit-observer')
    const session = '0123abcd-0000-4000-8000-000000000001'
    const hook = (command: string, event: string, at: string, instance = 'cscb_alpha') => ({ command, event, instance_id: instance, session_id: 's1', pid: 4, at })
    const files = {
      'state/queue/alpha.jsonl': jsonl([{ kind: 'accepted', seq: 1, at: 1, text: secret }, { kind: 'sent', seq: 1, send_kind: 'text', at: 2 },
        { kind: 'sent', seq: 1, send_kind: 'enter', at: 3 }, { kind: 'delivered', seq: 1, at: 4 }, { kind: 'accepted', seq: 2, at: 5, text: secret },
        { kind: 'sent', seq: 2, send_kind: tok, at: 6 }, { kind: secret, seq: 2, at: 7 }]) + '{"kind":"sent",',
      'bin/stub-claude-hooks.s1.jsonl': jsonl([hook('receipt', 'Stop', '10.5'), hook('submitted', 'UserPromptSubmit', '12.0'),
        hook('receipt', 'Stop', '11.0', 'cscb_other'), hook(`say ${secret}`, 'Stop', '13.0')]),
      'bin/stub-claude-hooks.s2.jsonl': jsonl([hook('permission-1', 'PermissionRequest', '9.0'), hook('complete-1', 'Stop', '14.0'), hook('receipt', 'Stop', '15.0')]),
      [`bin/stub-claude-hooks.${session}`]: `receipt\npermission-1\n${secret}\n`,
    }
    const program = (observe: string) => [
      'printed() { [[ "$2" == alpha ]] || { echo "FAIL: printer" >&2; exit 1; }; printf "cscb_%s\\n" "$2"; }',
      'timeout() { [[ "$1" == 10 ]] || return 99; shift; "$@"; }',
      `agent-director() { [[ "$*" == "get --instance-id cscb_alpha" ]] || return 1; jq -nc --arg tok "${tok}" '{state:"waiting",session_id:"${session}",launch_started_at:"2030-01-01T00:00:00Z",last_seen_at:"2030-01-01T00:00:04Z",ended_at:null,updated_at:"2030-01-01T00:00:09Z",labels:{t:$tok},cwd:"${secret}"}'; }`,
      'ALPHA_KEY=alpha BRAVO_KEY=bravo ALPHA_DIR="$HOME/alpha-work" BRAVO_DIR="$HOME/bravo-work" STUB_BIN="$HOME/bin"',
      'declare -A DELIVERIES_FILE=(["$ALPHA_DIR"]="$HOME/state/queue/alpha.jsonl" ["$BRAVO_DIR"]="$HOME/state/queue/bravo.jsonl")',
      ...['ALPHA_ID', 'BRAVO_ID', 'OBSERVE_ROWS'].map(name => test29Script.match(new RegExp(`^${name}=.*$`, 'm'))![0]),
      test29Script.match(/^OBSERVE_SAFE='[\s\S]*?;'$/m)![0],
      declaration(test29Script, 'exit_observe'), `OBSERVE_ON_EXIT=${observe}`, 'exit_observe',
    ].join('\n')
    const quiet = shell(program('0'), files)
    expect({ status: quiet.status, stdout: quiet.stdout, stderr: quiet.stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
    const run = shell(program('1'), files)
    expect(run.stderr).toBe('')
    expect(run.stdout.trim().split('\n')).toEqual([
      'exit-observe: persona=alpha queue kind=sent seq=1 send_kind=enter at=3',
      'exit-observe: persona=alpha queue kind=delivered seq=1 send_kind=absent at=4',
      'exit-observe: persona=alpha queue kind=accepted seq=2 send_kind=absent at=5',
      'exit-observe: persona=alpha queue kind=sent seq=2 send_kind=invalid at=6',
      'exit-observe: persona=alpha queue kind=invalid seq=2 send_kind=absent at=7',
      'exit-observe: persona=alpha stub_hook command=receipt event=Stop session_id=s1 pid=4 at=10.5',
      'exit-observe: persona=alpha stub_hook command=submitted event=UserPromptSubmit session_id=s1 pid=4 at=12.0',
      'exit-observe: persona=alpha stub_hook command=invalid event=Stop session_id=s1 pid=4 at=13.0',
      'exit-observe: persona=alpha stub_hook command=complete-1 event=Stop session_id=s1 pid=4 at=14.0',
      'exit-observe: persona=alpha stub_hook command=receipt event=Stop session_id=s1 pid=4 at=15.0',
      `exit-observe: persona=alpha ad_state=waiting session_id=${session} launch_started_at=2030-01-01T00:00:00Z last_seen_at=2030-01-01T00:00:04Z ended_at=absent`,
      'exit-observe: persona=alpha control=receipt',
      'exit-observe: persona=alpha control=permission-1',
      'exit-observe: persona=alpha control=invalid',
      'exit-observe: persona=bravo queue=absent',
      'exit-observe: persona=bravo instance=unavailable',
    ])
    expect(run.stdout).not.toContain(secret); expect(run.stdout).not.toContain('cscb_other'); expect(run.stdout).not.toContain('updated_at')
    expect(run.stdout).not.toContain(tok)
  })
  // In a script file, a failure inside a call whose stdout is discarded runs
  // the exit hooks with that stdout (as the scenario's cleanup runs them, in a
  // subshell each); test-29 registers its dump through the stderr wrapper.
  test.each([['exit_observe_stderr', 'printer refused\nexit-observe: dump\n'], ['exit_observe', 'printer refused\n']] as const)(
    'test-29 exit dump survives a failure under a discarded stdout: %s', (hook, stderr) => {
      expect(test29Script).toMatch(/^on_before_cleanup exit_observe_stderr$/m)
      const run = shell('bash "$HOME/case.sh"', { 'case.sh': [
        'set -euo pipefail', 'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
        'exit_observe() { printf "exit-observe: dump\\n"; }', test29Script.match(/^exit_observe_stderr\(\) \{.*\}$/m)![0],
        `cleanup() { trap - EXIT; ( ${hook} ); }`, 'trap cleanup EXIT',
        'discarded() { fail "printer refused"; }', 'discarded > /dev/null', '',
      ].join('\n') })
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 1, stdout: '', stderr })
    })
  // test-29's real leave steps, review_replaced and expect_stale_review. The
  // stand-in server applies the leave on its ACK and, when pending, lands the
  // staged rescan at its next chance: the rescan wait, or the stale
  // confirmation's reload tick. The rescan rewrites what
  // sharedApplicationPreserved compares (the left channel's
  // isExtSharedChannel), here the stand-in record's bytes. Its reload check
  // observes the leave, replacing the captured review, only while the script
  // waits for that replacement: the allowed schedule in which no check falls
  // between the leave and the cancel. A cancel published before that check
  // would be observed with the leave in one supersession, which keeps the
  // captured outcome, so the stale line the leave case expects would not be
  // certain. The stale check runs after the cancel, expects the stale line and
  // rules out the superseded one.
  const leaveSteps = block(test29Script, '        member_unlist alpha "${channel}"', '        if [[ "${mode}" == open ]]; then')
  const rescanWait = '        wait_membership_rescan "${ALPHA}" "${ALPHA_LABEL}" "$(slack_stub_record_field seq push "envelope_id=${first}")"\n'
  const supersessionWait = '        wait_until "${APPLY_WAIT_S}" \'leave did not supersede the captured review\' \\\n' +
    '            review_replaced "${CAPTURED}/leave-preview-${mode}-${value}.pending"\n'
  test.each([
    ['pending', 'with both waits', 0, ''],
    ['pending', 'without the rescan wait', 1, 'leave-stale-open-off: stale confirmation changed applied facts\n'],
    ['landed', 'with both waits', 0, ''],
    ['landed', 'without the rescan wait', 0, ''],
    ['landed', 'without the supersession wait', 1, 'leave-cancel-open-off: cancel published before a reload check observed the leave\n'],
  ] as const)('test-29 leave lets its staged rescan land, and its supersession be observed before the cancel, ahead of the stale check: rescan %s, %s', (rescan, variant, status, stderr) => {
    expect(leaveSteps.split(rescanWait)).toHaveLength(2)
    expect(leaveSteps.split(supersessionWait)).toHaveLength(2)
    expect(leaveSteps).toContain('expect_stale_review "leave-stale-${mode}-${value}" "${CAPTURED}/leave-preview-${mode}-${value}.pending" dropped\n')
    const steps = variant === 'without the rescan wait' ? leaveSteps.replace(rescanWait, '') :
      variant === 'without the supersession wait' ? leaveSteps.replace(supersessionWait, '') : leaveSteps
    const run = shell([
      'CONFIG="$HOME/config.json" LAST="$HOME/config.json.last-applied" APPLY="$HOME/config.json.apply" PENDING="$HOME/config.json.pending" CAPTURED="$HOME/captured"',
      'ALPHA=t29_alpha ALPHA_LABEL=alpha ALPHA_KEY=k_alpha BRAVO_KEY=k_bravo M_HYBRID=CHYBRID EVENT_WAIT_S=15 APPLY_WAIT_S=20',
      `SUPERSEDED_OUTCOME=superseded STALE_CONFIRMATION=stale RESCAN=${rescan} mode=open value=off channel=CLEFT`, 'declare -A LEAVE_ENVELOPES=()',
      'mkdir -p "$CAPTURED"; printf "header\\nfingerprint: captured\\n" > "$CAPTURED/leave-preview-open-off.pending"',
      'cp -- "$CAPTURED/leave-preview-open-off.pending" "$PENDING"; printf "member ext=false\\n" > "$LAST"',
      'land_rescan() { [[ -e "$HOME/rescan-due" ]] || return 0; printf "left ext=absent\\n" > "$LAST"; rm "$HOME/rescan-due"; }',
      'reload_check() { [[ -e "$HOME/leave-unobserved" ]] || return 0; printf "header\\nfingerprint: after-leave\\n" > "$PENDING"; rm "$HOME/leave-unobserved"; }',
      'member_unlist() { :; }', 'scenario_ts() { echo 1.1; }', 'slack_push_channel_left() { echo env-left; }',
      'ack_control() { [[ "$1" == env-left ]] || return 1; printf "left ext=false\\n" > "$LAST"; touch "$HOME/rescan-due" "$HOME/leave-unobserved"; [[ "$RESCAN" == pending ]] || land_rescan; }',
      'wait_until() { shift 2; [[ "$1" != review_replaced ]] || reload_check; "$@"; }',
      'choice_is() { [[ "$3" == "" ]]; }', 'shared_thread_since() { :; }', 'channel_facts() { echo "facts $1 $2"; }',
      'slack_stub_record_field() { [[ "$*" == "seq push envelope_id=env-left" ]] || return 1; echo 41; }',
      'wait_membership_rescan() { printf "%s\\n" "$*" >> "$HOME/waits"; land_rescan; }',
      'configuration_request() { [[ "$*" == "leave-cancel-open-off cancel" ]] || return 1; [[ ! -e "$HOME/leave-unobserved" ]] || fail "$1: cancel published before a reload check observed the leave"; touch "$HOME/cancelled"; }',
      'wait_since() { [[ -e "$HOME/cancelled" && "$2" == "$STALE_CONFIRMATION" ]] || return 1; land_rescan; mv -- "$APPLY" "$HOME/spent"; }',
      'expect_since() { [[ "$2" == "$SUPERSEDED_OUTCOME" && "$3" == 0 ]]; }',
      'configuration_application_preserved() { cmp -s "$2" "$3"; }',
      declaration(test29Script, 'log_mark'), declaration(test29Script, 'review_replaced'), declaration(test29Script, 'expect_stale_review'),
      'sibling="$(channel_facts "${BRAVO_KEY}" "${channel}")"; before="$(channel_facts "${ALPHA_KEY}" "${M_HYBRID}")"',
      steps, 'cat "$HOME/waits" 2> /dev/null || true', 'cat "$LAST"', 'sed -n 2p "$PENDING"', 'cat "$HOME/spent"',
    ].join('\n'))
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status, stderr })
    if (status) return
    expect(run.stdout).toBe((variant === 'with both waits' ? 't29_alpha alpha 41\n' : '') +
      'left ext=absent\nfingerprint: after-leave\nheader\nfingerprint: captured\n')
  })
  // test-29's real DM enable in own_posts_phase, with the real input_has and
  // edit_input. The stand-in review fails as the server's reload-noop does when
  // the confirmed input equals the applied one.
  const dmEnable = block(test29Script, '    name="$(if [[ "${q}" == alpha ]]', '    successful_tool "${mode}-own-dm"')
  const unguarded = dmEnable.replace(/^ {4}if ! input_has .*; then\n/m, '').replace(/^ {4}fi\n/m, '')
  test.each([
    ['bravo', 'UCONTACT', 'guarded', 0, '', [], { enabled: true, contact: 'UCONTACT' }],
    ['bravo', 'UCONTACT', 'unguarded', 1, 'open-enable-dm: confirmation did not apply (reload-noop)\n', [], { enabled: true, contact: 'UCONTACT' }],
    ['bravo', 'UOTHER', 'guarded', 0, '', ['open-enable-dm'], { enabled: true, contact: 'UCONTACT' }],
    ['alpha', '', 'guarded', 0, '', ['open-enable-dm'], { enabled: true, contact: 'UCONTACT' }],
  ] as const)('test-29 reviews a DM enable only when the input changes: %s contact=%s %s', (q, contact, form, status, stderr, reviews, dm) => {
    expect(unguarded.length).toBeLessThan(dmEnable.length)
    const config = { personas: [{ name: 't29_alpha', dm: { enabled: false } },
      { name: 't29_bravo', dm: contact ? { enabled: true, contact } : { enabled: false } }] }
    const run = shell([
      'CONFIG="$HOME/config.json" ALPHA=t29_alpha BRAVO=t29_bravo CONTACT=UCONTACT mode=open', `q=${q}`, 'cp -- "$CONFIG" "$HOME/applied.json"',
      'review_assign() { printf "%s\\n" "$*" >> "$HOME/reviews"; [[ "$(jq -cS . "$CONFIG")" != "$(jq -cS . "$HOME/applied.json")" ]] || fail "$1: confirmation did not apply (reload-noop)"; cp -- "$CONFIG" "$HOME/applied.json"; }',
      declaration(test29Script, 'edit_input'), test29Script.match(/^input_has\(\) \{.*\}$/m)![0],
      form === 'guarded' ? dmEnable : unguarded,
      'cat "$HOME/reviews" 2> /dev/null || true', `jq -c --arg who "t29_${q}" '.personas[]|select(.name==$who)|.dm' "$CONFIG"`,
    ].join('\n'), { 'config.json': JSON.stringify(config) })
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status, stderr })
    if (status) return
    expect(run.stdout.trim().split('\n')).toEqual([...reviews, JSON.stringify(dm)])
  })
  // test-29's real write_persona_config, read by the production parser. A
  // persona without the opt-out inherits reminders on, and each nudge takes a
  // manual receipt release meant for a real item.
  // Its heredoc's closing brace sits in column 0, so it ends at the next section.
  const personaConfig = block(test29Script, 'write_persona_config() {', '\n\n# --- Start')
  const optOut = /^ {6}"stop_hook_bootstrap": false,\n/gm
  const personaConfigSetup = [
    'CONFIG="$HOME/config.json" ALPHA=t29_alpha BRAVO=t29_bravo ALPHA_CREDS="$HOME/alpha.json" BRAVO_CREDS="$HOME/bravo.json"',
    'ALPHA_DIR="$HOME/alpha" BRAVO_DIR="$HOME/bravo" CONTACT=UCONTACT SWITCH_KEY=channel_mode SCENARIO_PORT=3999 MCP_CONFIG="$HOME/mcp.json"',
    'A1=CA1 A2=CA2 B1=CB1 T1=CT1 N1=CN1 N2=CN2 N3=CN3 F1=CF1 F2=GF2 U1=CU1 M_OFF=CMOFF M_MENTIONS=CMMENTIONS M_ALL=CMALL M_HYBRID=CMHYBRID WRITE_CHANNEL=CWRITE FUTURE=CFUTURE',
    'write_config() { cat > "$CONFIG"; }',
    declaration(test29Script, 'edit_input'), test29Script.match(/^input_has\(\) \{.*\}$/m)![0], declaration(test29Script, 'input_choice'),
  ]
  test.each((['strict-upgrade', 'open', 'switch-off'] as const).flatMap(shape => (['with', 'without'] as const).map(form => [shape, form] as const)))(
    'test-29 written config turns reply reminders off for both personas: %s, %s the opt-out', (shape, form) => {
      expect(personaConfig.match(optOut)).toHaveLength(2)
      const ready = shape === 'strict-upgrade' ? 'false' : 'true'
      const run = shell([
        ...personaConfigSetup, `ALPHA_THREADS=${ready} MATRIX_READY=${ready}`,
        form === 'with' ? personaConfig : personaConfig.replace(optOut, ''),
        `write_persona_config ${shape}`, 'cat "$CONFIG"',
      ].join('\n'))
      assertNoLeak([run.stdout, run.stderr])
      expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' })
      const config = parsePersonaConfigBytes(run.stdout, '/scratch/config.json', '/scratch')
      expect(config.personas.map(p => [p.name, p.stop_hook_bootstrap])).toEqual([['t29_alpha', form === 'without'], ['t29_bravo', form === 'without']])
    })
  // test-29's real permission_post destination step, notice_phase destination
  // step and destination_post_matrix back-edit (set_composed_choice,
  // edit_destination, input_has, input_choice, edit_input) over bravo's real
  // open-shape input. The stand-in review reads the input with the production
  // parser, as configuration_request's printer does, then saves its gestures;
  // the stand-in tool saves its value. The old step (909132aa's permission_post
  // edit) points permission_prompts at an unlisted channel, which the parser
  // refuses.
  const destinationStep = block(test29Script, '    set_composed_choice "${mode}" "${q}" "${DEST}" "${value}" "${mode}-prompt-${number}-${value}"', '    wait_queue_drained "${dir}"')
  const noticeStep = block(test29Script, '    set_composed_choice "${mode}" "${q}" "${DEST}" "${value}" "${phase}-own-value"', '    wait_queue_drained "${ALPHA_DIR}"')
  const backEdit = test29Script.match(/^ {12}edit_destination "\$\{qname\}" "\$\{qkey\}" .*$/m)![0]
  const oldDestination = [
    '    if ! input_has --arg who "${name}" --arg dest "${DEST}" \'.personas[]|select(.name==$who)|.permission_prompts==$dest\'; then',
    '        edit_input --arg who "${name}" --arg dest "${DEST}" \'(.personas[]|select(.name==$who)|.permission_prompts)=$dest\'',
    '        review_assign "${mode}-prompt-destination-${number}"', '    fi', '',
  ].join('\n')
  const parser = [`import { parsePersonaConfigBytes } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'config.ts'))}`,
    "import { readFileSync } from 'node:fs'",
    'try { parsePersonaConfigBytes(readFileSync(process.argv[2]!), process.argv[2]!, process.argv[3]!) }',
    'catch (error) { process.stderr.write(`${(error as Error).message}\\n`); process.exit(1) }', ''].join('\n')
  test.each([
    ['permission', 'old step', 1, []],
    ['permission', 'fixed step', 0, ['bot open-prompt-1-off off', 'review open-prompt-destination-1 t29_bravo/CDEST/off',
      'review open-prompt-2-thread_hybrid t29_bravo/CDEST/thread_hybrid', 'review open-prompt-destination-dm', 'review open-prompt-destination-back']],
    ['notice', 'fixed step', 0, ['review open-notice-off-own-value t29_bravo/CDEST/off', 'review open-notice-off-destination',
      'review open-notice-thread_hybrid-own-value t29_bravo/CDEST/thread_hybrid']],
  ] as const)('test-29 open destination steps list DEST in bravo\'s input: %s, %s', (steps, form, status, calls) => {
    expect(destinationStep.split('\n')).toHaveLength(3)
    const program = steps === 'notice' ? [
      // As the strict phases leave it: DEST listed at its saved value.
      'input_choice "$BRAVO" CDEST all; printf "all\\n" > "$HOME/saved.k_bravo.CDEST"',
      'notice() { local q=bravo value="$1" phase="open-notice-$1" dir key name="$BRAVO"', 'thread_persona "$q"; dir="$THREAD_DIR"; key="$THREAD_KEY"', noticeStep, '}',
      'notice off', 'notice thread_hybrid',
    ] : [
      // own_posts_phase's tool-stored choice, with DEST still unlisted.
      'printf "thread_hybrid\\n" > "$HOME/saved.k_bravo.CDEST"',
      'post() { local q=bravo number="$1" value="$2" dir key name="$BRAVO"', 'thread_persona "$q"; dir="$THREAD_DIR"; key="$THREAD_KEY"',
      form === 'old step' ? destinationStep.replace(/^ {4}edit_destination .*\n/m, oldDestination) : destinationStep, '}',
      'post 1 off', 'post 2 thread_hybrid', 'qname="$BRAVO" qkey="$BRAVO_KEY" kind=prompt',
      'edit_input --arg who "$qname" \'(.personas[]|select(.name==$who)|.permission_prompts)="dm"\'', 'review_assign "${mode}-${kind}-destination-dm"', backEdit,
    ]
    const run = shell([
      ...personaConfigSetup, 'ALPHA_THREADS=false MATRIX_READY=false', personaConfig, 'write_persona_config open',
      'ALPHA_KEY=k_alpha BRAVO_KEY=k_bravo ALPHA_BOT_USER=UALPHA BRAVO_BOT_USER=UBRAVO ALPHA_REF=alpha BRAVO_REF=bravo DEST=CDEST mode=open',
      declaration(test29Script, 'thread_persona'),
      'attempt_args() { printf "%s\\n" "$2"; }',
      'expect_attempt() { printf "bot %s %s\\n" "$1" "$5" >> "$HOME/calls"; printf "%s\\n" "$5" > "$HOME/saved.$4.$3"; }',
      'shared_channel_saved() { cat "$HOME/saved.$1.$2" 2> /dev/null || true; }',
      'review_assign() {', '    local step="$1" gesture name channel value; shift', '    printf "review %s%s\\n" "$step" "${*:+ $*}" >> "$HOME/calls"',
      '    bun "$HOME/parser.ts" "$CONFIG" "$HOME" || fail "$step: cannot build the operator request"',
      '    for gesture in "$@"; do IFS=/ read -r name channel value <<< "$gesture"; printf "%s\\n" "$value" > "$HOME/saved.k_${name#t29_}.$channel"; done', '}',
      ...['set_composed_choice', 'edit_destination'].map(name => declaration(test29Script, name)),
      ...program,
      'cat "$HOME/calls"', 'jq -c \'.personas[1]|{permission_prompts,dm,listed:[.channels[]|select(.id=="CDEST")]}\' "$CONFIG"', 'cat "$HOME/saved.k_bravo.CDEST"',
    ].join('\n'), { 'parser.ts': parser })
    assertNoLeak([run.stdout, run.stderr])
    expect(run.status).toBe(status)
    if (status) {
      expect(run.stderr).toContain("permission_prompts names channel CDEST, which is not in the persona's channels.")
      expect(run.stderr).toEndWith('open-prompt-destination-1: cannot build the operator request\n')
      return
    }
    expect(run.stderr).toBe('')
    expect(run.stdout.trim().split('\n')).toEqual([...calls,
      JSON.stringify({ permission_prompts: 'CDEST', dm: { enabled: true, contact: 'UCONTACT' }, listed: [{ id: 'CDEST', delivery: 'thread_hybrid' }] }), 'thread_hybrid'])
  })
  // test-29's real confirm_review, its omit-member call and its NOOP_CLASS. The
  // stand-in server consumes the confirmed review and logs reload-noop for no
  // effective change and reload-applied otherwise, as src/reload.ts does; an
  // omission is no effective change. `both` logs the two, which production never
  // does, to reach the applied-count check.
  const omitConfirm = test29Script.match(/^ {4}confirm_review omit-member .*$/m)![0]
  const noopClass = test29Script.match(/^NOOP_CLASS=.*$/m)![0]
  test.each([
    ['omit-member', omitConfirm, 'noop', 0, ''],
    ['omit-member', '    confirm_review omit-member', 'noop', 1, 'omit-member: confirmation did not apply\n'],
    ['omit-member', omitConfirm, 'applied', 1, 'omit-member: confirmation was not a no-op\n'],
    ['omit-member', omitConfirm, 'both', 1, 'omit-member: a no-op confirmation applied a change\n'],
    ['applying review', '    confirm_review same-operator', 'applied', 0, ''],
  ] as const)('test-29 confirms a review with no effective change by its reload-noop line: %s, %s', (_name, call, effect, status, stderr) => {
    expect(noopClass).toBe(`NOOP_CLASS='[slack] ${RELOAD_NOOP}:'`)
    const run = shell([
      'CONFIG="$HOME/config.json" LAST="$HOME/last" PENDING="$HOME/pending" APPLY="$HOME/apply" CAPTURED="$HOME/captured" PRINTER=printer.ts',
      `APPLY_WAIT_S=20 APPLIED_CLASS=applied EFFECT=${effect}`, noopClass,
      'mkdir -p "$CAPTURED"; printf "review\\n" > "$PENDING"; printf "0\\n" > "$HOME/applied"; printf "0\\n" > "$HOME/noop"',
      'count_log() { case "$1" in "$APPLIED_CLASS") cat "$HOME/applied" ;; "$NOOP_CLASS") cat "$HOME/noop" ;; *) return 1 ;; esac; }',
      'check_pending_layout() { :; }', 'configuration_record_matches() { :; }',
      'serve() { [[ -e "$APPLY" ]] || return 0; rm -- "$APPLY"; touch "$HOME/consumed"',
      '    [[ "$EFFECT" == applied ]] || printf "1\\n" > "$HOME/noop"; [[ "$EFFECT" == noop ]] || printf "1\\n" > "$HOME/applied"; }',
      'wait_for_count() { serve; (( $(count_log "$1") >= $2 )) || fail "$4"; }', 'wait_until() { serve; shift 2; "$@"; }',
      'bun() { [[ "$2" == sharedReviewConsumed && -e "$HOME/consumed" && "$5" == "$CAPTURED/"*.pending ]]; }',
      declaration(test29Script, 'capture_review'), declaration(test29Script, 'confirm_review'), call,
      'printf "applied=%s noop=%s\\n" "$(cat "$HOME/applied")" "$(cat "$HOME/noop")"',
    ].join('\n'))
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status, stderr })
    if (!status) expect(run.stdout).toBe(effect === 'noop' ? 'applied=0 noop=1\n' : 'applied=1 noop=0\n')
  })
  // test-29's ineligible step pushes its joined-thread reply with Slack's
  // external-sharing flag set, as the channel now is. Open mode refuses that
  // flag before membership (decideDelivery), and routing logs the refusal as
  // an unclaimed-channel line (logDrop), never a channel-ineligible drop. The
  // stand-in log holds the production line; the step's real wait reads it.
  const externalWait = test29Script.match(/^ {4}wait_since "\$\{mark\}" "\$\{unclaimed\}" .*$/m)![0]
  const externalReply = block(test29Script, '    unclaimed="$(persona_line "${UNCLAIMED_CHANNEL}"', '    expect_queued external-joined-reply')
  const reply = (flag: boolean) => decideDelivery(
    { type: 'message', channel: 'CEXTERNAL', channel_type: 'channel', user: 'UHUMAN', text: 'plain', ts: '1700000001.000002', thread_ts: '1700000001.000001' },
    { key: 'k_alpha', botUserId: 'UALPHA', botId: 'BALPHA', channels: [], dmEnabled: false }, [{ key: 'k_alpha', channels: [] }],
    { mode: 'open', channelIdPattern: CHANNEL_ID_RE, isExtSharedChannel: flag, storedChoices: { readable: true, storedChoice: () => 'thread_hybrid' },
      memberships: new Map([['k_alpha', { kind: 'ineligible', reason: 'external-sharing' } as const]]) })
  test.each([
    ['fixed step', externalReply, 0, ''],
    // 909132aa's wait.
    ['old step', externalReply.replace(externalWait,
      '    wait_since "${mark}" "$(plain_drop "${ALPHA_REF}" "${EXTERNAL}" channel-ineligible)" "${EVENT_WAIT_S}" \'external joined reply was not excluded\''),
    1, 'external joined reply was not excluded\n'],
  ] as const)('test-29 waits for the external joined reply\'s refusal line: %s', (_form, steps, status, stderr) => {
    expect(reply(true)).toEqual({ action: 'drop', reason: 'open-refused', refusal: 'externally-shared' })
    expect(reply(false)).toEqual({ action: 'drop', reason: 'channel-ineligible' })
    const cause = fungibleUnclaimedChannelCause('CEXTERNAL', 'externally-shared')
    const logged = formatPersonaDiagnostic({ class: UNCLAIMED_CHANNEL, name: 't29_alpha', key: 'k_alpha', index: 0, cause })
    const run = shell([
      'SLACK_STATE_DIR="$HOME/state" EXTERNAL=CEXTERNAL ALPHA_REF=\'"t29_alpha" (key=k_alpha)\' UNCLAIMED_CHANNEL=unclaimed-channel REFUSAL_EXTERNALLY_SHARED=externally-shared',
      'EVENT_WAIT_S=15 HUMAN=UHUMAN root=1700000001.000001 SCENARIO_SEP=$\'\\x1f\'', 'mkdir -p "$SLACK_STATE_DIR"; printf "earlier\\n" > "$SLACK_STATE_DIR/server.log"',
      'printed() { [[ "$*" == "fungibleUnclaimedChannelCause CEXTERNAL externally-shared" ]] || return 1; cat "$HOME/cause.txt"; }',
      'persona_line() { [[ "$1|$2|$3" == "unclaimed-channel|alpha|$(cat "$HOME/cause.txt")" ]] || return 1; cat "$HOME/logged.txt"; }',
      'new_ts() { PUSH_TS=1700000001.000002; }', 'plain_text() { echo plain; }', 'slack_reply_event() { printf "%s\\n" "$*"; }',
      // The stand-in server logs the production line for a flagged reply.
      'push_event() { [[ "$1 $3" == "alpha true" ]] || return 1; cat "$HOME/logged.txt" >> "$SLACK_STATE_DIR/server.log"; }',
      'wait_until() { local step="$2"; shift 2; "$@" || fail "$step"; }',
      // _scenario_scan's count: every fragment, in order, on one line after the mark.
      'count_since_at_least() { local line rest frag n=0 ok; local -a frags; IFS=$\'\\x1f\' read -r -a frags <<< "$2"',
      '    while IFS= read -r line; do rest="$line"; ok=1',
      '        for frag in "${frags[@]}"; do [[ "$rest" == *"$frag"* ]] || { ok=0; break; }; rest="${rest#*"$frag"}"; done',
      '        (( ok == 0 )) || n=$(( n + 1 ))', '    done < <(tail -n "+$(( $1 + 1 ))" "$SLACK_STATE_DIR/server.log"); (( n >= $3 )); }',
      declaration(scenario, 'matcher'), declaration(test29Script, 'plain_drop'), declaration(test29Script, 'log_mark'), declaration(test29Script, 'wait_since'),
      steps,
    ].join('\n'), { 'cause.txt': cause + '\n', 'logged.txt': logged + '\n' })
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status, stderr })
  })
  // test-29's unverified case waits three times for a stub control: the socket
  // close, the reconnect's delayed inventory request and that request's settled
  // record. The real record readers (lib/scenario.sh) and the fake-clock poll;
  // a stand-in sleep writes the wait's record during the second sleep, so the
  // third poll is the first to see it, as the stub writes it only once the
  // control fires. The old step is 909132aa's wait: the same line polling
  // slack_stub_control_fired, which fails the script on the first empty poll.
  const controlWaits = test29Script.match(/^ {4}wait_until \S+ '[^']*' control_fired .*$/gm)!
  const controlRecords: Record<string, string> = {
    'socket-close': '{"seq":2,"event":"socket-close","label":"alpha"}',
    fault: '{"seq":2,"event":"fault","label":"alpha","method":"users.conversations","outcome":"delay","request_id":"r1"}',
    'fault-settled': '{"seq":2,"event":"fault-settled","request_id":"r1","resolution":"delay"}',
  }
  type ControlCase = [event: string, form: string, fires: boolean, status: number, stderr: string]
  const controlCases: ControlCase[] = [
    ...Object.keys(controlRecords).flatMap((event): ControlCase[] => [
      [event, 'fixed step', true, 0, ''], [event, 'old step', true, 1, 'the requested control has no fired record\n'],
    ]),
    ['fault', 'fixed step, never fired', false, 1, 'inventory delay did not fire (not within 3s)\n'],
  ]
  test.each(controlCases)(
    'test-29 polls a stub control until it fires: %s, %s', (event, form, fires, status, stderr) => {
      expect(controlWaits).toHaveLength(3)
      const fixed = controlWaits.find(line => line.includes(` control_fired ${event} `))!
      const run = shell([
        polling, 'RECORD_WAIT_S=3 SCENARIO_SLACK_RECORD="$HOME/record.jsonl" request_id=r1', `FIRES=${fires}`,
        'printf \'{"seq":1,"event":"ws-open","label":"alpha"}\\n\' > "$SCENARIO_SLACK_RECORD"',
        'sleep() { local now; read -r now < "$HOME/clock"; printf "%s\\n" "$((now+1000))" > "$HOME/clock"',
        '    [[ "$FIRES" == true && "$now" == 1000 ]] || return 0', '    cat "$HOME/fired.jsonl" >> "$SCENARIO_SLACK_RECORD"; }',
        'require_ci_image() { :; }',
        ...['_scenario_scratch_file', '_scenario_complete_jsonl', 'slack_stub_records', 'slack_stub_record_count', 'slack_stub_control_fired'].map(name => declaration(scenario, name)),
        test29Script.match(/^control_fired\(\) \{.*\}$/m)![0],
        form === 'old step' ? fixed.replace(' control_fired ', ' slack_stub_control_fired ') : fixed,
        'printf "after the wait at %s ms\\n" "$(cat "$HOME/clock")"',
      ].join('\n'), { 'fired.jsonl': controlRecords[event] + '\n' })
      expect({ status: run.status, stderr: run.stderr }).toEqual({ status, stderr })
      if (!status) expect(run.stdout).toBe('after the wait at 2000 ms\n')
    })
  // test-29's closing body check, its real function and heads. The heads are
  // pinned to the lines production builds: the event router's RAW line and the
  // delivery dispatch line. A body on those timestamped lines alone passes; on
  // any other log line, an unstamped line, in a captured result, or past a head
  // that is not the line's start, it fails, as with the old check on every line.
  const bodyCheck = declaration(test29Script, 'body_sentinels_absent')
  const bodyHeads = test29Script.match(/^BODY_LINE_HEADS=.*$/m)![0]
  const oldBodyCheck = [
    '# 909132aa\'s check.', 'body_sentinels_absent() {',
    '    python3 - "$1" "$2" "$3" <<\'PY\'', 'import json, pathlib, sys',
    'texts = {json.loads(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()}',
    "assert texts and all(texts), 'missing independent message-body sentinels'",
    'paths = [pathlib.Path(sys.argv[2]), *pathlib.Path(sys.argv[3]).iterdir()]', 'for path in paths:',
    '    if any(text in path.read_text() for text in texts):',
    "        raise SystemExit('message body leaked into diagnostics or a captured result')", 'PY', '}',
  ].join('\n')
  test.each([
    ['fixed check, body on RAW and dispatch lines', 'fixed', 'excerpts', 0],
    ['old check, body on RAW and dispatch lines', 'old', 'excerpts', 1],
    ['fixed check, body on another log line', 'fixed', 'other-line', 1],
    ['fixed check, body after a head mid-line', 'fixed', 'mid-line', 1],
    ['fixed check, body on an unstamped line that starts with a head', 'fixed', 'unstamped', 1],
    ['fixed check, body in a captured result', 'fixed', 'captured', 1],
  ] as const)('test-29 closing body check skips only the RAW and dispatch lines: %s', async (_name, form, where, status) => {
    const body = 'test-29-invited-channels plain-7'
    const logged: string[] = []
    const router = createPersonaEventRouter({ routing: { receive: async () => {}, receiveReaction: async () => {} }, clientFor: () => undefined as never, getPersona: () => undefined as never, log: line => logged.push(line) })
    const event = { type: 'message', channel: 'CHUMAN', text: body, ts: '1700000001.000001', user: 'UHUMAN', channel_type: 'channel' }
    await router('t29_alpha', 'message', { event, ack: async () => {} } as never)
    await router('t29_alpha', 'app_mention', { event: { ...event, type: 'app_mention' }, ack: async () => {} } as never)
    logged.push(buildDeliveryDispatchLine('"t29_alpha" (key=t29_alpha)',
      { v: 1, kind: 'accepted', seq: 1, source: 'slack', channel: 'CHUMAN', ts: '1700000001.000001', user: 'UHUMAN', text: body, received_at: 1 } as AcceptedRecord))
    // Each production line's head, through its `persona=`, in the script's order.
    const heads = logged.map(line => line.slice(0, line.indexOf('persona=') + 'persona='.length))
    expect(bodyHeads).toBe(`BODY_LINE_HEADS=(${heads.map(head => `'${head}'`).join(' ')})`)
    expect(logged.every(line => line.includes(body))).toBe(true)
    const stamp = (line: string) => `[2026-11-13T18:03:53.751Z] ${line}`
    const lines = [...logged.map(stamp), stamp('[slack] message-received: persona="t29_alpha" (key=t29_alpha) source=slack')]
    if (where === 'other-line') lines.push(stamp(`[slack] reload-preview: ${body}`))
    if (where === 'mid-line') lines.push(stamp(`[slack] persona=t29_alpha: note ${logged[0]}`))
    // A continuation line of a multi-line entry carries no timestamp.
    if (where === 'unstamped') lines.push(stamp('[slack] persona=t29_alpha: note'), logged[2]!)
    const run = shell([
      bodyHeads, form === 'fixed' ? bodyCheck : oldBodyCheck, 'mkdir -p "$HOME/captured"',
      `printf '%s\\n' ${where === 'captured' ? `"echo ${body}"` : '"no body"'} > "$HOME/captured/step.result"`,
      'body_sentinels_absent "$HOME/inputs.jsonl" "$HOME/server.log" "$HOME/captured"',
    ].join('\n'), { 'inputs.jsonl': JSON.stringify(body) + '\n', 'server.log': lines.join('\n') + '\n' })
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status, stderr: status ? 'message body leaked into diagnostics or a captured result\n' : '' })
  })
  test('burst slice removes exactly the two write envelopes and keeps every other stub line byte-for-byte', () => {
    const lines = ['{"seq":1,"event":"push","envelope_id":"burst","sent_mono_ms":1.250000}', '{"seq":2,"event":"push","envelope_id":"leave-env"}',
      '{"seq":3,"event":"ws-message","envelope_id":"leave-env"}', '{"seq":4,"event":"fault","request_id":"r1"}',
      '{"seq":5,"event":"push","envelope_id":"join-env"}', '{"seq":6,"event":"ws-message","envelope_id":null}', '{"seq":7,"event":"ws-message","envelope_id":"burst"}']
    const run = (tsv: string) => shell([declaration(source('lib/membership-load.sh'), 'burst_slice'),
      'burst_slice "$HOME/case.jsonl" "$HOME/writes.tsv" "$HOME/out.jsonl"', 'cat "$HOME/out.jsonl"'].join('\n'),
    { 'case.jsonl': lines.join('\n') + '\n', 'writes.tsv': tsv })
    const kept = run('leave\tleave-env\njoin\tjoin-env\n')
    expect(kept.status).toBe(0); expect(kept.stdout).toBe([0, 3, 5, 6].map(i => lines[i]).join('\n') + '\n')
    expect(run('leave\tleave-env\n').status).not.toBe(0)
  })
  // The real record reader and predicate; only the readiness read is replaced.
  const page = (seq: number, label = 'beta', cursor = '') => ({ seq, event: 'api', method: 'users.conversations', label, cursor, answer: 'ok' })
  test.each([
    ['first page after the push', [page(3), page(9)], 'complete', 0],
    ['first page only at the push', [page(3), page(8)], 'complete', 1],
    ['only a later page after the push', [page(3), page(9, 'beta', 'first-page-2')], 'complete', 1],
    ['first page after the push for another label', [page(3), page(9, 'alpha')], 'complete', 1],
    ['first page after the push, scan not yet complete', [page(9)], 'incomplete', 1],
  ] as const)('a membership rescan counts only a scan the push itself started: %s', (_name, records, state, rc) => {
    const run = shell([
      'require_ci_image() { :; }', '_scenario_scratch_file() { :; }',
      '_scenario_membership_complete() { printf \'complete %s\\n\' "$*" >> "$HOME/calls"; [[ "$(cat "$HOME/state")" == complete ]]; }',
      declaration(scenario, '_scenario_complete_jsonl'), declaration(scenario, 'slack_stub_records'), declaration(scenario, '_scenario_membership_rescanned'),
      'SCENARIO_SLACK_RECORD="$HOME/record.jsonl"',
      'rc=0; _scenario_membership_rescanned beta-key beta 8 /route || rc=$?', 'printf \'rc=%s\\n\' "${rc}"', 'cat "$HOME/calls" 2>/dev/null || true',
    ].join('\n'), { 'record.jsonl': records.map(r => JSON.stringify(r) + '\n').join(''), state })
    expect(run.stderr).toBe('')
    // Readiness is read only once a scan the push started has been seen.
    const asked = records.some(r => r.seq > 8 && r.label === 'beta' && r.cursor === '')
    expect(run.stdout).toBe([`rc=${rc}`, ...(asked ? ['complete beta-key /route'] : []), ''].join('\n'))
  })
  function cli(command: string, args: string[], files: Record<string, string> = {}, recipients = 2) {
    const root = mkdtempSync(join(tmpdir(), 'sr8-case-cli-'))
    try {
      const dir = join(root, 'tests/integration/fixtures'), marker = join(root, 'image')
      mkdirSync(dir, { recursive: true }); mkdirSync(join(root, 'tests/test-helpers'), { recursive: true })
      writeFileSync(marker, '')
      writeFileSync(join(dir, 'sr8-evidence.ts'), source('fixtures/sr8-evidence.ts').replace("existsSync('/etc/cscb-ci-image')", `existsSync(${JSON.stringify(marker)})`))
      writeFileSync(join(dir, 'sr8-attribution.ts'), source('fixtures/sr8-attribution.ts'))
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
    ['pending-post', [key, operation, '0', String(SR8_PENDING_POST_MS), noFile, noFile, noFile, noFile, noFile, noFile, '0', channel,
      noFile, '10', '30', String(QUEUE_COMPACT_INTERVAL_MS), '0', '1'], 6],
    ['shared-list', [noFile, '1'], 2],
    ['membership-fault', ['hang', 'first', key, noFile, noFile, noFile, noFile, '0', '0'], 2],
    ['membership-repair', [key, '100', noFile], 1],
    ['membership-late', [key, 'late', noFile, '3', noFile, noFile, noFile], 1],
    ['zero-ack', [key, 'undurable', noFile, '0', '4000', '1', noFile], 1],
    ['accounting', [noFile, noFile, noFile, noFile, noFile, '5'], 1],
    ['stores', [noFile, noFile, '0'], 3],
    ['lookup-faults', [noFile, noFile, noFile], 2],
    ['ordered-writes', [noFile, noFile, '2', '4', noFile], 2],
    ['membership-writes', [noFile, sr8Personas(2)[1], 'CWRITE', noFile, '2', '6', noFile], 3],
  ] as [string, string[], number][])('CLI %s prints every missing line before exiting', (command, args, count) => {
    const child = cli(command, args), all = child.stdout.trim().split('\n')
    // A non-passing membership-fault case first prints its correlation rows.
    const rows = all.filter(l => l.startsWith('recorded: sr8 membership-fault-row '))
    expect(rows).toEqual(command === 'membership-fault' ? ['recorded: sr8 membership-fault-row case=hang source=stub rows=unavailable'] : [])
    const attribution = all.filter(l => l.startsWith('recorded: sr8 attribution '))
    expect(attribution).toHaveLength(command === 'pending-post' ? 1 : 0)
    expect(attribution.every(l => l.includes('type=stall-summary ') && l.endsWith('verdict=info'))).toBe(true)
    const lines = all.slice(rows.length).filter(l => !l.startsWith('recorded: sr8 attribution '))
    expect(child.status).toBe(1); expect(lines).toHaveLength(count + 1)
    expect(lines.slice(0, -1).every(l => l.endsWith('verdict=missing'))).toBe(true)
    expect(lines.at(-1)).toContain(`measures=${count} pass=0 fail=0 missing=${count}`)
  })
  test('CLI pending-post reads its actual journal, queue, timing, measurement and burst files', () => {
    const p = pending(), b = pendingBurst([key], channel, p.probes)
    const args = [key, operation, '0', String(p.end), '@/before', '@/after', '@/probes', '@/e/alpha.queue.jsonl', '@/e/times.jsonl', '@/measurements', '0', channel,
      '@/e', '10', String(b.end), String(QUEUE_COMPACT_INTERVAL_MS), '7', String(7 + QUEUE_COMPACT_INTERVAL_MS - 1)]
    const files = { before: jsonl(p.before), after: jsonl(p.after), probes: p.probes.map(p => [p.parent, p.channel, p.ts, p.envelope_id].join('\t')).join('\n') + '\n',
      'e/alpha.queue.jsonl': jsonl(p.queue), 'e/times.jsonl': jsonl([...p.times, ...b.ledger.filter(i => i.phase !== 'probes').map(i => timing(i.envelope_id!, 1))]),
      measurements: jsonl(p.rows), 'e/burst.jsonl': jsonl(b.ledger), 'e/final-stub.jsonl': jsonl(b.stub), 'e/before.journal': '64768:12\n', 'e/after.journal': '64768:12\n' }
    const pass = cli('pending-post', args, files, 1), all = pass.stdout.trim().split('\n')
    expect(all.filter(l => l.startsWith('recorded: sr8 attribution '))).toHaveLength(1)
    expect(all[0]).toContain('type=stall-summary mode=strict population=100000 recipients=1 count=0 printed=0 max_gap_ms=0 total_gap_ms=0 marker_count=0 verdict=info')
    const lines = all.filter(l => !l.startsWith('recorded: sr8 attribution '))
    expect(pass.status).toBe(0)
    expect(lines.map(l => l.split(' ')[2])).toEqual(['pending-post', 'pending-post-ack', 'post-hold', 'ack-accepted', 'ack-dropped', 'pending-post-burst', 'summary'])
    expect(lines[5]).toContain(`samples=${SR8_BURST_JOINS + SR8_BURST_REPLIES + SR8_BURST_DROPPED} compact_interval_ms=${QUEUE_COMPACT_INTERVAL_MS} window_ms=${QUEUE_COMPACT_INTERVAL_MS - 1} probes_inside=3 burst_in_pending=yes same_journal=yes limit=window_ms<compact_interval_ms verdict=pass`)
    expect(cli('pending-post', args, { ...files, measurements: token }, 1).status).toBe(1)
    const replaced = cli('pending-post', args, { ...files, 'e/after.journal': '64768:13\n' }, 1)
    expect(replaced.status).toBe(1); expect(replaced.stdout).toContain('same_journal=no limit=window_ms<compact_interval_ms verdict=fail')
    const short = cli('pending-post', args, { ...files, 'e/burst.jsonl': jsonl(b.ledger.filter(i => i.phase !== 'replies' || i.ts !== 'replies.0')) }, 1)
    expect(short.status).toBe(1); expect(short.stdout).toMatch(/ack-accepted .* verdict=missing/)
    // Without the second persona's queue, no drop can be proved unstored.
    const both = pendingBurst([key, 'beta'], channel, p.probes), twoArgs = [...args.slice(0, 14), String(both.end), ...args.slice(15)]
    const twoFiles = { ...files, 'e/times.jsonl': jsonl([...p.times, ...both.ledger.filter(i => i.phase !== 'probes').map(i => timing(i.envelope_id!, 1))]),
      'e/burst.jsonl': jsonl(both.ledger), 'e/final-stub.jsonl': jsonl(both.stub) }
    expect(cli('pending-post', twoArgs, { ...twoFiles, 'e/beta.queue.jsonl': jsonl([]) }, 2).status).toBe(0)
    const absent = cli('pending-post', twoArgs, twoFiles, 2)
    expect(absent.status).toBe(1); expect(absent.stdout).toMatch(/ack-dropped .* verdict=missing/)
    expect(absent.stdout).toMatch(/pending-post scenario=.* verdict=pass/)
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
  test('CLI membership writes reads every persona state, write order and both timing files', () => {
    const f = memberWrites(), files: Record<string, string> = { stub: jsonl(f.stub), times: jsonl(f.times),
      'e/membership.tsv': f.writes.map(w => [w.kind, w.envelope_id, w.event_id, w.stage_seq].join('\t')).join('\n') + '\n', 'e/membership-times.jsonl': jsonl(f.writeTimes) }
    const { events, eventsReopened, ...phases } = f.states
    for (const [phase, rows] of Object.entries(phases)) files[`e/${phase}.jsonl`] = jsonl(rows)
    files['e/events.jsonl'] = jsonl(events); files['e/events.reopened.jsonl'] = jsonl(eventsReopened)
    const args = ['@/e', f.q, f.write, '@/stub', String(f.submit), String(f.done), '@/times']
    const child = cli('membership-writes', args, files)
    expect(child.status).toBe(0); expect(child.stdout).toContain('samples=2 overlap=yes retained=yes ordered=yes acked=yes staged=yes')
    expect(child.stdout).toMatch(/membership-write-ack .* verdict=pass/)
    const wrongWriter = cli('membership-writes', ['@/e', f.p, ...args.slice(2)], files)
    expect(wrongWriter.status).toBe(1); expect(wrongWriter.stdout).toContain('ordered=no')
    // The old two-column write list is malformed, not a pass.
    const twoColumns = cli('membership-writes', args, { ...files, 'e/membership.tsv': f.writes.map(w => `${w.kind}\t${w.envelope_id}`).join('\n') + '\n' })
    expect(twoColumns.status).toBe(1); expect(twoColumns.stdout).toContain('verdict=missing')
    const { 'e/events.reopened.jsonl': _dropped, ...noReopenedEvents } = files
    const unread = cli('membership-writes', args, noReopenedEvents)
    expect(unread.status).toBe(1); expect(unread.stdout).toContain('verdict=missing')
  })
  test('CLI stores emits combined plus both personas, independently failing Q', () => {
    const items = [{ key, phase: 'roots', channel, ts: '1' }, { key: 'beta', phase: 'roots', channel, ts: '2' }]
    const rows = [measure(1), measure(2, 'accepted', SR8_STORE_LIMIT_MS, 'beta')]
    const child = cli('stores', ['@/e', '@/measurements', '0'], { 'e/burst.jsonl': jsonl(items), measurements: jsonl(rows),
      'e/alpha.queue.jsonl': jsonl([{ kind: 'accepted', channel, ts: '1', seq: 1 }]), 'e/beta.queue.jsonl': jsonl([{ kind: 'accepted', channel, ts: '2', seq: 2 }]) })
    expect(child.status).toBe(1); expect(child.stdout).toContain('persona=1 limit=50 verdict=pass'); expect(child.stdout).toContain('persona=2 limit=50 verdict=fail')
  })
  test('the measurement reader skips only the server diagnostic kinds and keeps thread-compaction for the compaction proof; every other verdict is unchanged by them', () => {
    const items = [{ key, phase: 'roots', channel, ts: '1' }, { key: 'beta', phase: 'roots', channel, ts: '2' }]
    const queues = { 'e/alpha.queue.jsonl': jsonl([{ kind: 'accepted', channel, ts: '1', seq: 1 }]), 'e/beta.queue.jsonl': jsonl([{ kind: 'accepted', channel, ts: '2', seq: 2 }]) }
    const rows = [measure(1), measure(2, 'accepted', SR8_STORE_LIMIT_MS, 'beta')]
    const run = (extra: unknown[]) => cli('stores', ['@/e', '@/measurements', '0'], { 'e/burst.jsonl': jsonl(items), measurements: jsonl([...rows, ...extra]), ...queues })
    const plain = run([])
    // One row of each kind as the server's own serializer writes it.
    const diagnostic = [serverRows.ack, serverRows.append, serverRows.save].map(l => JSON.parse(l))
    expect(diagnostic.map(r => r.kind)).toEqual([...SR8_DIAGNOSTIC_KINDS])
    const attribution = [
      { v: 1, kind: 'post-hold-timing', key, seq: 1, phase: 'registered', received_mono_ms: 0, due_mono_ms: 3000, at_mono_ms: 1 },
      { v: 1, kind: 'event-loop-stall', at_mono_ms: 100, start_mono_ms: 1, end_mono_ms: 100, gap_ms: 89 },
      { v: 1, kind: 'sync-work', key, work: 'thread-judge', start_mono_ms: 1, end_mono_ms: 99, at_mono_ms: 99 },
    ]
    const all = run([...diagnostic, ...attribution, JSON.parse(serverRows.compaction)])
    expect({ status: all.status, stdout: all.stdout }).toEqual({ status: plain.status, stdout: plain.stdout })
    const unknown = run([{ v: 1, kind: 'unreviewed', key, at_mono_ms: 1 }])
    expect(unknown.status).toBe(1); expect(unknown.stdout.split('\n').filter(l => l.includes(' store ')).every(l => l.endsWith('verdict=missing'))).toBe(true)
  })
  test('CLI check proves each recipient\'s Thread Memory compaction from its measurement file, inside the burst\'s server-clock store span only', () => {
    const keys = sr8Personas(2), [alpha, beta] = keys as [string, string], { ledger } = pendingBurst(keys, channel, [])
    const accepted = ledger.filter(i => i.phase !== 'dropped')
    // Server clock: the burst's 4,000 acceptance stores span 1000..5000. The stub's
    // push/ACK clock starts at 9,000,000 and the harness's start/ready at 0.
    const stores = accepted.map((i, n) => serverLine({ kind: 'store', key: i.key, seq: n + 1, store: 'accepted', store_ms: 1, at_mono_ms: 1001 + n }, 1001 + n))
    const files: Record<string, string> = { 'e/burst.jsonl': jsonl(ledger),
      'e/times.jsonl': jsonl(ledger.map((i, n) => ({ envelope_id: i.envelope_id, push: { sent_mono_ms: 9_000_000 + n, connection_id: 'socket' },
        acks: [{ ack_mono_ms: 9_000_001 + n, connection_id: 'socket' }] }))),
      'e/compactions.jsonl': jsonl(keys.map(k => ({ key: k, kind: 'queue', before: '1:1', after: '1:2', inside: true }))) }
    for (const k of keys) files[`e/${k}.queue.jsonl`] = jsonl(accepted.flatMap((i, n) => i.key === k ? [{ kind: 'accepted', channel: i.channel, ts: i.ts, seq: n + 1 }] : []))
    const run = (measured: string[], mark = 0) => {
      const out = cli('check', ['@/e', '@/measurements', String(mark), '0', '1'], { ...files, measurements: measured.map(l => `${l}\n`).join('') }).stdout.trim().split('\n')
      return { compaction: out.filter(l => l.startsWith('recorded: sr8 compaction ')),
        others: out.filter(l => !l.startsWith('recorded: sr8 compaction ') && !l.startsWith('recorded: sr8 summary ')) }
    }
    const line = (stats: string, verdict: string) => [`recorded: sr8 compaction scenario=test-cli mode=strict population=100000 recipients=2 ${stats} limit=inside-burst verdict=${verdict}`]
    const startup = keys.map(k => compactionLine(k, 10, 900, 'rewritten')), alphaRewrite = compactionLine(alpha, 1500, 1600, 'rewritten')
    const skips = [compactionLine(alpha, 2000, 2100, 'skipped'), compactionLine(beta, 3000, 3100, 'skipped')]
    const plain = run(stores), pass = run([...startup, ...stores, alphaRewrite, ...skips, compactionLine(beta, 4000, 4999, 'rewritten')])
    expect(plain.compaction).toEqual(line('samples=2 required=4 queue=2 threads=0 rewritten=0 skipped=0 outside=0 window_ms=4000', 'missing'))
    expect(pass.compaction).toEqual(line('samples=4 required=4 queue=2 threads=2 rewritten=2 skipped=2 outside=2 window_ms=4000', 'pass'))
    expect(pass.others).toEqual(plain.others)
    // beta's rewrite inside the stub's push-to-ACK span is outside the server's: beta only skipped.
    expect(run([...startup, ...stores, alphaRewrite, ...skips, compactionLine(beta, 9_000_100, 9_000_200, 'rewritten')]).compaction)
      .toEqual(line('samples=3 required=4 queue=2 threads=1 rewritten=1 skipped=2 outside=3 window_ms=4000', 'fail'))
    // Entries before the byte mark are not read: alpha's rewrite precedes it.
    expect(run([alphaRewrite, ...stores, ...skips, compactionLine(beta, 4000, 4999, 'rewritten')], alphaRewrite.length + 1).compaction)
      .toEqual(line('samples=3 required=4 queue=2 threads=1 rewritten=1 skipped=2 outside=0 window_ms=4000', 'fail'))
  })
  test('CLI seal passes the printer lost-join marker into the measured verdict', () => {
    const child = cli('seal', ['@/log', '0', '@/config'], { log: THREAD_MEMORY_JOINS_LOST + ' ' + token,
      config: JSON.stringify({ personas: [key, 'beta'].map(name => ({ name, channels: [] })) }) })
    expect(child.status).toBe(1); expect(child.stdout).toContain('reports=1 loaded=0 limit=0 verdict=fail')
  })
})

describe('test-44, test-32 and test-45/48 root payloads through durable intake (synthetic only)', () => {
  let root: string, h: RoutingHarness | undefined
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'test44-intake-')); h = undefined; resetRoutingState() })
  afterEach(async () => {
    try {
      if (h) {
        h.hold.cancelAll(); h.releaseLaunches()
        await h.ready(); await h.settleJoinSaves(); await h.threads!.close(); await h.queue.stop()
        assertNoLeak(h.captured())
      }
    } finally { resetRoutingState(); rmSync(root, { recursive: true, force: true }) }
  })
  test.each(['strict', 'open'] as const)('test-44 %s roots store and join before the unmentioned reply; plain messages still drop', async mode => {
    const keys = sr8Personas(2), channel = 'C0LARGE00003'
    h = makeRoutingHarness(keys.map(name => ({ name, channels: [{ id: channel, delivery: 'thread_hybrid' }] })), root, {
      mode, threadMemory: {}, membership: observedMembership(Object.fromEntries(keys.map(key => [key, [channel]]))),
      restartDelayS: NEVER_FIRE_RESTART_DELAY_S,
    })
    await h.ready()
    const spec = burstSpec({ mode, population: 0, recipients: keys.length }, [channel], 1_800_000_000)
    // One root/reply/drop from the real plan. Execute the scenario's actual
    // builder, shared by burst and pending, without its integration entrypoint.
    const plan = [['roots', spec.rootMentions[0]], ['replies', spec.replies[0]], ['dropped', spec.dropped[0]]] as const
    const built = shell([
      'require_ci_image() { :; }',
      ...['_scenario_channel_type', 'slack_message_event', 'slack_mention_event', 'slack_reply_event'].map(name => declaration(scenario, name)),
      `mode=${mode}; BATCH="$HOME"; HUMAN=U0BURST; OTHER=U0PARENT`,
      'message="test-44 burst"',
      `mention='<@${h.p(keys[1]!).stub.identity.botUserId}> <@${h.p(keys[0]!).stub.identity.botUserId}> test-44 burst'`,
      block(source('test-44-fmk-thread-burst.sh'), "    while IFS=$'\\t' read -r phase channel ts root _mentioned; do", '\n    for key in "${KEYS[@]}"; do'),
      'cat "$BATCH/roots.events.jsonl" "$BATCH/replies.events.jsonl" "$BATCH/dropped.events.jsonl"',
    ].join('\n'), { 'plan.tsv': plan.map(([phase, m]) => [phase, m!.channel, m!.ts, m!.threadTs ?? '-', m!.mentions.length].join('\t')).join('\n') + '\n' })
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
    const events = built.stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(events).toHaveLength(plan.length)
    expect(events.map(e => e.text)).toEqual([
      `<@${h.p(keys[1]!).stub.identity.botUserId}> <@${h.p(keys[0]!).stub.identity.botUserId}> test-44 burst`,
      'test-44 burst', 'test-44 burst',
    ])
    const atAck: unknown[] = []
    for (const event of events) for (const key of keys) {
      await h.receive(event, [key], () => {
        // Read the journal at ACK, so an in-memory-only acceptance cannot pass.
        const records = existsSync(queuePath(root, key)) ? readQueue(root, key) : []
        atAck.push({ key, stored: records.filter(r => r.kind === 'accepted' && 'ts' in r).map(r => r.ts),
          joined: h!.threads!.memory.view(key, channel, spec.rootMentions[0]!.ts) })
      })
    }
    expect(atAck).toEqual(plan.flatMap(([phase]) => keys.map(key => ({ key, joined: 'joined',
      stored: (phase === 'roots' ? [spec.rootMentions[0]!] : [spec.rootMentions[0]!, spec.replies[0]!]).map(m => m.ts),
    }))))
    expect(events.map(e => [e.type, e.channel_type, e.channel, e.ts, e.thread_ts, e.user, e.parent_user_id])).toEqual([
      [mode === 'open' ? 'message' : 'app_mention', mode === 'open' ? 'channel' : undefined, channel, spec.rootMentions[0]!.ts, undefined, 'U0BURST', undefined],
      ['message', 'channel', channel, spec.replies[0]!.ts, spec.rootMentions[0]!.ts, 'U0BURST', 'U0PARENT'],
      ['message', 'channel', channel, spec.dropped[0]!.ts, undefined, 'U0BURST', undefined],
    ])
    await h.settleJoinSaves()
    for (const key of keys) {
      expect(h.queued(key).map(({ accepted: a }) => ({ channel: a.channel, ts: a.ts, text: a.text, via: a.via }))).toEqual([
        { channel, ts: spec.rootMentions[0]!.ts, text: events[0].text, via: 'mention' },
        { channel, ts: spec.replies[0]!.ts, text: 'test-44 burst', via: 'thread' },
      ])
      expect(readThreads(root, key).filter(r => r.kind === 'join').map(r => [r.channel, r.root, r.source]))
        .toEqual([[channel, spec.rootMentions[0]!.ts, 'mention']])
    }
  })
  test.each(['strict', 'open'] as const)('test-32 %s thread root stores and joins before the first latency reply', async mode => {
    const keys = sr8Personas(2), channel = 'C0LARGE00003', [alpha, beta] = keys as [string, string]
    h = makeRoutingHarness(keys.map(name => ({ name, channels: [{ id: channel, delivery: 'thread_hybrid' }] })), root, {
      mode, threadMemory: {}, membership: observedMembership(Object.fromEntries(keys.map(key => [key, [channel]]))),
      restartDelayS: NEVER_FIRE_RESTART_DELAY_S,
    })
    await h.ready()
    const bot = h.p(alpha).stub.identity.botUserId, rootTs = '1800000000.000001', replyTs = '1800000000.000002'
    // Execute test-32's actual root block and sample-reply line from its
    // workload builder (the whole builder's 20 samples cost seconds of jq).
    const workload = declaration(real, 'real_thread_workload')
    const built = shell([
      'require_ci_image() { :; }',
      ...['_scenario_channel_type', 'slack_message_event', 'slack_mention_event', 'slack_reply_event', 'scenario_text', 'scenario_mention_text']
        .map(name => declaration(scenario, name)),
      'scenario_ts() { printf \'1800000000.000001\\n\'; }', 'scenario_id() { printf \'U0HUMAN\\n\'; }',
      `TEST_NAME=test-32-fmk-real-order REAL_THREAD_MODE=${mode} REAL_THREAD_EVIDENCE="$HOME" REAL_CHANNEL=${channel} REAL_BOT_USER_ID=${bot}`,
      block(workload, '    REAL_THREAD_ROOT="$(scenario_ts)"', '    REAL_THREAD_SAMPLES=()'),
      `n=1 ts=${replyTs} sender=U0HUMAN; text="$(scenario_text "thread-latency-\${n}")"`,
      block(workload, '        slack_reply_event "${REAL_CHANNEL}"', '\n        if'),
      'cat "$HOME/root.json" "$HOME/sample-1.json"',
    ].join('\n'))
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
    const events = built.stdout.trim().split('\n').map(line => JSON.parse(line))
    // The scenario pushes both to alpha's connection only.
    const atAck: unknown[] = []
    for (const event of events) {
      await h.receive(event, [alpha], () => {
        const records = existsSync(queuePath(root, alpha)) ? readQueue(root, alpha) : []
        atAck.push({ stored: records.filter(r => r.kind === 'accepted' && 'ts' in r).map(r => r.ts), joined: h!.threads!.memory.view(alpha, channel, rootTs) })
      })
    }
    expect(atAck).toEqual([{ stored: [rootTs], joined: 'joined' }, { stored: [rootTs, replyTs], joined: 'joined' }])
    expect(events.map(e => [e.type, e.channel_type, e.channel, e.ts, e.thread_ts, e.text])).toEqual([
      [mode === 'open' ? 'message' : 'app_mention', mode === 'open' ? 'channel' : undefined, channel, rootTs, undefined, `<@${bot}> test-32-fmk-real-order thread-root`],
      ['message', 'channel', channel, replyTs, rootTs, 'test-32-fmk-real-order thread-latency-1'],
    ])
    await h.settleJoinSaves()
    expect(h.queued(alpha).map(({ accepted: a }) => ({ channel: a.channel, ts: a.ts, via: a.via })))
      .toEqual([{ channel, ts: rootTs, via: 'mention' }, { channel, ts: replyTs, via: 'thread' }])
    expect(h.queued(beta)).toEqual([])
    expect(readThreads(root, alpha).filter(r => r.kind === 'join').map(r => [r.channel, r.root, r.source])).toEqual([[channel, rootTs, 'mention']])
  })
  test.each(['strict', 'open'] as const)('test-45/48 %s roots store and join before the unmentioned reply; plain messages still drop', async mode => {
    const keys = sr8Personas(2), channel = 'C0LARGE00003'
    h = makeRoutingHarness(keys.map(name => ({ name, channels: [{ id: channel, delivery: 'thread_hybrid' }] })), root, {
      mode, threadMemory: {}, membership: observedMembership(Object.fromEntries(keys.map(key => [key, [channel]]))),
      restartDelayS: NEVER_FIRE_RESTART_DELAY_S,
    })
    await h.ready()
    const spec = burstSpec({ mode, population: 0, recipients: keys.length }, [channel], 1_800_000_000), rootTs = spec.rootMentions[0]!.ts
    const plan = [['roots', spec.rootMentions[0]], ['replies', spec.replies[0]], ['dropped', spec.dropped[0]]] as const
    const bots = Object.fromEntries(keys.map(key => [key, h!.p(key).stub.identity.botUserId]))
    // Execute membership-load.sh's real build_batches; bun stands in for the
    // CI-only sr8-evidence `bodies`, which only wraps each event per label.
    const built = shell([
      'require_ci_image() { :; }',
      ...['_scenario_channel_type', 'slack_message_event', 'slack_mention_event', 'slack_reply_event', 'scenario_text', 'scenario_mention_text']
        .map(name => declaration(scenario, name)),
      `slack_stub_identity() { case "$1" in ${keys.map(key => `${key}) printf '%s\\n' ${bots[key]} ;;`).join(' ')} *) exit 9 ;; esac; }`,
      'scenario_id() { local name="${2//[^A-Za-z0-9]/}"; printf \'%s0%s\\n\' "$1" "${name^^}"; }',
      'bun() { [[ "$1" == "$E" && "$2" == bodies && "$#" == 4 ]] || exit 9; jq -c --arg key "$3" \'{"label":$key,event:.}\' "$4"; }',
      declaration(source('lib/membership-load.sh'), 'build_batches'),
      `MODE=${mode} TEST_NAME=test-48-fmk-membership-load-open CASE=test-48-${mode}-first-hang BATCH="$HOME" PLAN="$HOME/plan.tsv" E=e.ts`,
      `KEYS=(${keys.join(' ')}) HOLD_KEYS=()`, 'build_batches',
      'cat "$BATCH/roots.batch.jsonl" "$BATCH/replies.batch.jsonl" "$BATCH/dropped.batch.jsonl"',
    ].join('\n'), { 'plan.tsv': plan.map(([phase, m]) => [phase, m!.channel, m!.ts, m!.threadTs ?? '-', m!.mentions.length].join('\t')).join('\n') + '\n' })
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
    const bodies: { label: string; event: any }[] = built.stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(bodies.map(b => b.label)).toEqual(plan.flatMap(() => keys))
    const sender = 'U0TEST48' + mode.toUpperCase() + 'FIRSTHANGORDINARY'
    const text = (phase: string, ts: string) => `test-48-fmk-membership-load-open test-48-${mode}-first-hang-${phase}-${ts}`
    const rootText = keys.map(key => `<@${bots[key]}> test-48-fmk-membership-load-open `).join('') + text('roots', rootTs)
    expect(bodies.filter((_, n) => n % keys.length === 0).map(({ event: e }) => [e.type, e.channel_type, e.channel, e.ts, e.thread_ts, e.user, e.parent_user_id, e.text])).toEqual([
      [mode === 'open' ? 'message' : 'app_mention', mode === 'open' ? 'channel' : undefined, channel, rootTs, undefined, sender, undefined, rootText],
      ['message', 'channel', channel, spec.replies[0]!.ts, rootTs, sender, sender, text('replies', spec.replies[0]!.ts)],
      ['message', 'channel', channel, spec.dropped[0]!.ts, undefined, sender, undefined, text('dropped', spec.dropped[0]!.ts)],
    ])
    const atAck: unknown[] = []
    for (const { label: key, event } of bodies) {
      await h.receive(event, [key], () => {
        const records = existsSync(queuePath(root, key)) ? readQueue(root, key) : []
        atAck.push({ key, stored: records.filter(r => r.kind === 'accepted' && 'ts' in r).map(r => r.ts), joined: h!.threads!.memory.view(key, channel, rootTs) })
      })
    }
    expect(atAck).toEqual(plan.flatMap(([phase]) => keys.map(key => ({ key, joined: 'joined',
      stored: phase === 'roots' ? [rootTs] : [rootTs, spec.replies[0]!.ts] }))))
    await h.settleJoinSaves()
    for (const key of keys) {
      expect(h.queued(key).map(({ accepted: a }) => ({ channel: a.channel, ts: a.ts, via: a.via })))
        .toEqual([{ channel, ts: rootTs, via: 'mention' }, { channel, ts: spec.replies[0]!.ts, via: 'thread' }])
      expect(readThreads(root, key).filter(r => r.kind === 'join').map(r => [r.channel, r.root, r.source])).toEqual([[channel, rootTs, 'mention']])
    }
  })
})

describe('test-44 verdict failures print a FAIL line naming them (stub shell)', () => {
  const t44 = source('test-44-fmk-thread-burst.sh')
  const row = (measure: string, verdict: Result['verdict'], stats: Result['stats'] = {}): Result => ({ measure, samples: 1, stats, limit: 3000, verdict })
  // Runs the script's sr8_verdicts and scenario.sh's fail over a stand-in
  // verdict command that prints rows through the real printResults, then
  // exits with printResults' status, a given status, or SIGKILLs itself.
  const run = (rows: Result[] | null, exit: number | 'SIGKILL' | null = null) => shell([
    declaration(scenario, 'fail'), declaration(t44, 'sr8_verdicts'),
    'TEST_NAME=test-44-fmk-thread-burst EVIDENCE="$HOME" SR8="$HOME/e.ts" mode=open population=0 recipients=2',
    'sr8_verdicts check test-44-fmk-thread-burst open 0 2', 'echo after',
  ].join('\n'), {
    'rows.json': JSON.stringify({ rows, exit }),
    'e.ts': `import { printResults } from ${JSON.stringify(join(integration, 'fixtures/sr8-evidence.ts'))}
const { rows, exit } = await Bun.file(import.meta.dir + '/rows.json').json()
const status = rows === null ? 1 : printResults({ scenario: 'test-44-fmk-thread-burst', mode: 'open', population: 0, recipients: 2 }, rows)
if (exit === 'SIGKILL') process.kill(process.pid, 'SIGKILL')
process.exit(exit ?? status)\n`,
  })
  const printed = (rows: Result[]) => {
    const lines: string[] = []
    printResults({ scenario: 'test-44-fmk-thread-burst', mode: 'open', population: 0, recipients: 2 }, rows, line => lines.push(line))
    return lines.map(line => `${line}\n`).join('')
  }
  // answers22's open/0/2 check: both ACK verdicts over the limit, the rest passing.
  const answers22 = [row('ack-accepted', 'fail', { max_ms: 3338.7 }), row('store', 'pass'), row('joins', 'pass', { persona: 'alpha' }),
    row('post-hold-overlap-ack', 'fail', { max_ms: 3338.7 })]
  test.each<[string, Result[] | null, string]>([
    ['failing ACK verdicts', answers22, 'ack-accepted=fail post-hold-overlap-ack=fail'],
    ['a persona\'s missing joins', [row('store', 'pass'), row('joins', 'pass', { persona: 'alpha' }), row('joins', 'missing', { persona: 'beta' })], 'joins[beta]=missing'],
    ['placement fields after the verdict', [Object.assign(row('driver-cpu', 'missing'), { placement: { harness_cgroup: '/shard/harness' } })], 'driver-cpu=missing'],
    ['a failing exit with no verdict rows', null, 'sr8 check exited 1 with no verdict'],
  ])('%s', (_name, rows, named) => {
    const r = run(rows)
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr })
      .toEqual({ status: 1, stdout: rows ? printed(rows) : '', stderr: `FAIL: test-44-fmk-thread-burst: ${named} (open/0/2)\n` })
  })
  // The FAIL line still names the failure, and the scenario exits with the
  // command's own status rather than fail's 1. For the kill, bash's own
  // "Killed" report precedes the FAIL line.
  test.each<[string, Result[] | null, number | 'SIGKILL', number, string]>([
    ['a usage error (64) with no verdict rows', null, 64, 64, 'sr8 check exited 64 with no verdict'],
    ['a killed command (137) after failing verdict rows', answers22, 'SIGKILL', 137, 'ack-accepted=fail post-hold-overlap-ack=fail'],
  ])('%s keeps its exit status', (_name, rows, exit, status, named) => {
    const r = run(rows, exit), failLine = `FAIL: test-44-fmk-thread-burst: ${named} (open/0/2)\n`
    const killed = exit === 'SIGKILL' ? /^[^\n]* Killed +bun "\$\{SR8\}" "\$@" > "\$\{rows\}"\n/.exec(r.stderr)?.[0] ?? '' : ''
    if (exit === 'SIGKILL') expect(killed).not.toBe('')
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr })
      .toEqual({ status, stdout: rows ? printed(rows) : '', stderr: killed + failLine })
  })
  test('passing verdicts print the same rows and continue', () => {
    const rows = [row('store', 'pass'), row('joins', 'pass', { persona: 'alpha' })], r = run(rows)
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: `${printed(rows)}after\n`, stderr: '' })
  })
  test('every verdict command goes through sr8_verdicts; setup and observation commands do not', () => {
    expect([...new Set([...t44.matchAll(/bun "\$\{SR8\}" ([a-z-]+)/g)].map(m => m[1]))].sort())
      .toEqual(['bodies', 'burst', 'combinations', 'conditions', 'config', 'envelope-times', 'observe', 'plan', 'seed'])
    expect([...t44.matchAll(/^\s*sr8_verdicts (seal [a-z]+|[a-z-]+) /gm)].map(m => m[1]))
      .toEqual(['seal first', 'seal measured', 'driver-cpu', 'seal measured', 'check', 'driver-cpu', 'pending-post', 'shared-list'])
  })
})

describe('the burst driver runs off the server\'s CPU quota (stub shell)', () => {
  const entrypoint = readFileSync(join(import.meta.dir, '..', 'docker', 'entrypoint.sh'), 'utf8')
  /** Every driver command in a script, and those burst-driver.sh runs, recording into `record`. */
  const drivers = (text: string, bun: string, record: string) => ({
    all: [...text.matchAll(new RegExp(`bun "\\$\\{${bun}\\}" (burst|fault-burst|fault-recover) `, 'g'))].map(m => m[1]),
    wrapped: [...text.matchAll(new RegExp(`bash "\\$\\{BURST_DRIVER\\}" "\\$\\{${record}\\}/driver-cgroup"(?: \\\\\\n\\s*| )bun "\\$\\{${bun}\\}" (burst|fault-burst|fault-recover) `, 'g'))].map(m => m[1]),
  })
  test('tests 44, 45 and 48 run every burst driver through burst-driver.sh and judge it with driver-cpu while the measured server runs', () => {
    const t44 = source('test-44-fmk-thread-burst.sh'), load = source('lib/membership-load.sh')
    expect(drivers(t44, 'SR8', 'RESULTS')).toEqual({ all: ['burst', 'burst'], wrapped: ['burst', 'burst'] })
    expect(drivers(load, 'E', 'OUT')).toEqual({ all: ['burst', 'fault-burst', 'fault-recover'], wrapped: ['burst', 'fault-burst', 'fault-recover'] })
    expect(t44.match(/^\s*sr8_verdicts driver-cpu "\$\{CONTEXT\[@\]\}" "\$\{SERVER_PID\}" "\$\{RESULTS\}\/driver-cgroup"\n\s*clean_stop$/gm)).toHaveLength(2)
    expect(load).toContain('        verdict driver-cpu "${C[@]}" "${SERVER_PID}" "${OUT}/driver-cgroup"\n'
      + '        REOPEN_OBSERVE_LOG="$(byte_mark "${SLACK_STATE_DIR}/server.log")"\n        reopen_ad_rows before-stop > "${ROOT}/reopen-observe.rows"\n'
      + '        REOPEN_OBSERVE=1\n        stop_server --stop-bots\n')
  })
  // burst-driver.sh with its image guard removed and its spool and cgroup
  // membership read from the case's own files, never the host's /proc or /run.
  const fixture = source('fixtures/burst-driver.sh')
  const guard = "[[ -f /etc/cscb-ci-image ]] || { echo 'burst-driver requires the CI image' >&2; exit 70; }\n"
  const spool = 'SPOOL=/run/cscb-burst-driver\n', membership = 'MEMBERSHIP=/proc/self/cgroup\n'
  const bun = 'BUN=/usr/local/bin/bun\n', trustedUid = 'TRUSTED_UID=0\n', trustedGid = 'TRUSTED_GID=0\n'
  /** The fixture with its launcher's Bun planted as `bunPath` and this test's user and group trusted in place of root. */
  const planted = (bunPath = '$HOME/bin/bun') => {
    for (const line of [guard, spool, membership, bun, trustedUid, trustedGid]) expect(fixture.split(line)).toHaveLength(2)
    return fixture.replace(guard, '').replace(spool, 'SPOOL="$HOME/spool"\n').replace(membership, 'MEMBERSHIP="$HOME/membership"\n')
      .replace(bun, `BUN="${bunPath}"\n`).replace(trustedUid, 'TRUSTED_UID="$(id -u)"\n').replace(trustedGid, 'TRUSTED_GID="$(id -g)"\n')
  }
  // The planted Bun (a script that runs this suite's Bun by its absolute path), closed to
  // others like the image's root-owned one, and a stub driver closed to others too.
  const setup = [
    'mkdir -m 0755 "$HOME/bin"', `printf '#!/bin/bash\\nexec %s "$@"\\n' '${process.execPath}' > "$HOME/bin/bun"`,
    'chmod 0755 "$HOME/bin/bun"', 'chmod 0644 "$HOME/sr8-evidence.ts"', 'chmod 0700 "$HOME"',
    'mkdir -m 0700 "$HOME/spool" "$HOME/work"', 'mkfifo -m 0600 "$HOME/spool/requests"', 'printf "0::/shard/driver\\n" > "$HOME/membership"',
  ]
  // A stand-in for sr8-evidence.ts: prints what it ran with, and for fault-burst waits to be stopped.
  const stubDriver = `import { readFileSync, writeFileSync } from 'node:fs'
const ppidOf = (pid) => { const s = readFileSync('/proc/' + pid + '/stat', 'utf8'); return s.slice(s.lastIndexOf(') ') + 2).split(' ')[1] }
const nsPid = (hostPid) => readFileSync('/proc/' + hostPid + '/status', 'utf8').split('\\n').find(l => l.startsWith('NSpid:')).split('\\t').pop()
const [command, ...rest] = process.argv.slice(2), grand = nsPid(ppidOf(ppidOf('self'))), e = process.env
console.log('driver ' + command + ' ' + rest.join(' ') + ' cwd=' + process.cwd() + ' root=' + e.SCENARIO_ROOT + ' cpu=' + e.SR8_PHASE_CPU_FILE + ' pids=' + e.SR8_PHASE_CPU_PIDS
  + ' profile=' + e.SR8_PROFILE_DIR + ' path=' + e.PATH + ' home=' + e.HOME + ' options=' + e.BUN_OPTIONS + ' extra=' + e.EXTRA + ' pid=' + process.pid + ' grandparent=' + grand)
console.error('driver stderr')
writeFileSync(e.SCENARIO_ROOT + '/driver.pid', String(process.pid))
if (command === 'member-cpu') console.log('member diagnostics=' + e.CSCB_TEST_DIAGNOSTICS + ' selection=' + e.SR8_MEMBER_CPU)
if (command === 'fault-burst') setTimeout(() => {}, 20000)
else process.exitCode = command === 'burst' ? 3 : 0
`
  /** A request written straight to the launcher, skipping the caller's checks: its spec entries, then its status. */
  const craft = 'craft() { local request; request="$(mktemp -d "$HOME/spool/request.XXXXXX")"; mkfifo "$request/spec" "$request/status"; '
    + 'echo "${request##*/}" > "$HOME/spool/requests"; printf "%s\\0" "$@" > "$request/spec"; cat "$request/status"; rm -rf "$request"; }'
  test('burst-driver.sh without a launcher records the membership it runs in and execs the driver as the same PID', () => {
    const r = shell([
      'printf "0::/shard/server\\n" > "$HOME/membership"',
      'SCENARIO_ROOT="$HOME" bash "$HOME/driver.sh" "$HOME/record" bun "$HOME/sr8-evidence.ts" burst one & pid=$!',
      'status=0; wait "$pid" || status=$?; echo "status $status, caller pid $pid"',
      'status=0; bash "$HOME/driver.sh" "$HOME/record" bash -c "echo not a driver" || status=$?; echo "other command $status"',
      'status=0; bash "$HOME/driver.sh" record bun "$HOME/sr8-evidence.ts" burst || status=$?; echo "relative record $status"',
      'cat "$HOME/record"',
    ].join('\n'), { 'driver.sh': planted(), 'sr8-evidence.ts': stubDriver })
    const pid = r.stdout.match(/caller pid (\d+)/)?.[1]
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(` pid=${pid} grandparent=`)
    expect(r.stdout.replace(/^driver .*\n/m, '')).toBe(`status 3, caller pid ${pid}\nother command 64\nrelative record 64\n/shard/server\n`)
    const usage = 'usage: burst-driver.sh <record> bun <fixtures>/sr8-evidence.ts burst|fault-burst|fault-recover|member-cpu <arguments>... | --serve <spool>\n'
    expect(r.stderr).toBe(`driver stderr\n${usage}${usage}`)
  })
  test('the launcher runs all four driver commands under itself, with its own Bun, directory, PATH and HOME and only the driver fields, relaying output and status', () => {
    const r = shell([
      ...setup, 'bash "$HOME/driver.sh" --serve "$HOME/spool" & launcher=$!', 'cd "$HOME/work"', 'echo "launcher $launcher"',
      'export SCENARIO_ROOT="$HOME" SR8_PHASE_CPU_FILE="$HOME/cpu.jsonl" SR8_PHASE_CPU_PIDS=server=7,stub=8 SR8_PROFILE_DIR="$HOME/profile" CSCB_TEST_DIAGNOSTICS=1 SR8_MEMBER_CPU=first-rate,later-rate EXTRA=dropped',
      'for command in burst fault-recover member-cpu; do',
      '  status=0; bash "$HOME/driver.sh" "$HOME/record" bun "$HOME/sr8-evidence.ts" "$command" "a b" \'$HOME\' & caller=$!; wait "$caller" || status=$?',
      '  echo "$command status $status caller $caller"',
      'done',
      // SIGTERM to the caller reaches the fault-burst driver it started.
      'rm "$HOME/driver.pid"; bash "$HOME/driver.sh" "$HOME/record" bun "$HOME/sr8-evidence.ts" fault-burst & caller=$!',
      'for _ in $(seq 100); do [[ -s "$HOME/driver.pid" ]] && break; sleep 0.05; done; kill -TERM "$caller"',
      'status=0; wait "$caller" || status=$?; driver="$(cat "$HOME/driver.pid")"; for _ in $(seq 100); do kill -0 "$driver" 2> /dev/null || break; sleep 0.05; done',
      'kill -0 "$driver" 2> /dev/null && echo "driver alive" || echo "fault-burst stopped $status"',
      'kill "$launcher"', 'cat "$HOME/record"', 'ls "$HOME/spool"',
    ].join('\n'), { 'driver.sh': planted(), 'sr8-evidence.ts': stubDriver })
    expect(r.status).toBe(0)
    const home = r.stdout.match(/ root=(\S+) /)![1]!, launcher = r.stdout.match(/^launcher (\d+)$/m)![1]
    const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const fields = literal(`cwd=/ root=${home} cpu=${home}/cpu.jsonl pids=server=7,stub=8 profile=${home}/profile path=/usr/local/bin:/usr/bin:/bin home=/ options=undefined extra=undefined`)
    // Arguments arrive as given, unevaluated; each driver's grandparent is the launcher, not its caller.
    for (const [command, status] of [['burst', 3], ['fault-recover', 0], ['member-cpu', 0]] as const) {
      const caller = r.stdout.match(new RegExp(`^${command} status ${status} caller (\\d+)$`, 'm'))![1]
      const line = r.stdout.match(new RegExp(`^driver ${command} a b \\$HOME ${fields} pid=(\\d+) grandparent=(\\d+)$`, 'm'))!
      expect([line[1] === caller, line[2]]).toEqual([false, launcher])
    }
    expect(r.stdout).toMatch(new RegExp(`^driver fault-burst  ${fields} pid=\\d+ grandparent=${launcher}$`, 'm'))
    expect(r.stdout).toContain('member diagnostics=1 selection=first-rate,later-rate\n')
    expect(r.stdout).toContain('fault-burst stopped 143\n/shard/driver\n/shard/driver\n/shard/driver\n/shard/driver\nrequests\n')
    expect(r.stderr).toBe('driver stderr\ndriver stderr\ndriver stderr\ndriver stderr\n')
  })
  test('the launcher ignores a caller\'s PATH, Bun options, preload, bunfig and .env files, and refuses crafted environment entries, arguments and records', () => {
    const r = shell([
      ...setup, 'mkdir -m 0755 "$HOME/evil"',
      // A fake bun first on the caller's PATH, and a preload every Bun override names.
      'printf "#!/bin/bash\\ntouch %s/fake-bun\\n" "$HOME" > "$HOME/evil/bun"', 'chmod 0755 "$HOME/evil/bun"',
      `printf '%s\\n' "import { writeFileSync } from 'node:fs'; writeFileSync('$HOME/preloaded', '')" > "$HOME/evil/preload.ts"`,
      'printf "preload = [\\"%s/evil/preload.ts\\"]\\n" "$HOME" | tee "$HOME/work/bunfig.toml" > "$HOME/.bunfig.toml"',
      'printf "EXTRA=from-dotenv\\n" > "$HOME/work/.env"',
      // The preload is live: Bun itself honors BUN_OPTIONS.
      'BUN_OPTIONS="--preload=$HOME/evil/preload.ts" SCENARIO_ROOT="$HOME" "$HOME/bin/bun" "$HOME/sr8-evidence.ts" fault-recover > /dev/null 2>&1',
      '[[ -e "$HOME/preloaded" ]] && echo "preload live"; rm -f "$HOME/preloaded" "$HOME/driver.pid"',
      'bash "$HOME/driver.sh" --serve "$HOME/spool" & launcher=$!', 'cd "$HOME/work"',
      'status=0; PATH="$HOME/evil:$PATH" BUN_OPTIONS="--preload=$HOME/evil/preload.ts" NODE_OPTIONS="--require=$HOME/evil/preload.ts" SCENARIO_ROOT="$HOME" \\',
      '  bash "$HOME/driver.sh" "$HOME/record" bun "$HOME/sr8-evidence.ts" fault-recover || status=$?',
      'echo "overridden caller $status"; for f in fake-bun preloaded; do [[ -e "$HOME/$f" ]] && echo "$f ran"; done',
      craft, 'rm -f "$HOME/driver.pid"',
      'for entry in -u --unset=SCENARIO_ROOT -i -- PATH=/tmp BUN_OPTIONS=--preload=x HOME=/tmp NODE_OPTIONS=x SR8_PROFILE_DIR SCENARIO_ROOTX=1 " SR8_PROFILE_DIR=x" CSCB_TEST_DIAGNOSTICSX=1 SR8_MEMBER_CPUX=all SR8_MEMBER_CPU; do',
      '  echo "entry [$entry]: $(craft "$HOME/record" 3 bun "$HOME/sr8-evidence.ts" burst "$entry")"',
      'done',
      'echo "argv: $(craft "$HOME/record" 3 bash -c "touch $HOME/ran")"',
      'echo "other entry file: $(craft "$HOME/record" 3 bun "$HOME/work/../sr8-evidence.ts" burst)"',
      'echo "relative record: $(craft record 3 bun "$HOME/sr8-evidence.ts" burst)"',
      'echo "short argv: $(craft "$HOME/record" 5 bun "$HOME/sr8-evidence.ts" burst)"',
      'echo "unknown command: $(craft "$HOME/record" 3 bun "$HOME/sr8-evidence.ts" member-cpu-evil)"',
      '[[ -e "$HOME/driver.pid" || -e "$HOME/ran" ]] && echo "a crafted request ran" || echo "no crafted request ran"',
      'kill "$launcher"', 'cat "$HOME/record"',
    ].join('\n'), { 'driver.sh': planted(), 'sr8-evidence.ts': stubDriver })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^driver fault-recover  cwd=\/ root=\S+ cpu=undefined pids=undefined profile=undefined path=\/usr\/local\/bin:\/usr\/bin:\/bin home=\/ options=undefined extra=undefined pid=\d+ grandparent=\d+$/m)
    const entries = ['-u', '--unset=SCENARIO_ROOT', '-i', '--', 'PATH=/tmp', 'BUN_OPTIONS=--preload=x', 'HOME=/tmp', 'NODE_OPTIONS=x', 'SR8_PROFILE_DIR', 'SCENARIO_ROOTX=1', ' SR8_PROFILE_DIR=x', 'CSCB_TEST_DIAGNOSTICSX=1', 'SR8_MEMBER_CPUX=all', 'SR8_MEMBER_CPU']
    expect(r.stdout.replace(/^driver .*\n/m, '')).toBe(['preload live', 'overridden caller 0', ...entries.map(entry => `entry [${entry}]: exit 64`),
      'argv: exit 64', 'other entry file: exit 64', 'relative record: exit 64', 'short argv: exit 64', 'unknown command: exit 64', 'no crafted request ran', '/shard/driver', ''].join('\n'))
    expect(r.stderr).toBe('driver stderr\n')
  })
  test('driver environment allowlist adds only the two member sampler gates', () => {
    const names = fixture.match(/^DRIVER_ENV=\(([^)]*)\)$/m)?.[1].split(' ')
    expect(names).toEqual(['SCENARIO_ROOT', 'SR8_PHASE_CPU_FILE', 'SR8_PHASE_CPU_PIDS', 'SR8_PROFILE_DIR', 'CSCB_TEST_DIAGNOSTICS', 'SR8_MEMBER_CPU'])
  })
  test.each([['other-writable', 'chmod 0757 "$HOME/bin/bun"'], ['a link', 'ln -s "$HOME/bin/bun" "$HOME/bin/link"'],
    ['a group-writable entry file of another group', 'chmod 0664 "$HOME/sr8-evidence.ts"']])('the launcher does not serve when what it runs is %s', (_name, change) => {
    const planting = change.includes('link') ? '$HOME/bin/link' : '$HOME/bin/bun'
    const r = shell([...setup, change, 'status=0; bash "$HOME/driver.sh" --serve "$HOME/spool" || status=$?; echo "launcher $status"'].join('\n'),
      { 'driver.sh': change.includes('0664') ? planted().replace('TRUSTED_GID="$(id -g)"\n', 'TRUSTED_GID=0\n') : planted(planting), 'sr8-evidence.ts': stubDriver })
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: 'launcher 70\n' })
    expect(r.stderr).toMatch(/^burst-driver: \S+ is not root-owned and closed to others; the launcher does not serve\n$/)
  })
  test('a burst-driver shard\'s entrypoint keeps the server at exactly 2 CPUs with headroom beside the driver, starts the driver\'s launcher in the driver\'s group, and gives testuser no cgroup file', () => {
    expect(entrypoint).toContain('if [[ -w /sys/fs/cgroup/cgroup.subtree_control ]] && (( $$ != 1 )); then\n'
      + '    split_driver_cpu /sys/fs/cgroup /proc/self/cgroup /run/cscb-burst-driver\nfi\n\nexec gosu testuser bash /tests/runner.sh "$@"\n')
    expect(fixture).toContain(spool)
    expect(entrypoint.split('\n').filter(line => /\bchown\b/.test(line) && /cgroup|\$\{root\}/.test(line))).toEqual([])
    const split = (cpuMax: string, member = '0::/', listed = true) => shell([
      'chown() { printf "chown %s\\n" "$*" >> "$HOME/log"; }', 'gosu() { printf "gosu %s\\n" "$*" >> "$HOME/log"; }', declaration(entrypoint, 'split_driver_cpu'),
      'mkdir "$HOME/cg"', `printf '%s\\n' '${cpuMax}' > "$HOME/cg/cpu.max"`, `printf '%s\\n' '${member}' > "$HOME/membership"`,
      listed ? 'printf "1\\n%s\\n" "$$" > "$HOME/cg/cgroup.procs"' : 'printf "1\\n" > "$HOME/cg/cgroup.procs"',
      'split_driver_cpu "$HOME/cg" "$HOME/membership" "$HOME/spool"', 'wait', 'cd "$HOME/cg"',
      'for f in cgroup.subtree_control shard/cgroup.type shard/cgroup.subtree_control shard/server/cgroup.type shard/driver/cgroup.type shard/harness/cgroup.type shard/server/cpu.max shard/driver/cpu.max shard/harness/cpu.max; do echo "$f=$(cat "$f")"; done',
      '[[ "$(cat shard/driver/cgroup.procs)" == "$$" && "$(cat shard/server/cgroup.procs)" == "$$" && "$(cat shard/harness/cgroup.procs)" == "$$" ]] && echo "launchers born in driver and server groups; runner in harness"',
      // Permission bits only: the scratch root's setgid bit may carry into the spool.
      '[[ -p "$HOME/spool/requests" ]] && printf "spool %o requests %o\\n" "$(( 0$(stat -c %a "$HOME/spool") & 0777 ))" "$(( 0$(stat -c %a "$HOME/spool/requests") & 0777 ))"',
      'while read -r line; do echo "${line//"$HOME"/<home>}"; done < <(sort "$HOME/log")',
    ].join('\n'))
    // Five CPUs and the smallest quota with 1 CPU of headroom both keep the
    // server at exactly 2 CPUs; harness quota never comes from that allowance.
    expect(CPUS_PER_SHARD + DRIVER_CPUS).toBeGreaterThanOrEqual(SR8_SERVER_CPUS + 0.9 + 1 + SR8_CONTAINER_HEADROOM_CPUS)
    for (const cpuMax of [`${(CPUS_PER_SHARD + DRIVER_CPUS) * 100000} 100000`, '490000 100000']) {
      const r = split(cpuMax)
      expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stderr: '', stdout: [
        'cgroup.subtree_control=+cpu', 'shard/cgroup.type=threaded', 'shard/cgroup.subtree_control=+cpu', 'shard/server/cgroup.type=threaded',
        'shard/driver/cgroup.type=threaded', 'shard/harness/cgroup.type=threaded', 'shard/server/cpu.max=200000 100000', 'shard/driver/cpu.max=90000 100000', 'shard/harness/cpu.max=100000 100000',
        'launchers born in driver and server groups; runner in harness', 'spool 700 requests 600',
        'chown root:testuser <home>/spool-server/requests',
        'chown testuser:testuser <home>/spool <home>/spool/requests', 'chown testuser:testuser <home>/spool-server/jobs',
        'gosu testuser bash /tests/integration/fixtures/burst-driver.sh --serve <home>/spool',
        'gosu testuser bash /tests/integration/fixtures/server-start.sh --serve <home>/spool-server', ''].join('\n') })
    }
    const noHeadroom = 'the container\'s cpu.max leaves less than 1 CPU of headroom beside the server\'s 2 CPUs, the burst driver\'s 0.9 and the harness\'s 1'
    for (const [cpuMax, member, listed, message] of [
      ['400000 100000', '0::/docker/0123abcd', true, 'the cgroup mount is not this container\'s own; a burst-driver shard needs --cgroupns private'],
      ['400000 100000', '0::/', false, 'the cgroup mount is not this container\'s own; a burst-driver shard needs --cgroupns private'],
      ['max 100000', '0::/', true, noHeadroom],
      ['100000 100000', '0::/', true, noHeadroom],
      ['290000 100000', '0::/', true, noHeadroom],
      // b.9p6's layout: 0.1 CPU of headroom.
      ['300000 100000', '0::/', true, noHeadroom],
      ['389999 100000', '0::/', true, noHeadroom],
      ['400000 100000', '0::/', true, noHeadroom],
      ['489999 100000', '0::/', true, noHeadroom],
      ['', '0::/', true, noHeadroom],
    ] as const) {
      const refused = split(cpuMax, member, listed)
      expect({ status: refused.status, stdout: refused.stdout, stderr: refused.stderr }).toEqual({ status: 1, stdout: '', stderr: `entrypoint.sh: ${message}\n` })
    }
  })
})

describe('test-44 pending probe lookup over burst.jsonl (stub shell)', () => {
  // The script's own probe loop and scenario.sh's fail, over a ledger whose
  // probes lead the second wave, so later replies follow every probe row.
  const loop = block(source('test-44-fmk-thread-burst.sh'), '        : > "${EVIDENCE}/probes.tsv"\n', '        for persona in "${KEYS[@]}"; do snapshot')
  const plan = [['other', 'C1', '1.000002'], ['bot', 'C1', '1.000003']]
  const item = (phase: string, ts: string, envelope_id: string) => ({ key: 'alpha', phase, channel: 'C1', ts, sender: 'U1', envelope_id })
  const run = (ledger: unknown[]) => shell([
    declaration(scenario, 'fail'), 'TEST_NAME=test-44-fmk-thread-burst EVIDENCE="$HOME" RESULTS="$HOME"', loop, 'cat "${EVIDENCE}/probes.tsv"',
  ].join('\n'), { 'probe-plan.tsv': plan.map(row => `${row.join('\t')}\n`).join(''), 'burst.jsonl': jsonl(ledger) })
  test('each probe resolves to its one envelope when other rows follow it', () => {
    const r = run([item('roots', '1.000001', 'e-root'), item('probes', '1.000002', 'e-other'), item('probes', '1.000003', 'e-bot'),
      item('replies', '1.000004', 'e-reply')])
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr })
      .toEqual({ status: 0, stdout: 'other\tC1\t1.000002\te-other\nbot\tC1\t1.000003\te-bot\n', stderr: '' })
  })
  test.each<[string, unknown[], string]>([
    ['no probe row', [item('probes', '1.000002', 'e-other'), item('replies', '1.000003', 'e-reply')], 'bot probe 1.000003'],
    ['a duplicate probe row', [item('probes', '1.000002', 'e-other'), item('probes', '1.000002', 'e-again'), item('probes', '1.000003', 'e-bot')], 'other probe 1.000002'],
    ['a probe row without an envelope', [item('probes', '1.000002', ''), item('probes', '1.000003', 'e-bot')], 'other probe 1.000002'],
  ])('%s is a FAIL line, not a bare exit', (_name, ledger, named) => {
    const r = run(ledger)
    expect({ status: r.status, stdout: r.stdout, failLine: r.stderr.split('\n').at(-2) })
      .toEqual({ status: 1, stdout: '', failLine: `FAIL: test-44-fmk-thread-burst: pending ${named} has no unique burst envelope` })
  })
})

describe('test-44 latency observation collectors (synthetic rows, no runtime claim)', () => {
  const v2 = 'usage_usec 5000\nuser_usec 3000\nsystem_usec 2000\nnr_periods 10\nnr_throttled 2\nthrottled_usec 300\nnr_bursts 0\n'
  const procStat = (utime: number, stime: number) => `4242 (bun (x) y) S 1 4242 4242 0 -1 4194304 10 0 0 0 ${utime} ${stime} 0 0 20 0 9 0 100 0 0\n`
  test('cgroup cpu.stat and /proc/<pid>/stat parsers read v2, v1 and kernel-shaped text, undefined when absent or malformed', () => {
    expect(cgroupCpuCounters(v2)).toEqual({ usage_usec: 5000, user_usec: 3000, system_usec: 2000, nr_periods: 10, nr_throttled: 2, throttled_usec: 300 })
    expect(cgroupCpuCounters('nr_periods 4\nnr_throttled 1\nthrottled_time 2500000\n')).toEqual({ nr_periods: 4, nr_throttled: 1, throttled_usec: 2500 })
    expect(cgroupCpuCounters(undefined)).toBeUndefined(); expect(cgroupCpuCounters('garbage\n')).toBeUndefined()
    expect(cgroupCpuCounters('usage_usec x\nnr_periods -1\n')).toBeUndefined()
    // A full v2 file as the kernel writes it, extra counters included.
    expect(cgroupCpuCounters('usage_usec 81234567\nuser_usec 60000000\nsystem_usec 21234567\ncore_sched.force_idle_usec 0\nnr_periods 9000\nnr_throttled 120\nthrottled_usec 4500000\nnr_bursts 0\nburst_usec 0\n'))
      .toEqual({ usage_usec: 81234567, user_usec: 60000000, system_usec: 21234567, nr_periods: 9000, nr_throttled: 120, throttled_usec: 4500000 })
    // A command name holding spaces and ')' must not shift the fields.
    expect(procCpuTicks(procStat(250, 75))).toEqual({ utime: 250, stime: 75 })
    expect(procCpuTicks(undefined)).toBeUndefined(); expect(procCpuTicks('4242 (bun) S 1 2')).toBeUndefined(); expect(procCpuTicks('no paren')).toBeUndefined()
    expect(procCpuTicks('4242 (bun) S 1 4242 4242 0 -1 4194304 10 0 0 0 x 5 0 0\n')).toBeUndefined()
    // A full 52-field Linux 6.x line for a bun process.
    const kernel = '31337 (bun) S 31300 31337 31300 34816 31337 4194560 18821 0 3 0 1234 567 0 0 20 0 14 0 8812345 1180000256 52113 18446744073709551615 '
      + '94347000000000 94347050000000 140733000000000 0 0 0 0 16781312 134235650 0 0 0 17 3 0 0 0 0 0 94347060000000 94347061000000 94347070000000 140733000100000 140733000100100 140733000100100 140733000102000 0\n'
    expect(kernel.trim().split(' ')).toHaveLength(52)
    expect(procCpuTicks(kernel)).toEqual({ utime: 1234, stime: 567 })
  })
  test('phase PIDs keep valid name=pid entries and always add the observing process', () => {
    expect(phasePids('server=12,stub=34', 99)).toEqual([['server', 12], ['stub', 34], ['observer', 99]])
    expect(phasePids('server=12,observer=5,Bad=1,stub=x,=3', 99)).toEqual([['server', 12], ['observer', 99]])
    expect(phasePids(undefined, 7)).toEqual([['observer', 7]])
  })
  test('phase CPU deltas per wave: elapsed, cgroup usage and throttling, per-process user/system, unknown when unread or backwards', () => {
    const at = (phase: string, ms: number, usage: number, throttled: number, server: [number, number] | null, stub: string | undefined) =>
      phaseCpuSample(phase, ms, `usage_usec ${usage}\nuser_usec ${usage / 2}\nsystem_usec ${usage / 2}\nnr_periods ${ms / 100}\nnr_throttled ${throttled}\nthrottled_usec ${throttled * 1000}\n`,
        [['server', server ? procStat(...server) : undefined], ['stub', stub], ['observer', procStat(0, 0)]])
    const samples: PhaseCpuSample[] = [at('probe', 1000, 0, 0, [100, 10], procStat(5, 5)), at('roots', 1500, 400_000, 0, [130, 20], procStat(6, 5)),
      at('replies-drops', 3500, 4_400_000, 50, [330, 60], undefined), at('end', 4500, 4_000_000, 60, null, procStat(9, 9))]
    const lines = phaseCpuResults(samples).map(r => resultLine({ scenario: 'test-44-fmk-thread-burst', mode: 'open', population: 100000, recipients: 2 }, r))
    const tick = 1000 / SR8_USER_HZ
    expect(lines).toEqual([
      `recorded: sr8 observe-cpu scenario=test-44-fmk-thread-burst mode=open population=100000 recipients=2 samples=2 phase=probe elapsed_ms=500 cpu_usage_ms=400 cpu_user_ms=200 cpu_system_ms=200 cpus_busy=0.8 nr_periods=5 nr_throttled=0 throttled_ms=0 server_user_ms=${30 * tick} server_system_ms=${10 * tick} stub_user_ms=${tick} stub_system_ms=0 observer_user_ms=0 observer_system_ms=0 limit=none verdict=recorded`,
      `recorded: sr8 observe-cpu scenario=test-44-fmk-thread-burst mode=open population=100000 recipients=2 samples=2 phase=roots elapsed_ms=2000 cpu_usage_ms=4000 cpu_user_ms=2000 cpu_system_ms=2000 cpus_busy=2 nr_periods=20 nr_throttled=50 throttled_ms=50 server_user_ms=${200 * tick} server_system_ms=${40 * tick} stub_user_ms=unknown stub_system_ms=unknown observer_user_ms=0 observer_system_ms=0 limit=none verdict=recorded`,
      // A counter that went backwards (a replaced cgroup) and an exited server are unknown, never negative.
      'recorded: sr8 observe-cpu scenario=test-44-fmk-thread-burst mode=open population=100000 recipients=2 samples=2 phase=replies-drops elapsed_ms=1000 cpu_usage_ms=unknown cpu_user_ms=unknown cpu_system_ms=unknown cpus_busy=unknown nr_periods=10 nr_throttled=10 throttled_ms=10 server_user_ms=unknown server_system_ms=unknown stub_user_ms=unknown stub_system_ms=unknown observer_user_ms=0 observer_system_ms=0 limit=none verdict=recorded',
    ])
    expect(phaseCpuResults([])).toEqual([]); expect(phaseCpuResults(samples.slice(0, 1))).toEqual([])
  })

  // Server clock = stub clock + 10000; only durations ever cross processes.
  const ts = (n: number) => `1700000000.00000${n}`
  const items: BurstItem[] = [
    { key: 'alpha', phase: 'held', channel: 'C0HOLD', ts: ts(1), sender: 'UHUMAN', envelope_id: 'h-a' },
    { key: 'alpha', phase: 'roots', channel: 'C0ROOT', ts: ts(2), sender: 'UHUMAN', envelope_id: 'r1-a' },
    { key: 'alpha', phase: 'roots', channel: 'C0ROOT', ts: ts(3), sender: 'UHUMAN', envelope_id: 'r2-a' },
    { key: 'beta', phase: 'roots', channel: 'C0ROOT', ts: ts(2), sender: 'UHUMAN', envelope_id: 'r1-b' },
    { key: 'alpha', phase: 'dropped', channel: 'C0DROP', ts: ts(4), sender: 'UHUMAN', envelope_id: 'd1-a' },
    { key: 'alpha', phase: 'replies', channel: 'C0ROOT', ts: ts(5), sender: 'UHUMAN' },
  ]
  const stub = (id: string, sent: number, ack: number, acks = 1): Times => ({ envelope_id: id, push: { sent_mono_ms: sent, connection_id: 'c' },
    acks: Array.from({ length: acks }, () => ({ ack_mono_ms: ack, connection_id: 'c' })) })
  const times = [stub('h-a', 100, 150), stub('r1-a', 1002, 1102), stub('r2-a', 1001, 3001), stub('r1-b', 1000, 1500), stub('d1-a', 5000, 5010)]
  const ack = (keys: string[], n: number | string, receiveToAckMs: number, received: number, ackCallMs?: number, outcome: 'acked' | 'ack-failed' | 'suppressed' = 'acked') =>
    serverLine(ackTimingMeasurement({ keys, ts: typeof n === 'string' ? n : ts(n), targets: [], outcome, receiveToAckMs, ...(ackCallMs !== undefined ? { ackCallMs } : {}),
      atMonoMs: received + receiveToAckMs + (ackCallMs ?? 0) }), received + receiveToAckMs + (ackCallMs ?? 0))
  const state = '/state'
  const append = (key: string, journal: 'queue' | 'threads', at: number, records: number, appendMs: number, fileFsyncMs: number, dirFsyncMs: number) =>
    serverLine(durableAppendMeasurement({ dir: join(state, journal), path: join(state, journal, `${key}.jsonl`), records, bytes: records * 40, appendMs,
      fileFsyncMs, dirFsyncMs, fsyncs: 2, atMonoMs: at }, state)!, at)
  function observedServerRows(): string[] {
    return [
      append('alpha', 'queue', 9000, 1, 5, 3, 1),
      ack(['alpha'], 1, 40, 10100, 1),
      append('alpha', 'queue', 10130, 1, 10, 6, 3),
      ack(['alpha'], 2, 90, 11000, 2), ack(['alpha'], 3, 1500, 11000, 0),
      // Two rows for one event cannot be matched to either push.
      ack(['beta'], 2, 30, 11000, 1), ack(['beta'], 2, 31, 11000, 1),
      append('alpha', 'queue', 11050, 3, 20, 12, 6), append('beta', 'queue', 11200, 1, 4, 2, 1), append('alpha', 'threads', 11300, 2, 8, 5, 2),
      JSON.stringify({ v: 1, kind: 'store', key: 'alpha', seq: 2, store: 'accepted', store_ms: 1, at_mono_ms: 11010 }),
      JSON.stringify({ v: 1, kind: 'store', key: 'alpha', seq: 1, store: 'fixed', store_ms: 1, at_mono_ms: 11400 }),
      serverLine(threadSaveMeasurement({ key: 'alpha', records: 2, joins: 2, intents: 0, outcomes: 0 }), 11310),
      ack(['alpha'], 4, 5, 15000),
      append('alpha', 'queue', 20000, 1, 3, 2, 1),
    ]
  }
  const rows = () => observedServerRows().map(l => JSON.parse(l))
  test('membership ACK diagnostics correlate independent clocks and durable targets without changing N1', () => {
    const server = rows()
    server.find(r => r.kind === 'ack' && r.ts === ts(2) && r.keys[0] === 'alpha').targets = [{ key: 'alpha', seq: 2 }]
    const diagnostics = membershipAckDiagnostics(items, times, server, percentile)
    const own = diagnostics.filter(r => r.stats.persona === 'alpha')
    expect(own[0].stats).toMatchObject({ diagnostic: 'ack-summary', stub_max_ms: 2000, server_max_ms: 1500,
      receive_to_store_max_ms: 10, store_to_ack_max_ms: 80, ack_call_max_ms: 2 })
    expect(own[1].stats).toMatchObject({ diagnostic: 'ack-slow', rank: 1, envelope: 'r2-a', stub_ms: 2000, server_ms: 1500,
      gap_ms: 500, stub_sent_mono_ms: 1001, stub_ack_mono_ms: 3001, server_received_mono_ms: 11000,
      server_ack_return_mono_ms: 12500, receive_to_store_ms: 'none', store_to_ack_ms: 'none' })
    expect(own[2].stats).toMatchObject({ envelope: 'r1-a', receive_to_store_ms: 10, store_to_ack_ms: 80, ack_call_ms: 2 })
    const beta = diagnostics.filter(r => r.stats.persona === 'beta')
    expect(beta[0].stats).toMatchObject({ server_events: 0, server_ambiguous: 1, server_max_ms: 'none' })
    expect(beta[1].stats).toMatchObject({ server: 'ambiguous', server_ms: 'none', stub_ms: 500 })
    expect(diagnostics.every(r => r.verdict === 'recorded' && r.limit === 'none')).toBe(true)
    expect(diagnostics.map(r => resultLine({ scenario: 'test-56', mode: 'strict', population: 100000, recipients: 2 }, r))
      .every(l => l.startsWith('recorded: sr8 diag '))).toBe(true)
    expect(ackVerdict('n1', ['too-slow'], [stub('too-slow', 1, 3002)]).verdict).toBe('fail')
    expect(SR8_ACK_LIMIT_MS).toBe(3000)
  })
  test('membership ACK diagnostics bound output per persona, retain missing samples, and omit unsafe identities', () => {
    const ev = Array.from({ length: 9 }, (_, i) => ({ ...items[1], envelope_id: `e-${i}`, ts: ts(i) }))
    const diagnostics = membershipAckDiagnostics(ev, ev.map((i, n) => stub(i.envelope_id, n, 100 + 2 * n)), [], percentile)
    expect(diagnostics).toHaveLength(6)
    expect(diagnostics[0].stats).toMatchObject({ stub_events: 9, server_missing: 9, server_max_ms: 'none' })
    expect(diagnostics.slice(1).map(r => r.stats.envelope)).toEqual(['e-8', 'e-7', 'e-6', 'e-5', 'e-4'])
    const unacked = membershipAckDiagnostics([items[1]], [{ ...times[1], acks: [] }], [], percentile)
    expect(unacked).toHaveLength(1)
    expect(unacked[0].stats).toMatchObject({ stub_events: 0, server_events: 0, stub_max_ms: 'none' })
    const unsafe = membershipAckDiagnostics([{ ...items[1], key: 'bad\nkey', envelope_id: 'bad\nid', phase: 'bad\nphase' }],
      [stub('bad\nid', 0, 1)], [], percentile)
    expect(unsafe[1].stats).toMatchObject({ persona: 'missing', envelope: 'missing', phase: 'missing' })
    expect(membershipAckDiagnostics([], [], [], percentile)).toEqual([])
  })
  test('membership append diagnostics separate journals, acceptance groups, fsync waits and window boundaries on the server clock', () => {
    const ev = [items[0], items[1], items[2], { ...items[5], envelope_id: 'reply' }, items[3]]
    const ackAt = (key: string, n: number, received: number, returned: number) => JSON.parse(ack([key], n, returned - received - 1, received, 1))
    const stored = (key: string, seq: number, store: string, at: number) => ({ kind: 'store', key, seq, store, at_mono_ms: at })
    const server = [
      ackAt('alpha', 1, 1000, 1010), ackAt('alpha', 2, 1100, 1210), ackAt('alpha', 3, 1110, 1310),
      ackAt('alpha', 5, 1400, 1510), ackAt('beta', 2, 1150, 1260),
      JSON.parse(append('alpha', 'queue', 980, 1, 5, 3, 1)), // before the burst
      JSON.parse(append('alpha', 'queue', 1105, 1, 10, 6, 2)), // straddles roots start
      JSON.parse(append('alpha', 'queue', 1140, 2, 20, 12, 3)),
      JSON.parse(append('alpha', 'threads', 1140.5, 1, 10, 6, 2)), // cannot steal the pending queue append
      stored('alpha', 1, 'accepted', 1141), stored('alpha', 2, 'post-hold', 1141),
      JSON.parse(append('beta', 'queue', 1160, 1, 10, 6, 2)), stored('beta', 1, 'accepted', 1161),
      JSON.parse(append('alpha', 'queue', 1200, 1, 30, 18, 2)), stored('alpha', 1, 'fixed', 1201),
      JSON.parse(append('alpha', 'queue', 1300, 1, 40, 25, 5)), stored('alpha', 3, 'memory-hold', 1301),
      JSON.parse(append('alpha', 'threads', 1320, 2, 30, 18, 2)), // straddles roots end
      JSON.parse(append('alpha', 'queue', 1380, 2, 20, 12, 3)), stored('alpha', 4, 'accepted', 1381), // partial group evidence
      JSON.parse(append('alpha', 'queue', 1500, 2, 20, 12, 3)), // other queue records need no store row
      JSON.parse(append('alpha', 'queue', 1525, 1, 10, 6, 2)), // after the burst
    ].sort((a, b) => a.at_mono_ms - b.at_mono_ms)
    const all = membershipAppendDiagnostics(ev, server, percentile)
    const row = (key: string, window: string, journal: string) => all.find(r => r.stats.persona === key && r.stats.window === window && r.stats.journal === journal)!
    expect(all).toHaveLength(12)
    expect(row('alpha', 'roots', 'queue-acceptance').stats).toMatchObject({
      window_complete: 'yes', window_events: 2, window_acked: 2, window_start_mono_ms: 1100, window_end_mono_ms: 1310, wall_ms: 210,
      appends: 2, records_total: 3, records_min: 1, records_p50: 1, records_max: 2,
      append_sum_ms: 60, append_p50_ms: 20, append_p99_ms: 40, append_max_ms: 40,
      fsync_sum_ms: 45, fsync_p50_ms: 15, fsync_p99_ms: 30, fsync_max_ms: 30,
      non_fsync_sum_ms: 15, non_fsync_p50_ms: 5, non_fsync_p99_ms: 10, non_fsync_max_ms: 10,
      file_fsync_sum_ms: 37, dir_fsync_sum_ms: 8, fsync_calls: 4, append_wall_ratio: .286, unclassified_queue_appends: 0,
    })
    expect(row('alpha', 'roots', 'queue-other').stats).toMatchObject({ appends: 1, append_sum_ms: 30, boundary_appends: 1 })
    expect(row('alpha', 'roots', 'thread-memory').stats).toMatchObject({ appends: 1, append_sum_ms: 10, boundary_appends: 1 })
    expect(row('alpha', 'burst', 'queue-acceptance').stats).toMatchObject({ wall_ms: 510, appends: 2, append_sum_ms: 60, unclassified_queue_appends: 1 })
    expect(row('alpha', 'burst', 'queue-other').stats).toMatchObject({ appends: 3, append_sum_ms: 60, boundary_appends: 0 })
    expect(row('alpha', 'burst', 'thread-memory').stats).toMatchObject({ appends: 2, append_sum_ms: 40 })
    expect(row('beta', 'roots', 'queue-acceptance').stats).toMatchObject({ wall_ms: 110, appends: 1, records_total: 1, append_sum_ms: 10 })
    expect(all.map(r => resultLine({ scenario: 'test-56', mode: 'strict', population: 100000, recipients: 2 }, r))
      .every(l => l.startsWith('recorded: sr8 diag ') && l.includes('diagnostic=append-cost') && l.endsWith('limit=none verdict=recorded'))).toBe(true)
  })
  test('membership append diagnostics require complete ACK windows, distinguish zero samples, and reject impossible fsync costs', () => {
    const server = JSON.parse(ack(['alpha'], 2, 10, 100, 1))
    const app = JSON.parse(append('alpha', 'queue', 108, 1, 5, 3, 1))
    for (const missing of [[], [server, server], [{ ...server, outcome: 'suppressed' }]]) {
      const all = membershipAppendDiagnostics([items[1]], [app, ...missing], percentile)
      expect(all).toHaveLength(6)
      expect(all.every(r => r.stats.window_complete === 'no' && r.stats.wall_ms === 'none'
        && r.stats.append_sum_ms === 'none' && r.stats.fsync_sum_ms === 'none' && r.stats.append_wall_ratio === 'none')).toBe(true)
    }
    const noAppends = membershipAppendDiagnostics([items[1]], [server], percentile)
    expect(noAppends[0].stats).toMatchObject({ window_complete: 'yes', appends: 0, append_sum_ms: 0, append_p50_ms: 'none', records_min: 'none', append_wall_ratio: 'none' })
    const noRoots = membershipAppendDiagnostics([{ ...items[1], phase: 'replies' }], [server], percentile)
    expect(noRoots.find(r => r.stats.window === 'roots')!.stats).toMatchObject({ window_complete: 'no', window_events: 0, wall_ms: 'none' })
    const zero = membershipAppendDiagnostics([items[1]], [{ ...server, receive_to_ack_ms: 0, ack_call_ms: 0 }], percentile)
    expect(zero[0].stats).toMatchObject({ window_complete: 'yes', wall_ms: 0, append_wall_ratio: 'none' })
    expect(() => membershipAppendDiagnostics([items[1]], [server, { ...app, file_fsync_ms: 6 }], percentile)).toThrow('invalid append timings')
    expect(membershipAppendDiagnostics([], [], percentile)).toEqual([])
  })
  const none3 = (prefix: string) => `${prefix}_p50_ms=none ${prefix}_p99_ms=none ${prefix}_max_ms=none`
  test('both ACK clocks match per event by key and Slack ts, with the server receipt rebuilt from its own row; every ledger item is kept', () => {
    const samples = ackClockSamples(items, times, rows())
    expect(samples).toEqual([
      { phase: 'held', wave: 'probe', key: 'alpha', ordinal: 1, sent: 100, stub_status: 'acked', stub: 50, server_status: 'acked', server: 40, received: 10100, acked: 10141 },
      { phase: 'roots', wave: 'roots', key: 'alpha', ordinal: 1, sent: 1002, stub_status: 'acked', stub: 100, server_status: 'acked', server: 90, received: 11000, acked: 11092 },
      { phase: 'roots', wave: 'roots', key: 'alpha', ordinal: 2, sent: 1001, stub_status: 'acked', stub: 2000, server_status: 'acked', server: 1500, received: 11000, acked: 12500 },
      // Two server rows for one event: neither is a sample.
      { phase: 'roots', wave: 'roots', key: 'beta', ordinal: 1, sent: 1000, stub_status: 'acked', stub: 500, server_status: 'ambiguous' },
      { phase: 'dropped', wave: 'replies-drops', key: 'alpha', ordinal: 1, sent: 5000, stub_status: 'acked', stub: 10, server_status: 'acked', server: 5, received: 15000, acked: 15005 },
      // The reply has no envelope and no server row, and is still represented.
      { phase: 'replies', wave: 'replies-drops', key: 'alpha', ordinal: 1, stub_status: 'missing', server_status: 'missing' },
    ])
    // A doubled stub ACK is no stub sample; the server side still matches.
    expect(ackClockSamples(items.slice(0, 1), [stub('h-a', 100, 150, 2)], rows())).toEqual([{ phase: 'held', wave: 'probe', key: 'alpha', ordinal: 1, sent: 100,
      stub_status: 'ambiguous', server_status: 'acked', server: 40, received: 10100, acked: 10141 }])
    const c = { scenario: 'test-44-fmk-thread-burst', mode: 'strict', population: 0, recipients: 2 } as const
    const head = 'recorded: sr8 observe-ack scenario=test-44-fmk-thread-burst mode=strict population=0 recipients=2'
    const attempts = `${none3('suppressed')} ${none3('ack_failed')} limit=none verdict=recorded`
    expect(ackClockResults(samples, percentile).map(r => resultLine(c, r))).toEqual([
      `${head} samples=1 phase=held stub_events=1 server_events=1 matched=1 stub_unacked=0 stub_ambiguous=0 server_ambiguous=0 suppressed=0 ack_failed=0 stub_p50_ms=50 stub_p99_ms=50 stub_max_ms=50 server_p50_ms=40 server_p99_ms=40 server_max_ms=40 gap_p50_ms=10 gap_p99_ms=10 gap_max_ms=10 ${attempts}`,
      `${head} samples=3 phase=roots stub_events=3 server_events=2 matched=2 stub_unacked=0 stub_ambiguous=0 server_ambiguous=1 suppressed=0 ack_failed=0 stub_p50_ms=500 stub_p99_ms=2000 stub_max_ms=2000 server_p50_ms=90 server_p99_ms=1500 server_max_ms=1500 gap_p50_ms=10 gap_p99_ms=500 gap_max_ms=500 ${attempts}`,
      `${head} samples=1 phase=dropped stub_events=1 server_events=1 matched=1 stub_unacked=0 stub_ambiguous=0 server_ambiguous=0 suppressed=0 ack_failed=0 stub_p50_ms=10 stub_p99_ms=10 stub_max_ms=10 server_p50_ms=5 server_p99_ms=5 server_max_ms=5 gap_p50_ms=5 gap_p99_ms=5 gap_max_ms=5 ${attempts}`,
      `${head} samples=1 phase=replies stub_events=0 server_events=0 matched=0 stub_unacked=0 stub_ambiguous=0 server_ambiguous=0 suppressed=0 ack_failed=0 ${none3('stub')} ${none3('server')} ${none3('gap')} ${attempts}`,
    ])
    // Runs follow stub push order, not ledger order; an unpushed event is in no run.
    expect(ackBinResults(samples.filter(s => s.phase === 'roots'), 10).map(r => [r.samples, r.stats])).toEqual([
      [1, { phase: 'roots', bin: 1, bins: 3, stub_max_ms: 500, server_max_ms: 'none', gap_max_ms: 'none' }],
      [1, { phase: 'roots', bin: 2, bins: 3, stub_max_ms: 2000, server_max_ms: 1500, gap_max_ms: 500 }],
      [1, { phase: 'roots', bin: 3, bins: 3, stub_max_ms: 100, server_max_ms: 90, gap_max_ms: 10 }],
    ])
    expect(ackBinResults(samples.filter(s => s.phase === 'replies'), 10)).toEqual([])
    const many: ClockSample[] = Array.from({ length: 25 }, (_, n) => ({ phase: 'roots', wave: 'roots', key: 'alpha', ordinal: n + 1, sent: n,
      stub_status: 'acked', stub: n, server_status: 'missing' }))
    expect(ackBinResults(many, 10).map(r => [r.samples, r.stats.stub_max_ms])).toEqual([[2, 1], [3, 4], [2, 6], [3, 9], [2, 11], [3, 14], [2, 16], [3, 19], [2, 21], [3, 24]])
  })
  test('per-event ACK lines keep each event\'s own pair, so a run\'s three maxima from three events stay attributable; every ledger item has one line', () => {
    const rts = (n: number) => `1700000100.${String(n).padStart(6, '0')}`
    const ev: BurstItem[] = [['alpha', 1], ['beta', 2], ['alpha', 3], ['beta', 4], ['alpha', 5]].map(([key, n]) =>
      ({ key: key as string, phase: 'roots', channel: 'C0ROOT', ts: rts(n as number), sender: 'UHUMAN', envelope_id: `e${n}` }))
    // e1 has the run's largest stub delay, e2 its largest server delay, e3 its largest gap.
    const stubs = [stub('e1', 0, 900), stub('e2', 10, 890), stub('e3', 20, 620), stub('e4', 30, 130), stub('e5', 40, 41, 2)]
    const server = [ack(['alpha'], rts(1), 850, 20000, 1), ack(['beta'], rts(2), 870, 20010, 1), ack(['alpha'], rts(3), 100, 20020, 1), ack(['beta'], rts(4), 90, 20030, 1)]
      .map(l => JSON.parse(l))
    const samples = ackClockSamples(ev, stubs, server)
    expect(ackBinResults(samples, 1).map(r => r.stats)).toEqual([{ phase: 'roots', bin: 1, bins: 1, stub_max_ms: 900, server_max_ms: 870, gap_max_ms: 500 }])
    const c = { scenario: 'test-44-fmk-thread-burst', mode: 'open', population: 100000, recipients: 2 } as const
    const head = 'recorded: sr8 observe-ack-event scenario=test-44-fmk-thread-burst mode=open population=100000 recipients=2 samples=1 phase=roots'
    expect(ackEventResults(samples).map(r => resultLine(c, r))).toEqual([
      `${head} persona=alpha ordinal=1 offset_ms=0 stub=acked stub_ms=900 server=acked server_ms=850 gap_ms=50 attempt_ms=none limit=none verdict=recorded`,
      `${head} persona=beta ordinal=1 offset_ms=10 stub=acked stub_ms=880 server=acked server_ms=870 gap_ms=10 attempt_ms=none limit=none verdict=recorded`,
      `${head} persona=alpha ordinal=2 offset_ms=20 stub=acked stub_ms=600 server=acked server_ms=100 gap_ms=500 attempt_ms=none limit=none verdict=recorded`,
      `${head} persona=beta ordinal=2 offset_ms=30 stub=acked stub_ms=100 server=acked server_ms=90 gap_ms=10 attempt_ms=none limit=none verdict=recorded`,
      `${head} persona=alpha ordinal=3 offset_ms=40 stub=ambiguous stub_ms=none server=missing server_ms=none gap_ms=none attempt_ms=none limit=none verdict=recorded`,
    ])
    // Every ledger item: one line, persona ordinals 1..n with none skipped or repeated.
    const all = ackEventResults(ackClockSamples(items, times, rows()))
    expect(all).toHaveLength(items.length)
    expect(all.map(r => `${r.stats.phase}/${r.stats.persona}/${r.stats.ordinal}`))
      .toEqual(['held/alpha/1', 'roots/alpha/1', 'roots/alpha/2', 'roots/beta/1', 'dropped/alpha/1', 'replies/alpha/1'])
    expect(all.at(-1)!.stats).toEqual({ phase: 'replies', persona: 'alpha', ordinal: 1, offset_ms: 'none', stub: 'missing', stub_ms: 'none', server: 'missing',
      server_ms: 'none', gap_ms: 'none', attempt_ms: 'none' })
  })
  test('suppressed and failed server attempts are counted and timed apart, never ACK samples or wave endpoints', () => {
    const rts = (n: number) => `1700000200.${String(n).padStart(6, '0')}`
    const ev: BurstItem[] = [1, 2, 3, 4].map(n => ({ key: 'alpha', phase: 'roots', channel: 'C0ROOT', ts: rts(n), sender: 'UHUMAN', envelope_id: `s${n}` }))
    // s2 is suppressed (no ACK reaches the stub), s3's ack call threw; s1 and s4 are acked.
    const stubs: Times[] = [stub('s1', 0, 40), stub('s2', 1, 0, 0), stub('s3', 2, 0, 0), stub('s4', 3, 60)]
    const server = [ack(['alpha'], rts(1), 30, 30000, 1), ack(['alpha'], rts(2), 4000, 30000, undefined, 'suppressed'),
      ack(['alpha'], rts(3), 700, 30000, 2, 'ack-failed'), ack(['alpha'], rts(4), 50, 30005, 1),
      append('alpha', 'queue', 30200, 1, 5, 3, 1)].map(l => JSON.parse(l))
    const samples = ackClockSamples(ev, stubs, server)
    expect(samples.map(s => [s.stub_status, s.server_status, s.server, s.attempt, s.received, s.acked])).toEqual([
      ['acked', 'acked', 30, undefined, 30000, 30031], ['unacked', 'suppressed', undefined, 4000, undefined, undefined],
      ['unacked', 'ack-failed', undefined, 700, undefined, undefined], ['acked', 'acked', 50, undefined, 30005, 30056]])
    // The wave ends at the last ACK (30056), not at the suppression (34000) or the failed call.
    const waves = serverWaves(samples)
    expect(waves).toEqual([{ wave: 'roots', start: 30000, end: 30056 }])
    expect(appendResults(server, waves, percentile).map(r => r.stats.phase)).toEqual(['after'])
    const c = { scenario: 'test-44-fmk-thread-burst', mode: 'strict', population: 0, recipients: 2 } as const
    expect(ackClockResults(samples, percentile).map(r => resultLine(c, r))).toEqual([
      'recorded: sr8 observe-ack scenario=test-44-fmk-thread-burst mode=strict population=0 recipients=2 samples=4 phase=roots stub_events=2 server_events=2 matched=2 stub_unacked=2 stub_ambiguous=0 server_ambiguous=0 suppressed=1 ack_failed=1 stub_p50_ms=40 stub_p99_ms=57 stub_max_ms=57 server_p50_ms=30 server_p99_ms=50 server_max_ms=50 gap_p50_ms=7 gap_p99_ms=10 gap_max_ms=10 suppressed_p50_ms=4000 suppressed_p99_ms=4000 suppressed_max_ms=4000 ack_failed_p50_ms=700 ack_failed_p99_ms=700 ack_failed_max_ms=700 limit=none verdict=recorded',
    ])
    expect(ackBinResults(samples, 1).map(r => r.stats)).toEqual([{ phase: 'roots', bin: 1, bins: 1, stub_max_ms: 57, server_max_ms: 50, gap_max_ms: 10 }])
    expect(ackEventResults(samples).map(r => [r.stats.stub, r.stats.server, r.stats.server_ms, r.stats.attempt_ms]))
      .toEqual([['acked', 'acked', 30, 'none'], ['unacked', 'suppressed', 'none', 4000], ['unacked', 'ack-failed', 'none', 700], ['acked', 'acked', 50, 'none']])
    // A pushed event whose only server row is a suppression reports no server sample and no wave.
    const lone = ackClockSamples(ev.slice(1, 2), stubs.slice(1, 2), server)
    expect(resultLine(c, ackClockResults(lone, percentile)[0]!)).toContain(' stub_events=0 server_events=0 matched=0 stub_unacked=1 stub_ambiguous=0 server_ambiguous=0 suppressed=1 ack_failed=0 ')
    expect(serverWaves(lone)).toEqual([])
    // An unknown outcome is not a row at all.
    expect(ackClockSamples(ev.slice(0, 1), stubs.slice(0, 1), [{ ...server[0], outcome: 'other' }])[0]!.server_status).toBe('missing')
  })
  test('server waves and phases come from matched ACK rows on the server clock', () => {
    const waves = serverWaves(ackClockSamples(items, times, rows()))
    expect(waves).toEqual([{ wave: 'probe', start: 10100, end: 10141 }, { wave: 'roots', start: 11000, end: 12500 }, { wave: 'replies-drops', start: 15000, end: 15005 }])
    expect([0, 10099, 10100, 10999, 11000, 14999, 15005, 15006].map(at => serverPhase(at, waves)))
      .toEqual(['before', 'before', 'probe', 'probe', 'roots', 'roots', 'replies-drops', 'after'])
    expect(serverPhase(5, [])).toBe('unphased')
  })
  test('appends per phase and journal give group size and append/fsync spreads; saves count stores, fixed appends and Thread Memory saves', () => {
    const waves = serverWaves(ackClockSamples(items, times, rows()))
    expect(appendResults(rows(), waves, percentile).map(r => [r.samples, r.stats])).toEqual([
      [1, { phase: 'before', journal: 'queue', records: 1, group_p50: 1, group_p99: 1, group_max: 1, append_p50_ms: 5, append_p99_ms: 5, append_max_ms: 5, append_total_ms: 5,
        file_fsync_p50_ms: 3, file_fsync_p99_ms: 3, file_fsync_max_ms: 3, file_fsync_total_ms: 3, dir_fsync_p50_ms: 1, dir_fsync_p99_ms: 1, dir_fsync_max_ms: 1, dir_fsync_total_ms: 1, fsyncs: 2 }],
      [1, { phase: 'probe', journal: 'queue', records: 1, group_p50: 1, group_p99: 1, group_max: 1, append_p50_ms: 10, append_p99_ms: 10, append_max_ms: 10, append_total_ms: 10,
        file_fsync_p50_ms: 6, file_fsync_p99_ms: 6, file_fsync_max_ms: 6, file_fsync_total_ms: 6, dir_fsync_p50_ms: 3, dir_fsync_p99_ms: 3, dir_fsync_max_ms: 3, dir_fsync_total_ms: 3, fsyncs: 2 }],
      [2, { phase: 'roots', journal: 'queue', records: 4, group_p50: 1, group_p99: 3, group_max: 3, append_p50_ms: 4, append_p99_ms: 20, append_max_ms: 20, append_total_ms: 24,
        file_fsync_p50_ms: 2, file_fsync_p99_ms: 12, file_fsync_max_ms: 12, file_fsync_total_ms: 14, dir_fsync_p50_ms: 1, dir_fsync_p99_ms: 6, dir_fsync_max_ms: 6, dir_fsync_total_ms: 7, fsyncs: 4 }],
      [1, { phase: 'roots', journal: 'thread-memory', records: 2, group_p50: 2, group_p99: 2, group_max: 2, append_p50_ms: 8, append_p99_ms: 8, append_max_ms: 8, append_total_ms: 8,
        file_fsync_p50_ms: 5, file_fsync_p99_ms: 5, file_fsync_max_ms: 5, file_fsync_total_ms: 5, dir_fsync_p50_ms: 2, dir_fsync_p99_ms: 2, dir_fsync_max_ms: 2, dir_fsync_total_ms: 2, fsyncs: 2 }],
      [1, { phase: 'after', journal: 'queue', records: 1, group_p50: 1, group_p99: 1, group_max: 1, append_p50_ms: 3, append_p99_ms: 3, append_max_ms: 3, append_total_ms: 3,
        file_fsync_p50_ms: 2, file_fsync_p99_ms: 2, file_fsync_max_ms: 2, file_fsync_total_ms: 2, dir_fsync_p50_ms: 1, dir_fsync_p99_ms: 1, dir_fsync_max_ms: 1, dir_fsync_total_ms: 1, fsyncs: 2 }],
    ])
    expect(saveResults(rows(), waves).map(r => [r.samples, r.stats])).toEqual([
      [0, { phase: 'probe', span_ms: 41, stores: 0, fixed: 0, thread_saves: 0, save_records: 0, joins: 0, intents: 0, outcomes: 0 }],
      [3, { phase: 'roots', span_ms: 1500, stores: 1, fixed: 1, thread_saves: 1, save_records: 2, joins: 2, intents: 0, outcomes: 0 }],
      [0, { phase: 'replies-drops', span_ms: 5, stores: 0, fixed: 0, thread_saves: 0, save_records: 0, joins: 0, intents: 0, outcomes: 0 }],
    ])
  })
  test('observe prints inputs, CPU, ACK clocks, runs, appends and saves; every line is recorded, numbers and fixed words only', () => {
    const cpu = [phaseCpuSample('roots', 0, v2, []), phaseCpuSample('end', 10, v2, [])]
    const all = observeResults({ rows: rows(), items, times, cpu }, percentile)
    expect([...new Set(all.map(r => r.measure))]).toEqual(['observe-inputs', 'observe-cpu', 'observe-ack', 'observe-ack-bin', 'observe-append', 'observe-saves', 'observe-ack-event'])
    expect(all.filter(r => r.measure === 'observe-ack-event')).toHaveLength(items.length)
    expect(all.every(r => r.verdict === 'recorded' && r.limit === 'none')).toBe(true)
    expect(all[0]!.stats).toEqual({ measurements: 'read', burst: 'read', times: 'read', cpu: 'read' })
    const c = { scenario: 'test-44-fmk-thread-burst', mode: 'open', population: 100000, recipients: 2 } as const
    for (const r of all) expect(resultLine(c, r)).toMatch(/^recorded: sr8 observe-[a-z-]+ scenario=test-44-fmk-thread-burst mode=open population=100000 recipients=2 samples=\d+( [a-z0-9_]+=(-?[\d.]+|[a-z-]+))+ limit=none verdict=recorded$/)
    const none = observeResults({}, percentile)
    expect(none.map(r => [r.measure, r.stats])).toEqual([['observe-inputs', { measurements: 'missing', burst: 'missing', times: 'missing', cpu: 'missing' }]])
  })
})

test('SR-8 inventories page at the requested MEMBERSHIP_PAGE_LIMIT: stub memberships and the scripts\' raw page chains, traversed as CSCB requests them', async () => {
  const channels = Array.from({ length: 2 * MEMBERSHIP_PAGE_LIMIT + 3 }, (_, i) => `C0PAGE${String(i).padStart(5, '0')}`)
  // The actual helper builds each chain; the control patch only prints its pages.
  const built = shell([
    'require_ci_image() { :; }', declaration(scenario, 'slack_stub_inventory_body'), declaration(scenario, 'slack_stub_inventory_pages'),
    `_scenario_stub_control_patch() { shift; jq -cn "$@" '$pages[0]'; }`,
    `slack_stub_inventory_pages normal '' '' ${MEMBERSHIP_PAGE_LIMIT} ${channels.join(' ')}`,
    // test-45's later-page case: one current positive first, the rest paged.
    `slack_stub_inventory_body later ${channels[0]}`,
    `slack_stub_inventory_pages later later '' ${MEMBERSHIP_PAGE_LIMIT} ${channels.slice(1).join(' ')}`,
    `slack_stub_inventory_pages short '' after ${MEMBERSHIP_PAGE_LIMIT}`,
  ].join('\n'))
  expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
  const [normal, first, later, short] = built.stdout.trim().split('\n').map(line => JSON.parse(line))
  expect(Object.keys(normal)).toEqual(['', 'first-page-2', 'first-page-3'])
  expect(Object.keys(later)).toEqual(['later', 'later-page-2', 'later-page-3'])
  expect(short).toEqual({ '': { ok: true, channels: [], response_metadata: { next_cursor: 'after' } } })
  mkdirSync('/tmp/c9', { recursive: true })
  const root = mkdtempSync('/tmp/c9/sr8-inventory-pages-'), recordPath = join(root, 'record.jsonl')
  const rule = (label: string, answers: StubAnswers) => ({ suffix: label, label, auth: 'ok', connections: 'ok', ...answers })
  const stub = startSlackStub({ recordPath, control: { tokens: [rule('members', { memberships: channels }),
    rule('normal', { inventory_pages: normal }), rule('later', { inventory_pages: { '': first, ...later } })] } })
  const captured: unknown[] = []
  async function request(label: string, args: Record<string, string>) {
    const page = await fetch(`${stub.apiUrl}users.conversations`, { method: 'POST', body: new URLSearchParams(args),
      headers: { Authorization: `Bearer ${fakeToken(BOT_TOKEN_PREFIX, label)}`, 'Content-Type': 'application/x-www-form-urlencoded' } }).then(r => r.json())
    captured.push(page)
    return page
  }
  async function traverse(label: string) {
    const sizes: number[] = [], seen: string[] = []
    let cursor = ''
    do {
      const page = await request(label, { types: 'public_channel,private_channel', limit: String(MEMBERSHIP_PAGE_LIMIT), ...(cursor ? { cursor } : {}) })
      expect(page.ok).toBe(true)
      sizes.push(page.channels.length); seen.push(...page.channels.map((c: { id: string }) => c.id))
      cursor = page.response_metadata.next_cursor
    } while (cursor)
    return { sizes, seen }
  }
  try {
    for (const label of ['members', 'normal']) {
      expect(await traverse(label)).toEqual({ sizes: [MEMBERSHIP_PAGE_LIMIT, MEMBERSHIP_PAGE_LIMIT, 3], seen: channels })
    }
    expect(await traverse('later')).toEqual({ sizes: [1, MEMBERSHIP_PAGE_LIMIT, MEMBERSHIP_PAGE_LIMIT, 2], seen: channels })
    // Unlimited requests keep one page; a cursor the stub never issued is refused.
    const all = await request('members', {})
    expect([all.channels.length, all.response_metadata.next_cursor]).toEqual([channels.length, ''])
    for (const cursor of ['stubmembers-0', 'stubmembers-01', 'unknown']) expect(await request('members', { cursor, limit: '1' })).toEqual({ ok: false, error: 'invalid_cursor' })
  } finally { await stub.stop() }
  try { assertNoLeak({ captured, record: readFileSync(recordPath, 'utf8') }) } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a staged inventory replaces only its label\'s inventory, in place: fault counters survive, the snapshot follows, and refusals are recorded', async () => {
  const channels = Array.from({ length: MEMBERSHIP_PAGE_LIMIT + 2 }, (_, i) => `C0STAGE${String(i).padStart(5, '0')}`)
  const fault = { method: 'users.conversations', outcome: 'error', error: 'internal_error', times: 1 }
  const seeded = { tokens: [{ label: 'p', suffix: 'p', memberships: ['C0PKEPT'], faults: [fault] }, { label: 'q', suffix: 'q', memberships: [] }] }
  // The real helper builds the request; curl is replaced to capture it.
  const built = shell([
    'require_ci_image() { :; }', 'fail() { printf \'%s\\n\' "$*" >&2; exit 1; }', '_scenario_scratch_file() { :; }',
    '_scenario_check_stub_url() { :; }', 'write_file() { cat > "$1"; }',
    'curl() { local n=1; while [[ -e "$HOME/request-${n}.json" ]]; do n=$((n + 1)); done; cat > "$HOME/request-${n}.json"; printf \'{"ok":true,"seq":%d}\' "$((40 + n))"; }',
    `_scenario_stub_control_patch() { shift; jq -cn "$@" '$pages[0]'; }`,
    declaration(scenario, 'slack_stub_inventory_body'), declaration(scenario, 'slack_stub_inventory_pages'), declaration(scenario, 'slack_stub_inventory_stage'),
    'SCENARIO_SLACK_CONTROL="$HOME/control.json" SCENARIO_SLACK_STUB_URL=http://127.0.0.1:1 SCENARIO_SLACK_PUSH_S=5',
    `slack_stub_inventory_stage q ${MEMBERSHIP_PAGE_LIMIT} ${channels.join(' ')}`,
    'slack_stub_inventory_stage p memberships C0PSTAGED',
    `slack_stub_inventory_pages q '' '' ${MEMBERSHIP_PAGE_LIMIT} ${channels.join(' ')}`,
    'cat "$HOME/request-1.json" "$HOME/request-2.json" "$HOME/control.json"',
  ].join('\n'), { 'control.json': JSON.stringify(seeded) + '\n' })
  expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
  const lines = built.stdout.trim().split('\n')
  expect(lines.slice(0, 2)).toEqual(['41', '42'])
  const [chain, pagesRequest, membersRequest, snapshot] = lines.slice(2).map(line => JSON.parse(line))
  // The staged chain is the one slack_stub_inventory_pages installs from the first cursor.
  expect(pagesRequest).toEqual({ label: 'q', inventory_pages: chain }); expect(Object.keys(chain)).toEqual(['', 'first-page-2'])
  expect(membersRequest).toEqual({ label: 'p', memberships: ['C0PSTAGED'] })
  expect(snapshot).toEqual({ tokens: [{ ...seeded.tokens[0], memberships: ['C0PSTAGED'] }, { ...seeded.tokens[1], inventory_pages: chain }] })

  mkdirSync('/tmp/c9', { recursive: true })
  const root = mkdtempSync('/tmp/c9/sr8-inventory-stage-'), recordPath = join(root, 'record.jsonl')
  const stub = startSlackStub({ recordPath, control: structuredClone(seeded) as any })
  const base = stub.apiUrl.replace(/api\/$/, ''), captured: unknown[] = []
  const ids = async (label: string) => {
    const page = await fetch(`${stub.apiUrl}users.conversations`, { method: 'POST', body: new URLSearchParams({}),
      headers: { Authorization: `Bearer ${fakeToken(BOT_TOKEN_PREFIX, label)}`, 'Content-Type': 'application/x-www-form-urlencoded' } }).then(r => r.json())
    captured.push(page)
    return page.ok ? page.channels.map((c: { id: string }) => c.id) : page.error
  }
  const stage = async (body: unknown) => {
    const response = await fetch(`${base}_inventory`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
    const answer = { status: response.status, body: await response.json() }
    captured.push(answer)
    return answer
  }
  try { try {
    expect(await ids('p')).toBe('internal_error')
    const answers = [await stage(membersRequest), await stage(pagesRequest)]
    expect(answers.map(a => [a.status, a.body.ok, typeof a.body.seq])).toEqual([[200, true, 'number'], [200, true, 'number']])
    // The one-shot fault has fired; a staged inventory does not re-arm it.
    expect(await ids('p')).toEqual(['C0PSTAGED'])
    expect(await ids('q')).toEqual(channels.slice(0, MEMBERSHIP_PAGE_LIMIT))
    for (const [body, status, error] of [[{ label: 'nobody', memberships: [] }, 409, 'unknown-label'], [{ label: 'p' }, 400, 'inventory-invalid'],
      [{ label: 'p', memberships: [], faults: [] }, 400, 'inventory-invalid'], [{ label: 'p', memberships: 'C0PSTAGED' }, 400, 'inventory-invalid'],
      [{ label: '', memberships: [] }, 400, 'inventory-invalid']] as const) {
      expect(await stage(body)).toEqual({ status, body: { ok: false, error } })
    }
    expect(await ids('p')).toEqual(['C0PSTAGED'])
    // A control replacement, by contrast, re-arms every fault.
    stub.setControl(structuredClone(seeded) as any)
    expect(await ids('p')).toBe('internal_error')
    const records = readFileSync(recordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const staged = records.filter(r => r.event === 'inventory')
    expect(staged.map(r => [r.seq, r.label, r.fields])).toEqual([[answers[0].body.seq, 'p', ['memberships']], [answers[1].body.seq, 'q', ['inventory_pages']]])
    expect(records.filter(r => r.event === 'inventory-refused').map(r => r.reason))
      .toEqual(['unknown-label', 'inventory-invalid', 'inventory-invalid', 'inventory-invalid', 'inventory-invalid'])
    expect(records.filter(r => r.event === 'control').map(r => r.seq).filter(seq => seq > staged[0].seq)).toHaveLength(1)
  } finally { await stub.stop() }
  assertNoLeak({ captured, record: readFileSync(recordPath, 'utf8') })
  } finally { rmSync(root, { recursive: true, force: true }) }
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
  // answers28: only personas with stored burst items in Q's window must rewrite there.
  test.each([['a P with independent items must rewrite in it', false], ['a P with every item withheld (all) is proved by a skip', true]] as const)
  ('the compaction window is Q\'s original store span, never P\'s items or recovery replays; %s', (_name, all) => {
    const e = composed(all), [p, q] = e.plan.keys as [string, string]
    expect(e.plan.all).toBe(all); expect(faultRewriters(e.plan)).toEqual(all ? [q] : [p, q])
    // Q's held probe's store starts the span at 99 and its others end it at 1000; P's stores, replays' included, come later.
    for (const r of e.rows!) if (r.key === p) r.at_mono_ms = 200_000
    expect(faultWindow(e)).toEqual({ start: 99, end: 1000 })
    const verdict = (entries: Measurement[]) => compactionVerdict(e.plan.keys.map(key => ({ key, kind: 'queue', before: '1:1', after: '1:2', inside: true })),
      [...e.rows!, ...entries], faultWindow(e), e.plan.keys, true, faultRewriters(e.plan)).verdict
    const qEntries = [compactionRow(q, 99, 150, 'skipped'), compactionRow(q, 900, 1000, 'rewritten')]
    expect(verdict([compactionRow(p, 200, 300, 'rewritten'), ...qEntries])).toBe('pass')
    // P's rewrite after Q's last store, among P's own later stores, is outside Q's burst: P only skipped inside it.
    expect(verdict([compactionRow(p, 1500, 199_000, 'rewritten'), compactionRow(p, 200, 300, 'skipped'), ...qEntries])).toBe(all ? 'pass' : 'fail')
    // P still needs an in-span entry, and Q always a rewrite.
    expect(verdict([compactionRow(p, 1500, 199_000, 'rewritten'), ...qEntries])).toBe('missing')
    expect(verdict([compactionRow(p, 200, 300, 'rewritten'), compactionRow(q, 99, 150, 'skipped')])).toBe('fail')
    // Without one of Q's acceptances or its store there is no window.
    const reply = e.plan.items.find(i => i.key === q && i.phase === 'replies')!
    expect(faultWindow({ ...e, rows: e.rows!.filter(r => !(r.key === q && r.seq === reply.ordinal + 1)) })).toBeUndefined()
    expect(faultWindow({ ...e, queues: { ...e.queues, [q]: e.queues[q]!.filter(a => a.ts !== reply.ts) } })).toBeUndefined()
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
  test.each([true, false])('fault waves mark each wave as its sends start, for the CPU profile (held probes=%p)', async withHeld => {
    const items = composed().plan.items.filter(i => i.ordinal < 4 || (i.phase === 'replies' && i.ordinal < 2 * SR8_BURST_JOINS + 4) || (withHeld && i.phase === 'held'))
    const calls: string[] = []
    const good = await faultWaves(items, async i => { calls.push(`send:${i.phase}`) }, async batch => { calls.push(`wait:${batch[0]?.phase}`); return true },
      async () => { calls.push('admitted'); return true }, undefined, wave => calls.push(`mark:${wave}`))
    expect(good).toBe(true)
    const marks = calls.filter(s => s.startsWith('mark:'))
    expect(marks).toEqual([...(withHeld ? ['mark:held'] : []), 'mark:roots', 'mark:replies-drops'])
    if (withHeld) expect(calls.indexOf('mark:held')).toBe(0)
    // Each mark follows the previous wave's waits and leads its own wave's sends.
    expect(calls.indexOf('mark:roots')).toBe(withHeld ? calls.indexOf('admitted') + 1 : 0)
    expect(calls[calls.indexOf('mark:roots') + 1]).toBe('send:roots')
    expect(calls.indexOf('mark:replies-drops')).toBe(calls.indexOf('wait:roots') + 1)
    expect(calls[calls.indexOf('mark:replies-drops') + 1]).toBe('send:replies')
    // A failed wave marks no later wave, and no caller needs to pass a mark.
    const stopped: string[] = []
    expect(await faultWaves(items, async () => {}, async () => false, async () => true, undefined, wave => stopped.push(wave))).toBe(false)
    expect(stopped).toEqual(withHeld ? ['held'] : ['roots'])
    expect(await faultWaves(items, async () => {}, async () => true, async () => true)).toBe(true)
  })
  test.each([['strict', false], ['strict', true], ['open', false], ['open', true]] as const)
  ('ordered writes release the tail after the result mark, or abort without an early release (%s, failed=%p)', (mode, failed) => {
    const result = shell([
      `MODE=${mode}; BAD=${failed ? 1 : 0}`,
      'OUT="$HOME"; WRITES="$HOME/writes"; mkdir "$WRITES"; Q=beta; ROOT="$HOME"; CONFIG="$HOME/config"',
      'WRITE_CHANNEL=C0WRITE; WRITE_TOOL=fixture; WAIT_S=1; CASE_MARK=0; CASE=fixture',
      'trap \'if [[ -f "$OUT/tail-release" ]]; then echo release=yes; else echo release=no; fi\' EXIT',
      'membership_writes() { [[ ! -e "$OUT/tail-release" ]] || fail early-release; [[ "$BAD" == 0 ]] || fail "write failed"; WRITE_RESULT=2; }',
      'read_jsonl() { if [[ "$1" == */after.jsonl ]]; then [[ -f "$OUT/tail-release" && "$WRITE_RESULT" == 2 ]] || fail result-order; fi; }',
      'wait_until() { :; }',
      'slack_post_mark() { [[ ! -e "$OUT/tail-release" ]] || fail early-release; printf 2; }',
      'scenario_attempt_id() { printf id; }', 'attempt_args() { printf "{}"; }',
      'stub_session_submit() { printf id; }',
      'stub_session_result() { [[ "$BAD" == 0 ]] || fail "write failed"; printf \'{"isError":false,"text":"expected"}\'; }',
      'printed() { printf expected; }',
      declaration(source('lib/membership-load.sh'), 'ordered_writes'),
      'ordered_writes; printf "result=%s\\n" "$WRITE_RESULT"',
    ].join('\n'))
    expect(result.status).toBe(failed ? 1 : 0)
    expect(result.stdout).toBe(failed ? 'release=no\n' : 'result=2\nrelease=yes\n')
    expect(result.stderr).toBe(failed ? 'write failed\n' : '')
  })
  test.each([null, 'bun "${E}" fault-burst', 'BURST_PID=$!', 'track_pid "${BURST_PID}"', 'then ordered_writes; fi'])
  ('fault-burst receives the release file in both modes and is tracked before ordered writes can fail (removed marker=%p)', removed => {
    const original = source('lib/membership-load.sh')
    const pin = (load: string) => {
      expect(load).not.toContain('TAIL_RELEASE=')
      const burst = load.indexOf('bun "${E}" fault-burst')
      expect(burst).toBeGreaterThanOrEqual(0)
      const pid = load.indexOf('BURST_PID=$!', burst)
      expect(pid).toBeGreaterThanOrEqual(0)
      expect(burst).toBeLessThan(pid)
      expect(load.slice(burst, pid)).toContain('"${MEASURE_MARK}" "${WAIT_MS}" "${OUT}/tail-release"')
      const tracked = load.indexOf('track_pid "${BURST_PID}"'), writes = load.indexOf('then ordered_writes; fi')
      expect(tracked).toBeGreaterThanOrEqual(0)
      expect(writes).toBeGreaterThanOrEqual(0)
      expect(tracked).toBeLessThan(writes)
    }
    if (removed === null) pin(original)
    else {
      expect(original).toContain(removed)
      const mutated = original.replace(removed, '')
      expect(mutated).not.toContain(removed)
      expect(() => pin(mutated)).toThrow()
    }
  })

  test.each([true, false])('fault waves hold Q\'s tail until released (released=%p), keeping the whole burst', async released => {
    const plan = composed().plan, tail = faultTail(plan), calls: string[] = [], sent = new Set<number>()
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.every(i => i.phase === 'replies' && i.key !== plan.key && !i.dependent)).toBe(true)
    const late = new Set(tail.map(i => i.ordinal))
    const good = await faultWaves(plan.items, async i => { sent.add(i.ordinal); calls.push(late.has(i.ordinal) ? 'tail' : 'send') },
      async () => { calls.push('wait'); return true }, async () => true,
      { items: tail, released: async () => { calls.push('release'); return released } })
    expect(good).toBe(released); expect(sent.size).toBe(plan.items.length)
    expect(calls.lastIndexOf('send')).toBeLessThan(calls.indexOf('release'))
    expect(calls.indexOf('tail')).toBeGreaterThan(calls.indexOf('release'))
    expect(calls.filter(s => s === 'tail')).toHaveLength(tail.length)
  })
  test.each(['strict', 'open'] as const)('%s fault waves with a non-tail send held: both modes withhold Q\'s tail', async mode => {
    const plan = composed().plan, tail = new Set(faultTail(plan).map(i => i.ordinal))
    const second = plan.items.filter(i => !['roots', 'held'].includes(i.phase)), stuck = second.find(i => !tail.has(i.ordinal))!
    const submitted = new Set<number>()
    let resolve!: () => void, reached!: () => void
    const pending = new Promise<void>(r => { resolve = r }), started = new Promise<void>(r => { reached = r })
    const option = faultTailOption(mode, plan, async () => true)
    const done = faultWaves(plan.items, i => {
      submitted.add(i.ordinal)
      if (i.ordinal !== stuck.ordinal) return Promise.resolve()
      reached(); return pending
    }, async () => true, async () => true, option)
    await started; await new Promise(r => setTimeout(r, 0))
    const before = second.filter(i => submitted.has(i.ordinal)).length
    expect(before).toBe(second.length - tail.size)
    resolve()
    expect(await done).toBe(true); expect(submitted.size).toBe(plan.items.length)
    expect(option?.items).toEqual(faultTail(plan))
    expect(option?.items).toHaveLength(SR8_FAULT_TAIL_ITEMS)
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
  async function withCLI(body: (root: string, cli: (command: string, args: string[], population?: number) => ReturnType<typeof spawnSync>) => void | Promise<void>, prefix = '') {
    const root = mkdtempSync(join(tmpdir(), 'sr8-cli-'))
    try {
      const dir = join(root, 'tests/integration/fixtures'), marker = join(root, 'image')
      mkdirSync(dir, { recursive: true }); mkdirSync(join(root, 'tests/test-helpers'), { recursive: true }); writeFileSync(marker, '')
      writeFileSync(join(dir, 'sr8-evidence.ts'), prefix + source('fixtures/sr8-evidence.ts').replace("existsSync('/etc/cscb-ci-image')", `existsSync(${JSON.stringify(marker)})`))
      writeFileSync(join(dir, 'sr8-attribution.ts'), source('fixtures/sr8-attribution.ts'))
      writeFileSync(join(dir, 'transcript-receipts.ts'), source('fixtures/transcript-receipts.ts'))
      writeFileSync(join(root, 'tests/test-helpers/thread-populations.ts'), readFileSync(join(import.meta.dir, 'test-helpers/thread-populations.ts')))
      writeFileSync(join(dir, 'fmk-texts.ts'), `import {readFileSync} from 'node:fs'; if(process.argv[2]==='sharedQueueSnapshot') console.log(readFileSync(process.argv[3],'utf8')); else console.log(${JSON.stringify({ THREAD_REPLY_HOLD_MS, DELIVERY_MAX_AD_CALLS_PER_S, NAME_LOOKUP_TIMEOUT_MS })}[process.argv[2]]);`)
      const cli = (command: string, args: string[], population = 0) => {
        const child = spawnSync(process.execPath, [join(dir, 'sr8-evidence.ts'), command,
          ...(['envelope-times', 'combinations'].includes(command) ? [] : ['test-fault', 'strict', String(population), '2']), ...args],
          // observe prints one line per burst event: a full workload exceeds the default 1 MiB.
          { env: hostSafeChildEnv(root, { extras: { SCENARIO_ROOT: root } }), encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024 })
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
      // test-32's file also holds the server's thread-compaction lines; n4 reads past them.
      writeFileSync(join(root, 'measurements'), lines([
        { v: 1, kind: 'store', store: 'accepted', key, seq: accepted[0].seq, at_mono_ms: 100, store_ms: 1 },
        compactionRow(key, 100, 150, 'skipped'),
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
  test.each(['default', 'configured', 'missing-transition', 'not-waiting'] as const)
  ('test-32 opens idle only after one poll plus the declared margin, requiring AD turn-end evidence: %s', defect => {
    const script = source('test-32-fmk-real-order.sh')
    const settle = block(script, '    real_ad get --instance-id "${THREAD_INSTANCE}" > "${REAL_THREAD_EVIDENCE}/turn-end.json"',
      '    THREAD_EMPTY_START="$(date +%s.%6N)"')
    const pollMs = defect === 'configured' ? DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS * 2 : DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS
    const row = { state: defect === 'not-waiting' ? 'working' : 'waiting',
      ...(defect === 'missing-transition' ? {} : { state_changed_at: '2026-11-16T00:00:01.000Z' }) }
    const r = shell([
      'REAL_THREAD_EVIDENCE="$HOME"; THREAD_INSTANCE=measured; SCENARIO_FIXTURES="$HOME"',
      `printf '%s' '${JSON.stringify(defect === 'configured' ? { agent_director_poll_interval_ms: pollMs } : {})}' > "$HOME/config.json"`,
      `real_ad() { printf '%s' '${JSON.stringify(row)}'; }`,
      `bun() { [[ "$2" == DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS ]] || exit 1; printf '%s' '${DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS}'; }`,
      'sleep() { printf "settle_s=%s\\n" "$1"; }',
      declaration(scenario, '_scenario_us_text'), settle,
      'echo "transition=$THREAD_TURN_END_START"',
    ].join('\n'))
    const passes = ['default', 'configured'].includes(defect)
    expect(r.status).toBe(passes ? 0 : 1)
    if (passes) {
      expect(r.stdout).toContain(`settle_s=${((pollMs + 1000) / 1000).toFixed(6)}\n`)
      expect(r.stdout).toContain(`transition=${Date.parse(row.state_changed_at!) / 1000}.000000`)
    } else {
      expect(r.stdout).not.toContain('settle_s=')
      expect(r.stderr).toContain('N3 final turn-end timestamp unavailable')
    }
  })
  test.each(['zero', 'one-each', 'two-one-persona', 'idle-get', 'missing-reaction', 'missing-instance',
    'wrong-boundary', 'outside-active', 'duplicate', 'invalid-time'] as const)
  ('N3 CLI separately bounds turn-end gets per persona and keeps idle zero: %s', defect => withCLI((root, cli) => {
    const ids = sr8Personas(2).map(key => `cscb_${key}`)
    const rows = ids.map((id, i) => `${i + 1}\t1.5\t100\tget\t${id}\t--instance-id`)
    if (defect !== 'zero') rows.push(...ids.map((id, i) => `${i + 3}\t2.5\t100\tget\t${id}\t--instance-id`))
    if (defect === 'two-one-persona') rows.push(`5\t2.75\t100\tget\t${ids[0]}\t--instance-id`)
    if (defect === 'idle-get') rows.push(`5\t3\t100\tget\t${ids[0]}\t--instance-id`)
    writeFileSync(join(root, 'calls'), rows.join('\n') + '\n')
    writeFileSync(join(root, 'active'), ids.map(id => `${id}\t1\t3\n`).join(''))
    writeFileSync(join(root, 'empty'), ids.map(id => `${id}\t3\t13\n`).join(''))
    const reaction = ids.slice(0, defect === 'missing-instance' ? 1 : 2)
      .map(id => `${id}\t${defect === 'outside-active' ? 0.5 : defect === 'invalid-time' ? 'invalid' : 2}\t${defect === 'wrong-boundary' ? 2.9 : 3}\n`)
    if (defect === 'duplicate') reaction.push(reaction[0])
    if (defect !== 'missing-reaction') writeFileSync(join(root, 'reaction'), reaction.join(''))
    const child = cli('windows', ['calls', 'empty', 'active', 'reaction'].map(f => join(root, f)))
    const passes = ['zero', 'one-each'].includes(defect)
    expect(child.status).toBe(passes ? 0 : 1)
    expect(child.stdout).toContain('recorded: sr8 n3-turn-end ')
    if (passes) expect(child.stdout).toContain(`max_gets_per_persona=${defect === 'zero' ? 0 : 1} measured_instances=2 limit=1 verdict=pass`)
    if (defect === 'two-one-persona') expect(child.stdout).toContain('max_gets_per_persona=2 measured_instances=2 limit=1 verdict=fail')
    if (defect === 'idle-get') {
      expect(child.stdout).toContain('empty_calls=1')
      expect(child.stdout).toContain('max_gets_per_persona=1 measured_instances=2 limit=1 verdict=pass')
    }
  }))
  // Samples are [admission, delivery) = [100, 200) and [300, 400); each kind's
  // operation is shifted by 200 ms per kind. Recorded ends are poll-bounded, so
  // only a start inside a sample is credited, except a strict write, which
  // must lie wholly inside (the CLI context is strict).
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
    // A slow strict write that only starts inside its sample is not a durable overlap.
    const strictPasses = passes && defect !== 'start-inside-end-after'
    const strict = concurrentOverlapVerdicts(operations, samples, defect === 'missing-n2' ? undefined : measured, 'strict')
    expect(evidenceExit(strict)).toBe(strictPasses ? 0 : 1)
    if (defect === 'start-inside-end-after') expect(strict.map(r => r.verdict)).toEqual(['pass', 'missing'])
    writeFileSync(join(root, 'operations'), operations.map(o => `${o.kind}\t${o.id}\t${o.start_epoch_ms}\t${o.end_epoch_ms}\n`).join(''))
    writeFileSync(join(root, 'samples'), samples.map(s => `${s.key}\t${s.seq}\t${s.start_epoch_ms}\t${s.end_epoch_ms}\n`).join(''))
    if (defect !== 'missing-n2') writeFileSync(join(root, 'n2'), measured.map(s => `recorded: sr8 n2-sample key=${s.key} seq=${s.seq} name=${s.name} verdict=pass\n`).join(''))
    const child = cli('concurrent-overlap', [join(root, 'operations'), join(root, 'samples'), join(root, 'n2')])
    expect(child.status).toBe(strictPasses ? 0 : 1)
    expect(child.stdout).toContain('thread-membership-overlap'); expect(child.stdout).toContain('thread-write-overlap')
    expect(child.stdout).toContain(`verdict=${strictPasses ? 'pass' : 'missing'}`)
  }))
  // Sample [100, 200); membership always starts and ends inside it.
  test.each([
    ['contained', 150, 180, 'pass', 'pass'], ['starts-at-admission', 100, 199, 'pass', 'pass'],
    ['ends-at-delivery', 150, 200, 'pass', 'missing'], ['slow-ack', 190, 260, 'pass', 'missing'],
    ['starts-before-admission', 90, 150, 'missing', 'missing'],
  ] as const)('a strict write is credited only when its whole push-to-ACK span lies inside a measured sample: %s', (_name, start, end, open, strict) => {
    const epoch = 1700000000000, key = sr8Personas(1)[0], measured = [{ key, seq: 1, name: 'resolved' }]
    const samples = [{ key, seq: 1, start_epoch_ms: epoch + 100, end_epoch_ms: epoch + 200 }]
    const operations = [{ kind: 'membership', id: 'EvALPHA', start_epoch_ms: epoch + 150, end_epoch_ms: epoch + 180 },
      { kind: 'write', id: 'EvBETA', start_epoch_ms: epoch + start, end_epoch_ms: epoch + end }]
    const got = (mode?: string) => concurrentOverlapVerdicts(operations, samples, measured, mode).map(r => [r.measure, r.verdict, r.limit])
    expect(got()).toEqual([['thread-membership-overlap', 'pass', 'start-inside-measured-sample'], ['thread-write-overlap', open, 'start-inside-measured-sample']])
    expect(got('strict')).toEqual([['thread-membership-overlap', 'pass', 'start-inside-measured-sample'], ['thread-write-overlap', strict, 'durable-inside-measured-sample']])
  })
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
  // fault-check's evidence directory for composed(); `before` gives each key's pre-burst joins, `after` its post-restart extras.
  function faultCheckEvidence(root: string, before: (key: string) => object[] = () => [], after: (key: string) => object[] = () => [], population = 0, denied = false) {
    const e = composed(denied), dir = join(root, 'e'); mkdirSync(join(dir, 'during'), { recursive: true })
    writeFileSync(join(dir, 'fault-plan.json'), JSON.stringify({ context: { scenario: 'test-fault', mode: 'strict', population, recipients: 2 }, plan: e.plan }))
    writeFileSync(join(dir, 'fault-ledger.jsonl'), lines(e.ledger!))
    writeFileSync(join(dir, 'during-times.jsonl'), lines(e.during!)); writeFileSync(join(dir, 'times.jsonl'), lines(e.times!))
    writeFileSync(join(dir, 'compactions.jsonl'), '')
    writeFileSync(join(root, 'stub'), lines(e.stub!)); writeFileSync(join(root, 'measurements'), lines(e.rows!))
    for (const key of e.plan.keys) {
      writeFileSync(join(dir, `${key}.queue.jsonl`), lines(e.queues[key]!))
      writeFileSync(join(dir, 'during', `${key}.queue.jsonl`), lines(e.duringQueues[key]!))
      writeFileSync(join(dir, `${key}.before.jsonl`), before(key).length ? lines(before(key)) : '')
      writeFileSync(join(dir, `${key}.after.jsonl`), lines([...e.plan.items.filter(i => i.key === key && i.phase === 'roots').map(i => ({ channel: i.channel, root: i.ts })), ...after(key)]))
    }
    return { e, dir, args: [dir, join(root, 'stub'), String(e.clearMark), String(e.clearAt), join(root, 'measurements'), '0', '0', '1'] }
  }
  test('fault CLI check reads every original, replay, snapshot and unchanged ordinary predicate', () => withCLI((root, cli) => {
    const { e, dir, args } = faultCheckEvidence(root)
    const pass = cli('fault-check', args)
    expect(pass.status).toBe(0); expect(String(pass.stdout)).toContain('fault-overlap'); expect(String(pass.stdout)).toContain('post-hold-overlap')
    const q = e.plan.items.find(i => i.key !== e.plan.key)!
    e.times!.find(t => t.envelope_id === `original-${q.ordinal}`)!.acks[0].ack_mono_ms++
    writeFileSync(join(dir, 'times.jsonl'), lines(e.times!))
    const fail = cli('fault-check', args)
    expect(fail.status).toBe(1); expect(String(fail.stdout)).toContain('verdict=fail'); expect(String(fail.stdout)).toContain('recorded: sr8 summary')
  }))
  // answers28: a P with independent items must rewrite inside Q's span; a P with every item withheld (all) is proved by a skip.
  test.each([
    ['a P with independent items that only skipped fails', false, 'samples=3 required=4 queue=2 threads=1 rewritten=1 skipped=2 outside=1 window_ms=901', 'fail'],
    ['a P with every item withheld that only skipped passes', true, 'samples=4 required=4 queue=2 threads=2 rewritten=1 skipped=2 outside=1 window_ms=901', 'pass'],
  ] as const)('fault CLI check reads Thread Memory compactions from its measurement file over Q\'s original store span: %s', (_name, all, stats, verdict) => withCLI((root, cli) => {
    const { e, dir, args } = faultCheckEvidence(root, undefined, undefined, 100_000, all), [p, q] = e.plan.keys as [string, string]
    writeFileSync(join(dir, 'compactions.jsonl'), lines(e.plan.keys.map(key => ({ key, kind: 'queue', before: '1:1', after: '1:2', inside: true }))))
    // Q's own acceptance stores span 99..1000 on the server clock; P's stores, replays' included, come later.
    for (const r of e.rows!) if (r.key === p) r.at_mono_ms = 200_000
    const run = (entries: string[]) => {
      writeFileSync(join(root, 'measurements'), lines(e.rows!) + entries.map(l => `${l}\n`).join(''))
      const out = String(cli('fault-check', args, 100_000).stdout).trim().split('\n')
      return { compaction: out.filter(l => l.startsWith('recorded: sr8 compaction ')),
        others: out.filter(l => !l.startsWith('recorded: sr8 compaction ') && !l.startsWith('recorded: sr8 summary ')) }
    }
    const line = (stats: string, verdict: string) => [`recorded: sr8 compaction scenario=test-fault mode=strict population=100000 recipients=2 ${stats} limit=inside-burst verdict=${verdict}`]
    // P's rewrite, after Q's last store and among P's own later stores, is outside Q's burst (window_ms is Q's alone): P only skipped inside it.
    const plain = run([]), measured = run([compactionLine(p, 200, 300, 'skipped'), compactionLine(p, 1500, 199_000, 'rewritten'),
      compactionLine(q, 99, 150, 'skipped'), compactionLine(q, 900, 1000, 'rewritten')])
    expect(plain.compaction).toEqual(line('samples=2 required=4 queue=2 threads=0 rewritten=0 skipped=0 outside=0 window_ms=901', 'missing'))
    expect(measured.compaction).toEqual(line(stats, verdict))
    expect(measured.others).toEqual(plain.others)
  }))
  test.each([
    ['kept after the restart passes', true],
    ['lost through the burst and restart fails', false],
  ])('fault CLI check judges each persona\'s joins by identity, printing the baseline excess: a notice\'s extra pre-burst join %s', (_name, kept) => withCLI((root, cli) => {
    const notice = (key: string) => [{ channel: 'C0LARGE00003', root: `5.${key}`, source: 'own-post' }]
    const { e, args } = faultCheckEvidence(root, notice, key => kept ? notice(key) : [])
    const child = cli('fault-check', args)
    expect(child.status).toBe(kept ? 0 : 1)
    expect(String(child.stdout).split('\n').filter(l => l.startsWith('recorded: sr8 joins '))).toEqual(e.plan.keys.map(key => {
      const roots = e.plan.items.filter(i => i.key === key && i.phase === 'roots').length, after = roots + (kept ? 1 : 0)
      return `recorded: sr8 joins scenario=test-fault mode=strict population=0 recipients=2 samples=${after} before=1 after=${after} oldest_retained=0 forgotten=0`
        + ` baseline_excess=1 excess_sources=own-post:1 excess_channels=C0LARGE00003:1 baseline_lost=${kept ? 0 : 1} burst_missing=0 persona=${key}`
        + ` limit=>=${roots} verdict=${kept ? 'pass' : 'fail'}`
    }))
  }))
  test.each([false, true])('fault CLI declares plan-derived dependencies and sends both waves without withheld ACKs (tail release=%p)', withTail => withCLI((root, cli) => {
    const e = composed(), batch = join(root, 'batches'), out = join(root, 'e'), state = join(root, 'state')
    mkdirSync(batch); mkdirSync(join(state, 'queue'), { recursive: true })
    const payloads = e.plan.items.map(i => ({ label: i.key, event: { channel: i.channel, ts: i.ts, user: i.sender, ...(i.root === '-' ? {} : { thread_ts: i.root }) } }))
    for (const phase of ['roots', 'replies', 'dropped', 'held']) writeFileSync(join(batch, `${phase}.batch.jsonl`), lines(payloads.filter((_, n) => e.plan.items[n].phase === phase)))
    const planned = e.plan.items.filter(i => i.key === e.plan.key && i.phase !== 'held').map(i => [i.phase, i.channel, i.ts, i.root, '-'].join('\t')).join('\n') + '\n'
    writeFileSync(join(root, 'plan.tsv'), planned); writeFileSync(join(root, 'stub'), ''); writeFileSync(join(root, 'measurements'), '')
    expect(cli('fault-plan', [batch, join(root, 'plan.tsv'), 'hang', '1', '1', out]).status).toBe(0)
    const declared = JSON.parse(readFileSync(join(out, 'fault-plan.json'), 'utf8')).plan
    expect(declared.items.map((i: any) => i.dependent)).toEqual(e.plan.items.map(i => i.dependent))
    expect(existsSync(join(root, 'tail-release'))).toBe(false)
    expect(cli('fault-burst', [out, 'http://127.0.0.1:1', join(root, 'stub'), state, join(root, 'measurements'), '0', '100',
      ...(withTail ? [join(root, 'tail-release')] : [])]).status).toBe(0)
    if (withTail) {
      const tail = e.plan.items.filter(i => i.phase === 'replies' && i.key !== e.plan.key && !i.dependent).slice(-SR8_FAULT_TAIL_ITEMS)
      const trace = readFileSync(join(root, 'tail-trace'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(tail).toHaveLength(SR8_FAULT_TAIL_ITEMS)
      expect(trace[0]).toEqual({ event: 'release', pushed: e.plan.items.length - tail.length })
      expect(trace.slice(1)).toEqual(tail.map(i => ({ event: 'tail', ordinal: i.ordinal, released: true })))
    }
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
    // The CPU profile's wave marks, only under SR8_PROFILE_DIR (none above); the
    // script marks `end`. A fresh plan, stub, queues and measurements.
    expect(readdirSync(join(root, 'profile'))).toEqual([])
    writeFileSync(join(root, 'profile-on'), '')
    writeFileSync(join(batch, 'held.batch.jsonl'), lines(payloads.filter((_, n) => e.plan.items[n].phase === 'held')))
    rmSync(join(state, 'queue'), { recursive: true }); mkdirSync(join(state, 'queue'))
    writeFileSync(join(root, 'stub'), ''); writeFileSync(join(root, 'measurements'), '')
    const profiled = join(root, 'profiled')
    expect(cli('fault-plan', [batch, join(root, 'plan.tsv'), 'hang', '1', '1', profiled]).status).toBe(0)
    expect(cli('fault-burst', [profiled, 'http://127.0.0.1:1', join(root, 'stub'), state, join(root, 'measurements'), '0', '100']).status).toBe(0)
    expect(readFileSync(join(root, 'profile/waves'), 'utf8')).toBe('held\nroots\nreplies-drops\n')
  }, `
// Synthetic transport only in this copied CLI. No server or network is used.
// The profile opt-in is set only when the test asks.
{ const base = resolve(import.meta.dir, '../../..'); mkdirSync(join(base, 'profile'), { recursive: true });
  if (existsSync(join(base, 'profile-on'))) process.env.SR8_PROFILE_DIR = join(base, 'profile') }
let transportPlan, releaseScheduled = false;
const submitted = new Set();
globalThis.fetch = async (_url, init) => {
  const base = resolve(import.meta.dir, '../../..'), dir = join(base, 'e');
  const plan = transportPlan ??= JSON.parse(readFileSync(join(dir, 'fault-plan.json'), 'utf8')).plan;
  const b = JSON.parse(init.body), i = plan.items.find(i => i.key === b.label && i.channel === b.event.channel && i.ts === b.event.ts);
  const id = 'original-' + i.ordinal;
  const releaseFile = join(base, 'tail-release'), trace = join(base, 'tail-trace');
  const withTail = process.argv[2] === 'fault-burst' && process.argv.at(-1) === releaseFile;
  const tail = plan.items.filter(i => i.phase === 'replies' && i.key !== plan.key && !i.dependent).slice(-SR8_FAULT_TAIL_ITEMS);
  if (withTail && tail.some(t => t.ordinal === i.ordinal)) {
    const released = existsSync(releaseFile);
    appendFileSync(trace, JSON.stringify({ event: 'tail', ordinal: i.ordinal, released })+'\\n');
    if (!released) return Response.json({ok:false}, {status:409});
  }
  submitted.add(i.ordinal);
  if (withTail && !releaseScheduled && submitted.size === plan.items.length - tail.length) {
    releaseScheduled = true;
    setImmediate(() => {
      appendFileSync(trace, JSON.stringify({ event: 'release', pushed: submitted.size })+'\\n');
      writeFileSync(releaseFile, '');
    });
  }
  appendFileSync(join(base,'stub'), JSON.stringify({event:'push',label:i.key,channel:i.channel,event_ts:i.ts,envelope_id:id})+'\\n');
  if (!i.dependent) appendFileSync(join(base,'stub'),JSON.stringify({event:'ws-message',envelope_id:id})+'\\n');
  if (i.phase === 'held') {
    appendFileSync(join(base,'state/queue',i.key+'.jsonl'),JSON.stringify({kind:'accepted',channel:i.channel,ts:i.ts,seq:i.ordinal+1})+'\\n');
    appendFileSync(join(base,'measurements'),JSON.stringify({v:1,kind:'store',store:'post-hold',key:i.key,seq:i.ordinal+1,at_mono_ms:1,store_ms:1})+'\\n');
  }
  return Response.json({ok:true,envelope_id:id});
};
`))
  test('burst probes lead the second wave inside the burst, and pending-post refuses its burst-free form', () => withCLI((root, cli) => {
    const batch = join(root, 'batches'), out = join(root, 'e'), keys = sr8Personas(2)
    mkdirSync(batch); writeFileSync(join(root, 'stub'), '')
    const body = (label: string, phase: string, n: number) => ({ label, event: { channel: 'C0BURST', ts: `${n}.${phase}`, user: 'UHUMAN',
      ...(phase === 'replies' ? { thread_ts: `${n}.roots` } : {}) } })
    for (const [phase, count] of [['roots', SR8_BURST_JOINS], ['replies', SR8_BURST_REPLIES], ['dropped', SR8_BURST_DROPPED]] as const)
      writeFileSync(join(batch, `${phase}.batch.jsonl`), lines(keys.flatMap(k => Array.from({ length: count }, (_, n) => body(k, phase, n)))))
    const probes = ['other', 'bot', 'none'].map((_, n) => ({ label: keys[0], event: { channel: 'C0HOLD', ts: `${n}.probe`, user: 'UHUMAN', thread_ts: '0.hold' } }))
    writeFileSync(join(batch, 'probes.batch.jsonl'), lines(probes))
    expect(cli('burst', [batch, 'http://127.0.0.1:1', join(root, 'stub'), join(root, 'state'), out, '1000']).status).toBe(0)
    const ledger: BurstItem[] = readFileSync(join(out, 'burst.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const roots = keys.length * SR8_BURST_JOINS
    expect(ledger).toHaveLength(roots + keys.length * (SR8_BURST_REPLIES + SR8_BURST_DROPPED) + probes.length)
    expect(ledger.slice(0, roots).every(i => i.phase === 'roots')).toBe(true)
    expect(ledger.slice(roots, roots + probes.length).map(i => [i.phase, i.ts])).toEqual(probes.map(p => ['probes', p.event.ts]))
    const stub = readFileSync(join(root, 'stub'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const probeRows = ledger.filter(i => i.phase === 'probes').map(i => ({ parent: 'bot', channel: i.channel, ts: i.ts, envelope_id: i.envelope_id! }))
    expect(pendingBurstVerdict(ledger, stub, probeRows, { startSeq: 0, endSeq: stub.at(-1).seq, compactMs: QUEUE_COMPACT_INTERVAL_MS,
      startMs: 0, endMs: 1, before: '1:2\n', after: '1:2\n' }).verdict).toBe('pass')
    expect(cli('pending-post', ['alpha', 'op', '0', '120000', ...Array(6).fill(join(root, 'absent')), '0', 'C0HOLD']).status).toBe(64)
  }, `
// Synthetic transport only in this copied CLI: each push is recorded, then its ACK.
let seq = 0;
globalThis.fetch = async (_url, init) => {
  const base = resolve(import.meta.dir, '../../..'), b = JSON.parse(init.body), id = b.label + '-' + b.event.ts;
  appendFileSync(join(base,'stub'), JSON.stringify({seq:++seq,event:'push',label:b.label,channel:b.event.channel,event_ts:b.event.ts,envelope_id:id})+'\\n');
  appendFileSync(join(base,'stub'), JSON.stringify({seq:++seq,event:'ws-message',envelope_id:id})+'\\n');
  return Response.json({ok:true,envelope_id:id});
};
`))
  // Real file permissions stand in for the kernel's checks on root-owned cgroup
  // files, so root, which opens any of them for writing, cannot run this case;
  // the injected-outcome tally above covers the verdict for every runner.
  test.skipIf(process.getuid?.() === 0)('driver-cpu reads the measured server\'s cgroup and burst-driver.sh\'s record: missing in one shared quota, passing when split, missing when a guarded file opens for writing or cannot be probed', () => withCLI((root, cli) => {
    const copy = join(root, 'tests/integration/fixtures/sr8-evidence.ts'), host = join(root, 'host')
    let text = readFileSync(copy, 'utf8')
    for (const [from, to] of [["const CGROUP_ROOT = '/sys/fs/cgroup'", `const CGROUP_ROOT = ${JSON.stringify(join(host, 'cgroup'))}`],
      ['textFile(`/proc/${pid}/cgroup`)', `textFile(join(${JSON.stringify(join(host, 'proc'))}, String(pid), 'cgroup'))`]]) {
      expect(text.split(from)).toHaveLength(2); text = text.replace(from, to)
    }
    // This case isolates the existing kernel permission/driver record control;
    // the combined real CLI collector is covered in cgroup-harness.test.ts.
    text = text.replace('const harness = harnessCpuEvidence(process.env.SCENARIO_ROOT, process.env.SLACK_STATE_DIR, record, c.recipients, cgroupFile, HARNESS_PROC_ROOT, Number(pid))',
      "const harness = { verdict: 'pass', stats: {} }")
    writeFileSync(copy, text)
    // Read-only files stand in for root-owned guarded files.
    const put = (path: string, contents: string, mode = 0o444) => {
      mkdirSync(dirname(join(host, path)), { recursive: true }); rmSync(join(host, path), { force: true }); writeFileSync(join(host, path), contents, { mode })
    }
    const stat = (usec: number) => `usage_usec ${usec}\nuser_usec 0\nsystem_usec 0\nnr_periods 0\nnr_throttled 0\nthrottled_usec 0\n`
    put('proc/101/cgroup', '0::/\n'); put('cgroup/cpu.max', '200000 100000\n'); put('cgroup/cpu.stat', stat(7_000)); put('cgroup/cgroup.procs', '1\n')
    writeFileSync(join(root, 'shared'), '/\n')
    const shared = cli('driver-cpu', ['101', join(root, 'shared')])
    expect({ status: shared.status, stdout: shared.stdout }).toEqual({ status: 1, stdout: 'recorded: sr8 driver-cpu scenario=test-fault mode=strict population=0 recipients=2 samples=1 '
      + 'server_cgroup=/ server_cpu_max=200000/100000 server_cpus=2 server_usage_ms=7 driver_cgroup=/ driver_cpu_max=200000/100000 driver_cpus=2 driver_usage_ms=7 shared_cpus=2 '
      + 'guarded_files=2 writable_files=0 unprobed_files=0 limit=2 verdict=missing\n'
      + 'recorded: sr8 summary scenario=test-fault measures=1 pass=0 fail=0 missing=1\n' })
    put('proc/102/cgroup', '0::/shard/server\n'); put('cgroup/cpu.max', '500000 100000\n'); put('cgroup/shard/cpu.max', 'max 100000\n')
    put('cgroup/shard/cgroup.procs', ''); put('cgroup/shard/driver/cgroup.procs', ''); put('cgroup/shard/server/cgroup.procs', '7\n')
    put('cgroup/shard/server/cpu.max', '200000 100000\n'); put('cgroup/shard/server/cpu.stat', stat(5_000))
    put('cgroup/shard/driver/cpu.max', '90000 100000\n'); put('cgroup/shard/driver/cpu.stat', stat(2_000))
    writeFileSync(join(root, 'split'), '/shard/driver\n/shard/driver\n')
    const split = cli('driver-cpu', ['102', join(root, 'split')])
    expect({ status: split.status, stdout: split.stdout }).toEqual({ status: 0, stdout: 'recorded: sr8 driver-cpu scenario=test-fault mode=strict population=0 recipients=2 samples=2 '
      + 'server_cgroup=/shard/server server_cpu_max=200000/100000 server_cpus=2 server_usage_ms=5 driver_cgroup=/shard/driver driver_cpu_max=90000/100000 driver_cpus=0.9 driver_usage_ms=2 shared_cpus=5 '
      + 'guarded_files=8 writable_files=0 unprobed_files=0 limit=2 verdict=pass\n'
      + 'recorded: sr8 summary scenario=test-fault measures=1 pass=1 fail=0 missing=0\n' })
    // R1's escape: the server's UID able to write the parent's cgroup.procs, so it could leave its group,
    // whether the file is also readable (0644) or write-only (0200), which a read-write probe would miss.
    for (const mode of [0o644, 0o200]) {
      put('cgroup/shard/cgroup.procs', '', mode)
      expect(cli('driver-cpu', ['102', join(root, 'split')]).stdout).toContain(' guarded_files=8 writable_files=1 unprobed_files=0 limit=2 verdict=missing\n')
    }
    put('cgroup/shard/cgroup.procs', '')
    // A guarded file the probe cannot open for an unexpected reason (EISDIR here) is no evidence, so missing.
    rmSync(join(host, 'cgroup/shard/driver/cgroup.procs')); mkdirSync(join(host, 'cgroup/shard/driver/cgroup.procs'))
    expect(cli('driver-cpu', ['102', join(root, 'split')]).stdout).toContain(' guarded_files=8 writable_files=0 unprobed_files=1 limit=2 verdict=missing\n')
    rmSync(join(host, 'cgroup/shard/driver/cgroup.procs'), { recursive: true }); put('cgroup/shard/driver/cgroup.procs', '')
    expect(cli('driver-cpu', ['102', join(root, 'split')]).status).toBe(0)
    // A record cut mid-line, an absent one or a gone server is missing; a bad PID is a usage error.
    writeFileSync(join(root, 'cut'), '/shard/driver')
    for (const args of [['102', join(root, 'cut')], ['102', join(root, 'absent')], ['103', join(root, 'split')]]) expect(cli('driver-cpu', args).status).toBe(1)
    expect(cli('driver-cpu', ['x', join(root, 'split')]).status).toBe(64)
  }))
  test('burst writes wave-boundary CPU readings only when SR8_PHASE_CPU_FILE opts in, and observe reads them with the server rows', () => withCLI((root, cli) => {
    const batch = join(root, 'batches'), keys = sr8Personas(2), phases = ['roots', 'replies', 'dropped'] as const
    mkdirSync(batch); writeFileSync(join(root, 'stub'), '')
    const ts = (phase: string, n: number) => `${1700000000 + n}.00000${phases.indexOf(phase as typeof phases[number]) + 1}`
    const body = (label: string, phase: string, n: number) => ({ label, event: { channel: 'C0BURST', ts: ts(phase, n), user: 'UHUMAN',
      ...(phase === 'replies' ? { thread_ts: ts('roots', n) } : {}) } })
    for (const [phase, count] of [['roots', SR8_BURST_JOINS], ['replies', SR8_BURST_REPLIES], ['dropped', SR8_BURST_DROPPED]] as const)
      writeFileSync(join(batch, `${phase}.batch.jsonl`), lines(keys.flatMap(k => Array.from({ length: count }, (_, n) => body(k, phase, n)))))
    // The copied CLI reads cgroups and each process's stat from controlled files
    // under its root, never the host's: server readable, stub absent, observer malformed.
    // The cgroup read is the server's own, not the namespace root the driver shares.
    const copy = join(root, 'tests/integration/fixtures/sr8-evidence.ts'), host = join(root, 'host')
    const reads: Array<[string, string]> = [
      ["const CGROUP_ROOT = '/sys/fs/cgroup'", `const CGROUP_ROOT = ${JSON.stringify(join(host, 'cgroup'))}`],
      ['textFile(`/proc/${pid}/cgroup`)', `textFile(join(${JSON.stringify(join(host, 'proc'))}, String(pid), 'cgroup'))`],
      ['textFile(`/proc/${pid}/stat`)', `textFile(join(${JSON.stringify(join(host, 'proc'))}, name === 'observer' ? name : String(pid), 'stat'))`],
    ]
    let text = readFileSync(copy, 'utf8')
    for (const [from, to] of reads) { expect(text.split(from)).toHaveLength(2); text = text.replace(from, to) }
    writeFileSync(copy, text)
    mkdirSync(join(host, 'proc/101'), { recursive: true }); mkdirSync(join(host, 'proc/observer')); mkdirSync(join(host, 'cgroup/shard/server'), { recursive: true })
    writeFileSync(join(host, 'proc/101/cgroup'), '0::/shard/server\n')
    writeFileSync(join(host, 'cgroup/cpu.stat'), 'usage_usec 9\nuser_usec 9\nsystem_usec 9\nnr_periods 9\nnr_throttled 9\nthrottled_usec 9\n')
    writeFileSync(join(host, 'cgroup/shard/server/cpu.stat'), 'usage_usec 5000\nuser_usec 3000\nsystem_usec 2000\nnr_periods 10\nnr_throttled 2\nthrottled_usec 300\n')
    writeFileSync(join(host, 'proc/101/stat'), '101 (bun (x) y) S 1 101 101 0 -1 4194304 10 0 0 0 250 75 0 0 20 0 9 0 100 0 0\n')
    writeFileSync(join(host, 'proc/observer/stat'), 'garbage\n')
    const burst = (out: string) => cli('burst', [batch, 'http://127.0.0.1:1', join(root, 'stub'), join(root, 'state'), out, '1000'])
    expect(burst(join(root, 'plain')).status).toBe(0)
    expect(existsSync(join(root, 'phase-cpu.jsonl'))).toBe(false)
    expect(readdirSync(join(root, 'profile'))).toEqual([])
    writeFileSync(join(root, 'cpu-on'), 'server=101,stub=202\n')
    const out = join(root, 'e')
    expect(burst(out).status).toBe(0)
    const cpu: PhaseCpuSample[] = readFileSync(join(root, 'phase-cpu.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(cpu.map(s => s.phase)).toEqual(['roots', 'replies-drops', 'end'])
    // The CPU profile's wave marks come at the same points, only under SR8_PROFILE_DIR.
    expect(readFileSync(join(root, 'profile/waves'), 'utf8')).toBe('roots\nreplies-drops\nend\n')
    expect(cpu.every((s, i) => i === 0 || s.mono_ms >= cpu[i - 1]!.mono_ms)).toBe(true)
    for (const s of cpu) expect({ cgroup: s.cgroup, procs: s.procs }).toEqual({
      cgroup: { usage_usec: 5000, user_usec: 3000, system_usec: 2000, nr_periods: 10, nr_throttled: 2, throttled_usec: 300 },
      procs: { server: { utime: 250, stime: 75 }, stub: null, observer: null } })
    const ledger: BurstItem[] = readFileSync(join(out, 'burst.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    writeFileSync(join(out, 'times.jsonl'), lines(ledger.map((i, n) => ({ envelope_id: i.envelope_id, push: { sent_mono_ms: n, connection_id: 'c' },
      acks: [{ ack_mono_ms: n + 5, connection_id: 'c' }] }))))
    // The server answers only alpha's events here, each in 3 ms of a 1 ms ack call.
    writeFileSync(join(root, 'measurements'), ledger.filter(i => i.key === keys[0]).map((i, n) => serverLine(ackTimingMeasurement({ keys: [i.key], ts: i.ts,
      targets: [], outcome: 'acked', receiveToAckMs: 3, ackCallMs: 1, atMonoMs: 1000 + n * 10 + 4 }), 1000 + n * 10 + 4) + '\n').join(''))
    const observed = cli('observe', [out, join(root, 'measurements'), '0', join(root, 'phase-cpu.jsonl')])
    expect(observed.status).toBe(0); expect(observed.stderr).toBe('')
    const printed = String(observed.stdout).trim().split('\n')
    expect(printed[0]).toBe(`recorded: sr8 observe-inputs scenario=test-fault mode=strict population=0 recipients=2 samples=${SR8_BURST_JOINS + SR8_BURST_REPLIES + SR8_BURST_DROPPED} measurements=read burst=read times=read cpu=read limit=none verdict=recorded`)
    expect(printed.filter(l => l.includes(' observe-cpu ')).map(l => l.replace(/ elapsed_ms=[\d.]+ /, ' elapsed_ms=E ')
      .replace(/ cpus_busy=(0|unknown) /, ' cpus_busy=B '))).toEqual(['roots', 'replies-drops'].map(phase =>
      `recorded: sr8 observe-cpu scenario=test-fault mode=strict population=0 recipients=2 samples=2 phase=${phase} elapsed_ms=E cpu_usage_ms=0 cpu_user_ms=0 cpu_system_ms=0 cpus_busy=B nr_periods=0 nr_throttled=0 throttled_ms=0 server_user_ms=0 server_system_ms=0 stub_user_ms=unknown stub_system_ms=unknown observer_user_ms=unknown observer_system_ms=unknown limit=none verdict=recorded`))
    // One line per ledger event, ordinals 1..n per persona and phase; beta's events have no server row.
    const events = printed.filter(l => l.includes(' observe-ack-event '))
    expect(events).toHaveLength(ledger.length)
    for (const key of keys) for (const phase of phases) {
      const own = events.filter(l => l.includes(` phase=${phase} persona=${key} `)), count = ledger.filter(i => i.key === key && i.phase === phase).length
      expect(own.map(l => Number(l.match(/ ordinal=(\d+) /)![1]))).toEqual(Array.from({ length: count }, (_, n) => n + 1))
      expect(own.every(l => l.includes(key === keys[0] ? ' stub=acked stub_ms=5 server=acked server_ms=3 gap_ms=2 ' : ' stub=acked stub_ms=5 server=missing server_ms=none gap_ms=none '))).toBe(true)
    }
    expect(printed.find(l => l.includes(' observe-ack ') && l.includes(' phase=roots '))).toContain(
      `samples=${2 * SR8_BURST_JOINS} phase=roots stub_events=${2 * SR8_BURST_JOINS} server_events=${SR8_BURST_JOINS} matched=${SR8_BURST_JOINS} stub_unacked=0 stub_ambiguous=0 server_ambiguous=0 suppressed=0 ack_failed=0 stub_p50_ms=5 stub_p99_ms=5 stub_max_ms=5 server_p50_ms=3 server_p99_ms=3 server_max_ms=3 gap_p50_ms=2 gap_p99_ms=2 gap_max_ms=2`)
    expect(printed.filter(l => l.includes(' observe-ack-bin ') && l.includes(' phase=dropped '))).toHaveLength(10)
    expect(printed.every(l => l.endsWith('limit=none verdict=recorded'))).toBe(true)
    const absent = cli('observe', [join(root, 'absent'), join(root, 'absent'), '0', join(root, 'absent')])
    expect(absent.status).toBe(0)
    expect(String(absent.stdout)).toBe('recorded: sr8 observe-inputs scenario=test-fault mode=strict population=0 recipients=2 samples=0 measurements=missing burst=missing times=missing cpu=missing limit=none verdict=recorded\n')
    expect(cli('observe', [out, join(root, 'measurements'), '0']).status).toBe(64)
  }, `
// Synthetic transport only in this copied CLI; the opt-in is set only when the test asks.
{ const base = resolve(import.meta.dir, '../../..');
  mkdirSync(join(base, 'profile'), { recursive: true });
  if (existsSync(join(base, 'cpu-on'))) { process.env.SR8_PHASE_CPU_FILE = join(base, 'phase-cpu.jsonl'); process.env.SR8_PHASE_CPU_PIDS = readFileSync(join(base, 'cpu-on'), 'utf8').trim(); process.env.SR8_PROFILE_DIR = join(base, 'profile') } }
let seq = 0;
globalThis.fetch = async (_url, init) => {
  const base = resolve(import.meta.dir, '../../..'), b = JSON.parse(init.body), id = b.label + '-' + b.event.ts;
  appendFileSync(join(base,'stub'), JSON.stringify({seq:++seq,event:'push',label:b.label,channel:b.event.channel,event_ts:b.event.ts,envelope_id:id})+'\\n');
  appendFileSync(join(base,'stub'), JSON.stringify({seq:++seq,event:'ws-message',envelope_id:id})+'\\n');
  return Response.json({ok:true,envelope_id:id});
};
`))
  test('membership diagnostics CLI reads original fault identities or undurable burst identities, after the measurement mark', () => withCLI((root, cli) => {
    const keys = sr8Personas(2), dir = join(root, 'observations'), file = join(root, 'measurements')
    mkdirSync(dir)
    const item = { key: keys[1], phase: 'roots', channel: 'CONE', ts: '1700000000.000001', sender: 'UHUMAN', ordinal: 0, dependent: false, root: '-' }
    const timed = { envelope_id: 'original', push: { sent_mono_ms: 10, connection_id: 'c' }, acks: [{ ack_mono_ms: 3011, connection_id: 'c' }] }
    writeFileSync(join(dir, 'times.jsonl'), JSON.stringify(timed) + '\n')
    const ack = JSON.stringify({ kind: 'ack', keys: [keys[1]], ts: item.ts, targets: [], outcome: 'acked', receive_to_ack_ms: 5, ack_call_ms: 1, at_mono_ms: 10006 }) + '\n'
    writeFileSync(file, ack + ack)
    const plan = join(dir, 'fault-plan.json')
    writeFileSync(plan, JSON.stringify({ context: { scenario: 'test-fault', mode: 'strict', population: 0, recipients: 2 },
      plan: { kind: 'lookup', key: keys[0], keys, all: false, channels: [], items: [item] } }))
    writeFileSync(join(dir, 'fault-ledger.jsonl'), [
      { ordinal: 0, stage: 'original', envelope_id: 'original' }, { ordinal: 0, stage: 'replay', envelope_id: 'replay' },
    ].map(r => JSON.stringify(r) + '\n').join(''))
    const fault = cli('diag-ack', [dir, file, String(Buffer.byteLength(ack))])
    expect(fault.status).toBe(0); expect(fault.stderr).toBe('')
    expect(String(fault.stdout)).toContain('envelope=original phase=roots stub=acked stub_ms=3001 server=acked server_ms=5 gap_ms=2996')
    expect(String(fault.stdout)).not.toContain('envelope=replay')
    // Same diagnostic command serves the undurable case's ordinary burst ledger.
    rmSync(plan)
    writeFileSync(join(dir, 'burst.jsonl'), JSON.stringify({ ...item, envelope_id: 'original' }) + '\n')
    const ordinary = cli('diag-ack', [dir, file, String(Buffer.byteLength(ack))])
    expect(ordinary.status).toBe(0); expect(ordinary.stdout).toBe(fault.stdout)
    expect(String(ordinary.stdout).trim().split('\n').every(l => l.startsWith('recorded: sr8 diag ') && l.endsWith('limit=none verdict=recorded'))).toBe(true)
    const costs = String(ordinary.stdout).trim().split('\n').filter(l => l.includes('diagnostic=append-cost'))
    expect(costs).toHaveLength(6)
    expect(costs.find(l => l.includes('window=roots journal=queue-acceptance'))).toContain('wall_ms=6 appends=0')
    writeFileSync(file, ack + ack + JSON.stringify({ kind: 'append', key: keys[1], journal: 'queue', records: 1,
      append_ms: 1, file_fsync_ms: 2, dir_fsync_ms: 0, fsyncs: 1, at_mono_ms: 10004 }) + '\n')
    const invalid = cli('diag-ack', [dir, file, String(Buffer.byteLength(ack))])
    expect(invalid.status).toBe(0); expect(invalid.stderr).toBe('')
    expect(String(invalid.stdout)).toContain('diagnostic=ack-summary')
    expect(String(invalid.stdout)).toContain('diagnostic=append-unavailable limit=none verdict=recorded')
    const absent = cli('diag-ack', [join(root, 'absent'), file, '0'])
    expect(absent.status).toBe(0); expect(absent.stderr).toBe('')
    expect(String(absent.stdout)).toContain('diagnostic=ack-unavailable limit=none verdict=recorded')
  }))
  test('config adds the diagnostic timing switch only for its timings opt-in, used by test-44 diagnostics and membership-load', () => withCLI(root => {
    const dir = join(root, 'tests/integration/fixtures')
    writeFileSync(join(dir, 'fmk-texts.ts'), `console.log(${JSON.stringify({ TEST_MEASUREMENTS_KEY, TEST_MEASUREMENT_TIMINGS_KEY,
      testTimerOverridesBlock: '{"queue_compact_interval_ms":250}' })}[process.argv[2]]);`)
    const config = (...extra: string[]) => spawnSync(process.execPath, [join(dir, 'sr8-evidence.ts'), 'config', 'strict', '0', '2', join(root, 'people'), '4100', '250', ...extra],
      { env: hostSafeChildEnv(root, { extras: { SCENARIO_ROOT: root } }), encoding: 'utf8', timeout: 3000 })
    const plain = config(), timed = config('timings')
    expect([plain.status, timed.status]).toEqual([0, 0])
    const off = JSON.parse(plain.stdout), on = JSON.parse(timed.stdout)
    expect(off[TEST_MEASUREMENTS_KEY]).toBe(true); expect(Object.hasOwn(off, TEST_MEASUREMENT_TIMINGS_KEY)).toBe(false)
    expect(on).toEqual({ ...off, [TEST_MEASUREMENT_TIMINGS_KEY]: true })
    // Every population/mode/recipient combination used by test-44 has base
    // attribution without enabling the extra per-event observers. Membership
    // cases use this same generator at population 100000 / two recipients.
    for (const c of sr8Combinations()) {
      const child = spawnSync(process.execPath, [join(dir, 'sr8-evidence.ts'), 'config', c.mode, String(c.population), String(c.recipients), join(root, 'people'), '4100', '250'],
        { env: hostSafeChildEnv(root, { extras: { SCENARIO_ROOT: root } }), encoding: 'utf8', timeout: 3000 })
      expect(child.status).toBe(0)
      const config = JSON.parse(child.stdout)
      expect(config[TEST_MEASUREMENTS_KEY]).toBe(true)
      expect(Object.hasOwn(config, TEST_MEASUREMENT_TIMINGS_KEY)).toBe(false)
    }
    expect(config('other').status).not.toBe(0); expect(config('timings', 'timings').status).not.toBe(0)
    // Membership-load enables per-event timings; test-44 enables them only for diagnostics. Executable switch
    // controls live with the profile lifecycle controls in cpu-profile.test.ts.
    const shells = (readdirSync(integration, { recursive: true }) as string[]).filter(f => f.endsWith('.sh'))
    expect(shells.filter(f => /\(timings\)|\bconfig\b.*\btimings\b/.test(source(f))).sort()).toEqual(['lib/membership-load.sh', 'test-44-fmk-thread-burst.sh'])
    const test44 = source('test-44-fmk-thread-burst.sh')
    expect(test44).toContain('if [[ "${CSCB_TEST_DIAGNOSTICS:-}" == 1 && "${CASE}" == burst ]]; then\n    # The server\'s diagnostic ack/append/save rows, read only by observe below.\n    config_args+=(timings)\nfi\nbun "${SR8}" config "${config_args[@]}" | write_config\n')
  }))
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
        writeFileSync(join(root, 'sr8-attribution.ts'), source('fixtures/sr8-attribution.ts'))
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
  describe('compaction: the queue by file identity, Thread Memory by its entries wholly inside the burst\'s server-clock store span', () => {
    // The burst's own acceptance stores: alpha's starts the span at 1000 (at_mono_ms - store_ms), beta's ends it at 2000.
    const stores = [store(1, 5, 'accepted', 1005), { ...store(1, 10, 'post-hold', 2000), key: other }]
    const burst = [item(), { key: other, seq: 1 }], keys = [key, other]
    const queue = (k: string) => ({ key: k, kind: 'queue', before: '1:1', after: '1:2', inside: true })
    // alpha rewrote inside the span; each case gives beta's entries.
    const run = (entries: Measurement[], q = keys.map(queue)) => {
      const rows = [...stores, compactionRow(key, 1100, 1200, 'rewritten'), ...entries]
      return compactionVerdict(q, rows, storeWindow(rows, burst), keys, true)
    }
    test('a skipped compaction inside the span counts as complete beside a rewrite, at both inclusive edges', () => {
      expect(storeWindow(stores, burst)).toEqual({ start: 1000, end: 2000 })
      const r = run([compactionRow(other, 1000, 1050, 'skipped'), compactionRow(other, 1300, 1400, 'rewritten'), compactionRow(other, 1900, 2000, 'skipped')])
      expect(resultLine(context, r)).toContain(' samples=4 required=4 queue=2 threads=2 rewritten=2 skipped=2 outside=0 window_ms=1000 limit=inside-burst verdict=pass')
    })
    test('a persona whose in-burst compactions all skipped fails, though the other rewrote', () => {
      const r = run([compactionRow(other, 1100, 1200, 'skipped'), compactionRow(other, 1500, 1600, 'skipped')])
      expect(r.verdict).toBe('fail'); expect(r.stats).toMatchObject({ threads: 1, rewritten: 1, skipped: 2 })
    })
    test.each([['at startup, before the first store', 10, 500], ['across the first store\'s start', 990, 1010],
      ['across the last store', 1990, 2010], ['after the last store', 2001, 2100]] as const)
    ('beta\'s rewrite %s never counts', (_name, start, end) => {
      const outside = compactionRow(other, start, end, 'rewritten')
      missing(run([outside]))
      const r = run([outside, compactionRow(other, 1500, 1600, 'skipped')])
      expect(r.verdict).toBe('fail'); expect(r.stats).toMatchObject({ threads: 1, skipped: 1, outside: 1 })
    })
    test('no entries, none for one persona, or an unreadable measurement file is missing', () => {
      missing(compactionVerdict(keys.map(queue), stores, storeWindow(stores, burst), keys, true))
      missing(run([]))
      missing(compactionVerdict(keys.map(queue), undefined, storeWindow(stores, burst), keys, true))
    })
    test.each<[string, (rows: Measurement[]) => Measurement[]]>([
      ['no store rows', rows => rows.filter(r => r.kind !== 'store')],
      ['a burst item\'s store absent', rows => rows.filter(r => !(r.kind === 'store' && r.key === other))],
      ['an item stored twice', rows => [...rows, { ...stores[1]! }]],
      ['only a later fixed append for an item', rows => rows.map(r => r.kind === 'store' && r.key === other ? { ...r, store: 'fixed' } : r)],
      ['a store taking longer than its own time', rows => rows.map(r => r.kind === 'store' && r.key === key ? { ...r, store_ms: 1006 } : r)],
    ])('no window (%s) is missing, even with every entry inside', (_name, change) => {
      const rows = change([...stores, compactionRow(key, 1100, 1200, 'rewritten'), compactionRow(other, 1300, 1400, 'rewritten')])
      expect(storeWindow(rows, burst)).toBeUndefined()
      missing(compactionVerdict(keys.map(queue), rows, storeWindow(rows, burst), keys, true))
    })
    test.each<[string, Partial<Measurement>]>([
      ['a negative start', { start_mono_ms: -1 }], ['no end', { end_mono_ms: undefined }], ['an end before its start', { start_mono_ms: 1450 }],
      ['an unknown outcome', { outcome: 'partial' }], ['an unknown persona key', { key: 'gamma' }], ['at_mono_ms other than its end', { at_mono_ms: 1350 }],
    ])('beta\'s malformed rewrite (%s) never counts and cannot make the proof pass', (_name, change) => {
      const bad = { ...compactionRow(other, 1300, 1400, 'rewritten'), ...change }
      missing(run([bad]))
      expect(run([bad, compactionRow(other, 1500, 1600, 'skipped')]).verdict).toBe('fail')
    })
    test.each([['absent', undefined], ['outside the burst', { inside: false }], ['one identity', { after: '1:1' }], ['no identity before', { before: '' }]] as const)
    ('beta\'s queue proof %s stays missing whatever the entries show', (_name, change) => {
      const r = run([compactionRow(other, 1300, 1400, 'rewritten')], [queue(key), ...(change ? [{ ...queue(other), ...change }] : [])])
      missing(r); expect(r.stats).toMatchObject({ queue: 1, threads: 2 })
    })
    test('Thread Memory file identity rows no longer count, and below 100,000 nothing is required', () => {
      const r = compactionVerdict(keys.flatMap(k => [queue(k), { ...queue(k), kind: 'threads' }]), stores, storeWindow(stores, burst), keys, true)
      missing(r); expect(r.samples).toBe(2)
      expect(compactionVerdict(undefined, undefined, undefined, keys, false)).toMatchObject({ verdict: 'pass', stats: { required: 0 } })
    })
  })
  describe('joins: every seed before the burst, every pre-burst join and burst root after it', () => {
    // S seeds, N burst roots, and the first start's seal-report notice's own-post join.
    const joined = (channel: string, root: string, source = 'mention') => ({ channel, root, source })
    const S = [joined('C1', '1'), joined('C1', '2')], N = [joined('C1', '9')], notice = joined('C0LARGE00003', '5', 'own-post')
    const other = joined('C1', '7')
    test.each([
      ['the seal notice\'s extra pre-burst join, kept', [...S, notice], [...S, notice, ...N], 'pass', [1, 'own-post:1', 'C0LARGE00003:1', 0, 0]],
      ['no extra join', S, [...S, ...N], 'pass', [0, 'none', 'none', 0, 0]],
      ['a seed lost before the burst while the extra keeps the count', [S[0]!, notice], [...S, notice, ...N], 'fail', [1, 'own-post:1', 'C0LARGE00003:1', 0, 0]],
      ['the extra pre-burst join lost through the burst and restart', [...S, notice], [...S, ...N, other], 'fail', [1, 'own-post:1', 'C0LARGE00003:1', 1, 0]],
      ['a burst root missing while another join keeps the count', [...S, notice], [...S, notice, other], 'fail', [1, 'own-post:1', 'C0LARGE00003:1', 0, 1]],
    ] as const)('%s', (_name, before, after, verdict, [excess, sources, channels, lost, burstMissing]) => {
      const r = joinsVerdict([...before], [...after], S, N, 1)
      expect(r.verdict).toBe(verdict)
      expect(r.stats).toMatchObject({ baseline_excess: excess, excess_sources: sources, excess_channels: channels, baseline_lost: lost, burst_missing: burstMissing })
    })
    test('missing snapshots stay missing', () => {
      missing(joinsVerdict(undefined, [...S, ...N], S, N, 1))
      missing(joinsVerdict([...S, notice], undefined, S, N, 1))
    })
    test('the baseline excess prints content-free: counts per source and channel word, never other text', () => {
      const odd = [joined('C2', '6', 'own post <text>'), joined('C2', '8', 'own-post'), { channel: 'C3 x', root: '4' }]
      const output: string[] = []
      printResults(context, [joinsVerdict([...S, ...odd], [...S, ...odd, ...N], S, N, 1)], line => output.push(line))
      expect(output[0]).toBe('recorded: sr8 joins scenario=test-control mode=strict population=100000 recipients=1 samples=6 before=5 after=6'
        + ' oldest_retained=2 forgotten=0 baseline_excess=3 excess_sources=other:2,own-post:1 excess_channels=C2:2,other:1 baseline_lost=0 burst_missing=0 limit=>=3 verdict=pass')
    })
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
  test('N3 turn-end half-open boundary counts only gets and enforces each persona separately', () => {
    const active = [key, other].map(instance => ({ instance, start: 1000, end: 3000 }))
    const empty = active.map(w => ({ ...w, start: 3000, end: 13000 }))
    const reaction = active.map(w => ({ ...w, start: 2000 }))
    const calls = [key, other].map(instance => ({ instance, ms: 2000, verb: 'get' }))
    calls.push({ instance: key, ms: 2500, verb: 'send-keys' }, { instance: key, ms: 3000, verb: 'get' })
    const got = turnEndVerdict(calls, reaction, empty, active)
    expect(got.verdict).toBe('pass')
    expect(got.stats.max_gets_per_persona).toBe(1)
    expect(windowsVerdict(calls, empty, DELIVERY_MAX_AD_CALLS_PER_S, active).verdict).toBe('fail')
    expect(turnEndVerdict([...calls, { instance: other, ms: 2999, verb: 'get' }], reaction, empty, active).verdict).toBe('fail')
    missing(turnEndVerdict(undefined, reaction, empty, active))
    missing(turnEndVerdict([{ instance: key, ms: 2500 }], reaction, empty, active))
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
