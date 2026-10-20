/** D1 refusal and evidence controls only. Every rollout below is synthetic;
 * these controls perform no login access, model call or native launch. */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, readFileSync, writeFileSync, lstatSync, linkSync, chmodSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { codexContainment, codexArguments, configureScratchCodex, createScratchCodexLifecycle, scratchCodexContract, codexRetirementCheckpoint, CODEX_NATIVE, CODEX_AUTH_MOUNT, CODEX_NO_REPLY } from './real-agent/codex-guards.ts'
import { checkCodexScratchConfigKeys, encodeCodexHostConfigKeys } from '../src/codex-config-keys.ts'
import { completedCodexTurn, projectCodexRollout, safeCodexEvents } from './real-agent/codex-evidence.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX } from './test-helpers/credentials.ts'
import { projectCrashProgress, publishCrashProgress, readCrashProgress, waitForCrashBoundary, type CrashProgress } from './real-agent/codex-crash-barrier.ts'

const session = 'synthetic-session', model = 'synthetic/model', text = 'synthetic exact input', sentAt = 1000
const hostProjection = encodeCodexHostConfigKeys([['model']])
const nativeConfig = '[tui]\nscreen_reader_detection_done = true\n'

describe('D1 crash-worker checkpoints and durable-pair boundary (synthetic; no native process)', () => {
  const progress = (patch: Partial<CrashProgress> = {}): CrashProgress => ({ version: 1, pid: 321, instance: 'cscb_codex_gate',
    stage: 'startup', firstSeq: null, successorSeq: null, prepared: false, clientReady: false, queueReady: false,
    textStarted: false, textReturned: false, failed: false, errors: 0, error: 'none', ...patch })
  function fixture() {
    const root = mkdtempSync('/tmp/codex-crash-control-'), checkpoint = join(root, 'progress.json'), marker = join(root, 'marker.json')
    let at = 0
    const child = { pid: 321, exitCode: null as number | null, signalCode: null as string | null }
    const diagnostics: any[] = [], order: string[] = []
    const records = [{ kind: 'accepted', seq: 13 }]
    const f = {
      root, checkpoint, marker, child, diagnostics, order, records, at: () => at,
      advance: (_at: number) => {},
      sleep: async (ms: number) => { at += ms; f.advance(at) },
      checkpointAt: (patch: Partial<CrashProgress> = {}) => publishCrashProgress(checkpoint, progress(patch)),
      boundary: () => {
        const p = progress({ stage: 'barrier-published', firstSeq: 14, textStarted: true, textReturned: true })
        publishCrashProgress(marker, p); publishCrashProgress(checkpoint, p)
        records.push({ kind: 'accepted', seq: 14 })
      },
      successor: () => {
        const p = readCrashProgress(checkpoint, child.pid, 'cscb_codex_gate').value!
        publishCrashProgress(checkpoint, { ...p, successorSeq: 15 }); records.push({ kind: 'accepted', seq: 15 })
      },
      run: async () => {
        try {
          return await waitForCrashBoundary({ child, checkpoint, marker, instance: 'cscb_codex_gate', journal: () => records,
            counts: () => ({ queue: records.length, text: 1, enter: 0 }),
            diagnostic: value => { assertNoLeak(value); diagnostics.push(value); order.push('diagnostic') },
            bound: () => order.push('bound'), now: () => at, sleep: ms => f.sleep(ms),
          })
        } finally { order.push('cleanup'); rmSync(root, { recursive: true, force: true }) }
      },
    }
    return f
  }
  test('delayed child startup, successful text return and delayed successor retain both exact durable IDs', async () => {
    const f = fixture()
    f.advance = at => {
      if (at === 250) f.checkpointAt({ stage: 'client-ready' })
      if (at === 500) {
        f.boundary()
        // Old penultimate acceptance chooses unrelated work before successor acceptance.
        expect(f.records.filter(r => r.kind === 'accepted').at(-2)?.seq).toBe(13)
      }
      if (at === 1000) f.successor()
    }
    expect(await f.run()).toEqual({ firstSeq: 14, successorSeq: 15 })
    expect(f.at()).toBe(1000)
    expect(f.diagnostics).toEqual([{ checkpointStatus: 'valid', markerStatus: 'valid',
      progress: progress({ stage: 'barrier-published', firstSeq: 14, successorSeq: 15, textStarted: true, textReturned: true }),
      exit: null, signal: null, counts: { queue: 3, text: 1, enter: 0 } }])
    expect(f.order).toEqual(['diagnostic', 'cleanup']); expect(existsSync(f.root)).toBe(false)
  })
  test('publication between protocol reads never pairs a stale checkpoint with a new marker', () => {
    const f = fixture(); f.checkpointAt()
    try {
      // Intercept only this child's filesystem read: publish after its old
      // checkpoint bytes have been captured, before the helper's next read.
      const script = `
        import { mock } from 'bun:test';
        import * as fs from 'node:fs';
        const actualRead = fs.readSync;
        let protocol, published = false, at = 0;
        const complete = ${JSON.stringify(progress({ stage: 'barrier-published', firstSeq: 14, successorSeq: 15, textStarted: true, textReturned: true }))};
        mock.module('node:fs', () => ({ ...fs, readSync(fd, bytes, ...args) {
          const n = actualRead(fd, bytes, ...args);
          if (!published && bytes.subarray(0, n).toString().includes('"stage":"startup"')) {
            published = true;
            protocol.publishCrashProgress(${JSON.stringify(f.checkpoint)}, complete);
            protocol.publishCrashProgress(${JSON.stringify(f.marker)}, complete);
          }
          return n;
        } }));
        protocol = await import(${JSON.stringify(join(import.meta.dir, 'real-agent/codex-crash-barrier.ts'))});
        const diagnostics = [];
        const result = await protocol.waitForCrashBoundary({
          child: ${JSON.stringify(f.child)}, checkpoint: ${JSON.stringify(f.checkpoint)}, marker: ${JSON.stringify(f.marker)},
          instance: 'cscb_codex_gate', journal: () => [{ kind: 'accepted', seq: 14 }, { kind: 'accepted', seq: 15 }],
          counts: () => ({ queue: 2, text: 1, enter: 0 }),
          diagnostic: value => diagnostics.push(value), bound: () => { throw new Error('unexpected deadline'); },
          now: () => at, sleep: async ms => { at += ms; },
        });
        console.log(JSON.stringify({ result, published, at, diagnostics }));
      `
      const child = spawnSync(process.execPath, ['--eval', script], {
        env: hostSafeChildEnv(f.root, { tools: [] }), encoding: 'utf8', timeout: 5000,
      })
      assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.stderr).toBe(''); expect(child.status).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({ result: { firstSeq: 14, successorSeq: 15 }, published: true, at: 250,
        diagnostics: [{ checkpointStatus: 'valid', markerStatus: 'valid',
          progress: progress({ stage: 'barrier-published', firstSeq: 14, successorSeq: 15, textStarted: true, textReturned: true }),
          exit: null, signal: null, counts: { queue: 2, text: 1, enter: 0 } }] })
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  test.each([
    ['ordinary exit', 7, null], ['signal exit', null, 'SIGTERM'], ['unrecognized signal', null, 'foreign-signal'],
  ] as const)('%s preserves only projected status before cleanup', async (_name, exit, signal) => {
    const f = fixture(); f.checkpointAt({ stage: 'client-ready' })
    f.child.exitCode = exit; f.child.signalCode = signal
    await expect(f.run()).rejects.toThrow('exited before text boundary')
    expect(f.diagnostics[0]).toMatchObject({ progress: { stage: 'client-ready' }, exit, signal: signal === 'foreign-signal' ? 'other' : signal })
    expect(f.order).toEqual(['diagnostic', 'cleanup'])
  })
  test.each(['live startup stall', 'transport rejection', 'missing marker', 'missing successor', 'late successor'])(
    '%s keeps the original 180-second failure and diagnostic-before-cleanup order', async kind => {
      const f = fixture(); f.checkpointAt({ stage: 'queue-ready' })
      if (kind === 'transport rejection') f.checkpointAt({ stage: 'text-call-start', firstSeq: 14, textStarted: true, errors: 4, error: 'ErrRelayFallenBack' })
      if (['missing marker', 'missing successor', 'late successor'].includes(kind)) f.boundary()
      if (kind === 'missing marker') unlinkSync(f.marker)
      if (kind === 'late successor') f.advance = at => { if (at >= 180000) f.successor() }
      await expect(f.run()).rejects.toThrow('observation incomplete within bound')
      expect(f.at()).toBe(180000); expect(f.order).toEqual(['bound', 'diagnostic', 'cleanup'])
      expect(f.diagnostics).toHaveLength(1)
      if (kind === 'transport rejection') expect(f.diagnostics[0].progress).toMatchObject({ stage: 'text-call-start', errors: 4, error: 'ErrRelayFallenBack', textReturned: false })
      if (kind === 'missing marker') expect(f.diagnostics[0].markerStatus).toBe('missing')
    })
  test.each(['foreign PID', 'foreign instance', 'foreign sequence', 'malformed', 'unknown field', 'unreturned text', 'oversize', 'symlink'])(
    '%s cannot satisfy a boundary or leak malformed protocol contents', async kind => {
      const f = fixture(); f.boundary(); f.successor()
      const token = fakeToken(BOT_TOKEN_PREFIX)
      if (kind === 'foreign PID') publishCrashProgress(f.marker, progress({ pid: 999 }))
      if (kind === 'foreign instance') writeFileSync(f.marker, JSON.stringify({ ...progress(), instance: token }))
      if (kind === 'foreign sequence') publishCrashProgress(f.marker, progress({ firstSeq: 12, textStarted: true, textReturned: true }))
      if (kind === 'malformed') writeFileSync(f.marker, '{' + token)
      if (kind === 'unknown field') writeFileSync(f.marker, JSON.stringify({ ...progress(), secret: token }))
      if (kind === 'unreturned text') publishCrashProgress(f.marker, progress())
      if (kind === 'oversize') writeFileSync(f.marker, token.repeat(1000))
      if (kind === 'symlink') { unlinkSync(f.marker); symlinkSync(f.checkpoint, f.marker) }
      await expect(f.run()).rejects.toThrow(/invalid crash protocol|does not match successful text boundary/)
      expect(f.order).toEqual(['diagnostic', 'cleanup']); assertNoLeak(f.diagnostics)
    })
  test('checkpoint publication leaves the target absent or complete during a partial temporary write', () => {
    const root = mkdtempSync('/tmp/codex-atomic-control-'), file = join(root, 'marker.json')
    try {
      const source = readFileSync(join(import.meta.dir, 'real-agent/codex-crash-barrier.ts'), 'utf8')
      const declaration = source.match(/^export function publishCrashProgress[\s\S]*?^\}/m)![0].replace('export ', '')
      const observations: string[] = []
      const publish = new Function('projectCrashProgress', 'writeFileSync', 'renameSync', 'unlinkSync',
        new Bun.Transpiler({ loader: 'ts' }).transformSync(declaration + '\nreturn publishCrashProgress'))(
        projectCrashProgress, (temporary: string, body: string, options: any) => {
          writeFileSync(temporary, body.slice(0, 10), options)
          observations.push(existsSync(file) ? readFileSync(file, 'utf8') : 'missing')
          writeFileSync(temporary, body)
        }, renameSync, unlinkSync)
      publish(file, progress()); const first = readFileSync(file, 'utf8')
      publish(file, progress({ stage: 'client-ready' }))
      expect(observations).toEqual(['missing', first])
      expect(readCrashProgress(file, 321, 'cscb_codex_gate').value?.stage).toBe('client-ready')
      expect(lstatSync(file).mode & 0o777).toBe(0o600)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test.each(['success', 'transport rejection', 'arbitrary error'])('actual driver text callback records %s without streams or exception text', async kind => {
    const root = mkdtempSync('/tmp/codex-driver-checkpoint-')
    try {
      const source = readFileSync(join(import.meta.dir, 'real-agent/codex-delivery.ts'), 'utf8')
      const extract = (name: string) => source.match(new RegExp(`^(?:async )?function ${name}[\\s\\S]*?^\\}`, 'm'))![0]
      const token = fakeToken(BOT_TOKEN_PREFIX), captured: any = { log: [] }
      const transport = { ErrDialogMaybeOpen: class extends Error {}, ErrInvalidFlags: class extends Error {},
        ErrSendKeysWhileRelayed: class extends Error {}, ErrRelayFallenBack: class extends Error {} }
      let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
      const result = new Promise((yes, no) => { resolve = yes; reject = no })
      const program = [
        `let crashProgress = ${JSON.stringify(progress())};`,
        "let stage = 'prepare', crashBarrier = true, multipartSend, engines, preparation, queue, lifecycle;",
        "const process = { argv: ['bun', 'driver', 'crash-worker'] };",
        'const key = "synthetic", userNames = new Map(), channelNames = new Map();',
        'const instance = "cscb_codex_gate", work = stateDir;',
        'const queueModule = { createDeliveryQueue: () => ({ start: async () => {} }) };',
        'const engineModule = { createDeliveryLifecycle: () => ({}), createDeliveryEngines: options => { captured.options = options; return {}; } };',
        'const intakeModule = { createDeliveryPreparation: () => ({ recover: async () => {} }) };',
        'const receivedItem = () => {}, engineEvent = () => {}, log = text => captured.log.push(text);',
        extract('crashCheckpoint'), extract('crashError'), extract('buildEngine'),
        'return { buildEngine, stage: () => stage };',
      ].join('\n')
      const driver = new Function('stateDir', 'crashProtocol', 'join', 'client', 'transport', 'randomBytes', 'captured',
        new Bun.Transpiler({ loader: 'ts' }).transformSync(program))(
        root, { publishCrashProgress }, join, { sendKeys: () => result }, transport, () => ({ toString: () => 'synthetic' }), captured)
      await driver.buildEngine()
      expect(readCrashProgress(join(root, 'crash-progress.json'), 321, 'cscb_codex_gate').value?.stage).toBe('queue-ready')
      const sending = (await captured.options.clientFor()).sendKeys({ no_enter: true, text: token })
      expect(readCrashProgress(join(root, 'crash-progress.json'), 321, 'cscb_codex_gate').value).toMatchObject({ stage: 'text-call-start', textReturned: false })
      expect(existsSync(join(root, 'crash-after-text.json'))).toBe(false)
      if (kind === 'success') {
        let settled = false
        void sending.then(() => { settled = true })
        resolve({})
        await Promise.resolve(); await Promise.resolve()
        expect(readCrashProgress(join(root, 'crash-after-text.json'), 321, 'cscb_codex_gate').value).toMatchObject({ stage: 'text-call-return', textReturned: true })
        expect(driver.stage()).toBe('crash-worker-barrier-published'); expect(settled).toBe(false)
      } else {
        const error = kind === 'transport rejection' ? new transport.ErrRelayFallenBack(token) : new Error(token)
        reject(error)
        await expect(sending).rejects.toBe(error)
        captured.options.onError('synthetic', error)
        expect(readCrashProgress(join(root, 'crash-progress.json'), 321, 'cscb_codex_gate').value).toMatchObject({
          stage: 'text-call-start', textReturned: false, errors: 1, error: kind === 'transport rejection' ? 'ErrRelayFallenBack' : 'other' })
        expect(existsSync(join(root, 'crash-after-text.json'))).toBe(false)
      }
      const files = [readFileSync(join(root, 'crash-progress.json'), 'utf8'),
        existsSync(join(root, 'crash-after-text.json')) ? readFileSync(join(root, 'crash-after-text.json'), 'utf8') : '']
      assertNoLeak({ files, log: captured.log }); expect(JSON.stringify(files)).not.toContain(token)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

})
const scenarioSource = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
function shellFunction(name: string) {
  const declaration = scenarioSource.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0]
  expect(declaration).toBeDefined()
  return declaration!
}

describe('D1 closing enforcement without a CSCB server (synthetic shell evidence)', () => {
  test.each(['integration/test-41-fmk-real-codex.sh', 'real-agent/codex-ai-scenario.sh'])('%s gives the harness the tmux shim path', file => {
    const root = mkdtempSync('/tmp/codex-driver-path-')
    try {
      const source = readFileSync(join(import.meta.dir, file), 'utf8')
      const launch = source.split('\n').find(line => line.includes('codex-delivery.ts') && /\bbun\b/.test(line))!
      const script = join(root, 'entry.sh'), shim = join(root, 'tmux-shim')
      mkdirSync(shim)
      writeFileSync(script, ['set -euo pipefail', 'SCENARIO_TMUX_SHIM_BIN="$1"', 'AI_CRITERION=11',
        // This shell function never loads the driver or starts Bun, AD or tmux.
        'bun() { [[ "$PATH" == "$SCENARIO_TMUX_SHIM_BIN":* ]] || return 9; echo synthetic-driver-sees-tmux-shim; }', launch].join('\n'))
      const child = spawnSync('bash', [script, shim], {
        env: hostSafeChildEnv(root, { tools: ['bash', 'dirname'] }), encoding: 'utf8', timeout: 5000,
      })
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
      expect(child.status).toBe(0)
      expect(child.stdout).toBe('synthetic-driver-sees-tmux-shim\n')
      expect(child.stderr).toBe('')
      assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  function closing(options: { name?: string; before?: string; after?: string; omit?: boolean; subshell?: boolean } = {}) {
    const root = mkdtempSync('/tmp/codex-closing-'), scratch = join(root, 'scenario')
    mkdirSync(scratch)
    const ad = join(scratch, 'ad.log'), tmux = join(scratch, 'tmux.log'), record = join(scratch, 'record')
    writeFileSync(ad, [
      'call\t1.000000\t100\t90\t/usr/bin/bun /test-repo/tests/real-agent/codex-delivery.ts gate\tspawn --agent codex',
      'call\t2.000000\t101\t90\t/usr/bin/bun /test-repo/tests/real-agent/codex-delivery.ts gate\tsend-keys --instance-id synthetic --text OK',
    ].join('\n') + '\n')
    writeFileSync(tmux, 'call\t1.001000\t110\t100\t/scratch/agent-director.real spawn --agent codex\tnew-session\n')
    writeFileSync(record, '')
    // Only declarations are extracted. Never source scenario.sh on the host:
    // its real setup, installations, tmux and process discovery cannot run.
    const names = ['fail', '_scenario_add', '_scenario_to_us', '_scenario_split_line', '_scenario_eval_words', '_scenario_decode_words',
      '_scenario_ad_verb', '_scenario_finished_kill_words', '_scenario_read_log', '_scenario_closing_ran', '_scenario_closing_passed',
      'assert_codex_d1_safety', '_scenario_closing_check', '_scenario_closing_recheck', '_scenario_cleanup']
    const selection = scenarioSource.slice(scenarioSource.indexOf('SCENARIO_CLOSING_ASSERTIONS=('), scenarioSource.indexOf("# agent-director's default stopping window"))
    const script = [
      'set -euo pipefail', `TEST_NAME=${options.name ?? 'test-41-fmk-real-codex'}`, names.map(shellFunction).join('\n'), selection,
      '_SCENARIO_CLOSED=()', '_SCENARIO_START_COUNT=0', 'SCENARIO_FMK=1',
      '_SCENARIO_STATE_DIRS=()', '_SCENARIO_SERVER_PIDS=()', '_SCENARIO_TRACKED_PIDS=()', '_SCENARIO_EXIT_HOOKS=()',
      'SCENARIO_ROOT="$1"', 'SCENARIO_AD_SHIM_LOG="$1/ad.log"', 'SCENARIO_TMUX_SHIM_LOG="$1/tmux.log"', 'SCENARIO_CSCB_RECORD="$1/record"',
      '_SCENARIO_REAL_AD_SHIM_LOG="$SCENARIO_AD_SHIM_LOG"', '_SCENARIO_REAL_TMUX_SHIM_LOG="$SCENARIO_TMUX_SHIM_LOG"', '_SCENARIO_REAL_CSCB_RECORD="$SCENARIO_CSCB_RECORD"',
      'require_ci_image() { :; }', 'require_scenario_home() { :; }', '_scenario_query_prep() { :; }',
      '_scenario_tmux_shim_reset() { :; }', '_scenario_cscb_after() { :; }', '_scenario_stop_recorded_servers() { :; }', '_scenario_stop_tmux() { :; }',
      'trap _scenario_cleanup EXIT', options.before ?? '',
      options.omit ? ':' : options.subshell ? '( assert_codex_d1_safety )' : 'assert_codex_d1_safety', options.after ?? '',
      'echo "PASS: $TEST_NAME"',
    ].join('\n')
    try {
      const child = spawnSync('bash', ['-c', script, 'synthetic-closure', scratch], {
        env: hostSafeChildEnv(root, { tools: ['bash', 'grep', 'sed', 'rm'] }), encoding: 'utf8', timeout: 5000,
      })
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
      assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
      return { status: child.status, stdout: child.stdout, stderr: child.stderr }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  test.each(['test-41-fmk-real-codex', ...[11, 12, 15, 20, 106].map(ac => `test-${100 + ac}-fmk-real-codex-ai-ac${ac}`)])('%s reaches a zero-status EXIT trap with positive D1 evidence', name => {
    const result = closing({ name })
    expect(result).toEqual({ status: 0, stdout: `PASS: ${name}\n`, stderr: '' })
  })
  test.each([
    ['empty AD log', ': > "$SCENARIO_AD_SHIM_LOG"'], ['empty tmux log', ': > "$SCENARIO_TMUX_SHIM_LOG"'],
    ['server started', '_SCENARIO_START_COUNT=1'], ['server process recorded', 'echo proc >> "$SCENARIO_CSCB_RECORD"'],
    ['missing spawn', 'sed -i /spawn/d "$SCENARIO_AD_SHIM_LOG"'], ['missing send', 'sed -i /send-keys/d "$SCENARIO_AD_SHIM_LOG"'],
    ['direct harness tmux', 'sed -i s,agent-director.real,bun, "$SCENARIO_TMUX_SHIM_LOG"'],
    ['foreign tmux parent PID', 'printf "call\\t1.001000\\t110\\t999\\t/scratch/agent-director.real spawn --agent codex\\tnew-session\\n" > "$SCENARIO_TMUX_SHIM_LOG"'],
    ['tmux before AD call', 'sed -i s/1.001000/0.001000/ "$SCENARIO_TMUX_SHIM_LOG"'],
    ['malformed log', 'echo invalid >> "$SCENARIO_AD_SHIM_LOG"'],
    ...['delete', 'kill-finished', 'kill --include-finished'].map(verb => [verb, `printf 'call\\t3.000000\\t102\\t90\\t/usr/bin/bun /test-repo/tests/real-agent/codex-delivery.ts gate\\t${verb}\\n' >> "$SCENARIO_AD_SHIM_LOG"`]),
  ])('%s blocks successful closure', (_label, before) => {
    const result = closing({ before })
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('FAIL:')
  })
  test.each(['omit', 'subshell'] as const)('%s cannot satisfy own-shell closure', kind => {
    const result = closing({ [kind]: true })
    expect(result.status).toBe(1); expect(result.stderr).toContain('without the closing assertions')
  })
  test('late unsafe calls fail the EXIT recheck even after the PASS line', () => {
    const result = closing({ after: ': > "$SCENARIO_AD_SHIM_LOG"' })
    expect(result.status).toBe(1); expect(result.stdout).toContain('PASS:'); expect(result.stderr).toContain('after the closing assertions')
  })
  test('normal and lookalike fmk scenarios still require all three server-backed assertions', () => {
    for (const name of ['test-32-fmk-real-order', 'test-999-fmk-real-codex', 'test-111-fmk-real-codex-ai-ac12']) {
      const result = closing({ name })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('assert_no_server_tmux, assert_no_cscb_include_finished, assert_no_cscb_delete')
    }
  })
})
function withScratchLifecycle(run: (fixture: {
  root: string; home: string; stateDir: string; config: string; receipt: string
  checks: unknown[]; writeConfig(text: string): void; guard(projection?: string): ReturnType<typeof createScratchCodexLifecycle>
}) => void) {
  const root = mkdtempSync('/tmp/codex-lifecycle-'), home = join(root, '.codex'), stateDir = join(root, 'state'), checks: unknown[] = []
  try {
    mkdirSync(home, { mode: 0o700 }); mkdirSync(stateDir, { mode: 0o700 })
    // This deliberately dangling link proves guards never open login bytes.
    symlinkSync(CODEX_AUTH_MOUNT, join(home, 'auth.json'))
    run({ root, home, stateDir, config: join(home, 'config.toml'), receipt: join(stateDir, 'codex-native-spawn.json'), checks,
      writeConfig: text => writeFileSync(join(home, 'config.toml'), text, { mode: 0o600 }),
      guard: (projection = hostProjection) => createScratchCodexLifecycle({ root, home, stateDir, hostProjection: projection,
        checkConfigKeys: checkCodexScratchConfigKeys, onCheck: (checkpoint, check) => checks.push({ checkpoint, ...check }) }),
    })
    assertNoLeak(checks)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const native = (type: string, payload: any, at = sentAt + 1) => ({ type, payload, timestamp: new Date(at).toISOString() })
function rows() {
  return [native('session_meta', { id: session }, 0),
    native('event_msg', { type: 'task_started', turn_id: 'synthetic-turn' }),
    native('turn_context', { model, turn_id: 'synthetic-turn' }),
    native('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
    native('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }),
    native('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 12, output_tokens: 2, cached_input_tokens: 3 } } }),
    native('event_msg', { type: 'task_complete', turn_id: 'synthetic-turn' }, sentAt + 2)]
}
const bytes = (values: any[]) => Buffer.from(values.map(v => JSON.stringify(v) + '\n').join(''))
function sample(values = rows()) {
  const data = projectCodexRollout(bytes(values), session)
  return { data, window: { session, offset: data.records[0]!.end, sentAt, text, model } }
}
function result(values: any[]) { const { data, window } = sample(values); return completedCodexTurn(data, window) }

describe('D1 scratch and model refusal contract', () => {
  const env = { SCENARIO_ROOT: '/tmp/synthetic-codex', HOME: '/tmp/synthetic-codex/home', TMUX_TMPDIR: '/tmp/synthetic-codex/tmux', CODEX_TEST_MODEL: model }
  test('only contained paths and the explicitly selected model are returned', () => {
    const result = codexContainment(env, p => p)
    expect(result).toEqual({ root: env.SCENARIO_ROOT, home: env.HOME, tmux: env.TMUX_TMPDIR, model })
    assertNoLeak(result)
  })
  test.each([
    ['HOME', '/tmp/other'], ['HOME', '/tmp/synthetic-codex'], ['TMUX_TMPDIR', '/tmp/other'], ['TMUX_TMPDIR', undefined],
    ['TMUX', ''], ['TMUX', 'synthetic'], ['SCENARIO_ROOT', '/'], ['SCENARIO_ROOT', '/test-results/synthetic'],
    ['CODEX_TEST_MODEL', undefined], ['CODEX_TEST_MODEL', 'model" unsafe'],
  ])('%s refuses unsafe value %s before any process runs', (name, value) => {
    expect(() => codexContainment({ ...env, [name as string]: value }, p => p)).toThrow()
  })
  test.each(['HOME', 'TMUX_TMPDIR'])('%s symlink escape is refused after resolution', name => {
      const root = mkdtempSync('/tmp/codex-containment-')
    try {
      const scratch = join(root, 'scratch'), home = join(scratch, 'home'), tmux = join(scratch, 'tmux'), outside = join(root, 'outside')
      mkdirSync(scratch); mkdirSync(outside)
      for (const [kind, path] of [['HOME', home], ['TMUX_TMPDIR', tmux]]) {
        if (kind === name) symlinkSync(outside, path!)
        else mkdirSync(path!)
      }
      expect(() => codexContainment({ SCENARIO_ROOT: scratch, HOME: home, TMUX_TMPDIR: tmux, CODEX_TEST_MODEL: model }, realpathSync)).toThrow('escape')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('D1 launch carries model, update/file-store controls, sandbox, policy and first prompt', () => {
    const prompt = `synthetic tag description\n${CODEX_NO_REPLY}`
    const args = codexArguments(model, prompt)
    expect(args).toEqual(['-c', `model="${model}"`, '-c', 'check_for_update_on_startup=false', '-c', 'cli_auth_credentials_store="file"', '-c', 'tui.show_tooltips=false', '-a', 'never', '-s', 'workspace-write', prompt])
    expect(args.some(arg => arg.startsWith('--home') || arg.startsWith('--store-path'))).toBe(false)
    assertNoLeak(args)
  })
})

describe('D1 scratch preparation and disposable observation cleanup', () => {
  test.each(['ended', 'missing', 'still live', 'kill failure', 'sweep failure'] as const)('gate retires the observation before spawning: %s', async outcome => {
    const source = readFileSync(join(import.meta.dir, 'real-agent/codex-delivery.ts'), 'utf8')
    const extract = (name: string) => source.match(new RegExp(`^(?:async )?function ${name}[\\s\\S]*?^\\}`, 'm'))![0]
    // Execute the driver's actual transition and retirement functions, with
    // every native boundary injected. Never import its guarded entrypoint.
    const gate = extract('gate').split("  stage = 'gate-ac2'")[0] + '}\n'
    expect(gate).toContain("await start('gate')")
    const stop = source.match(/^async function stopEngine\(\).*$/m)![0]
    const events: string[] = [], records: unknown[] = [], live = new Set(['cscb_codex_delivery'])
    let releaseKill!: () => void, reachedKill!: () => void, releaseSweep!: () => void, reachedSweep!: () => void
    const killing = new Promise<void>(resolve => { releaseKill = resolve })
    const killReached = new Promise<void>(resolve => { reachedKill = resolve })
    const sweeping = new Promise<void>(resolve => { releaseSweep = resolve })
    const sweepReached = new Promise<void>(resolve => { reachedSweep = resolve })
    const failure = new Error('synthetic retirement failure')
    let state = 'waiting', sweeps = 0
    const client = {
      kill: async ({ instance_id }: { instance_id: string }) => {
        expect(instance_id).toBe('cscb_codex_delivery')
        events.push('kill'); reachedKill(); await killing
        if (outcome === 'kill failure') throw failure
      },
      findMissing: async () => {
        events.push('sweep'); sweeps++
        if (sweeps === 2) { reachedSweep(); await sweeping }
        if (outcome === 'sweep failure') throw failure
        if (sweeps >= 2 && (outcome === 'ended' || outcome === 'missing')) state = outcome
      },
      get: async ({ instance_id }: { instance_id: string }) => {
        expect(instance_id).toBe('cscb_codex_delivery'); events.push(`get:${state}`)
        return { instance_id, agent: 'codex', labels: { tag_prompt: '1' }, relay_mode: 'on', cwd: '/synthetic/work', state }
      },
    }
    const stopOwner = (name: string) => ({ stop: async () => { events.push(`stop:${name}`) } })
    const program = [
      "let instance = 'cscb_codex_delivery', stage = 'prepare', lastKey = null; const work = '/synthetic/work';",
      "const observe = async completion => { events.push(`observe:${completion}`); };",
      "const start = async label => { events.push(`spawn:${label}`); };",
      "const buildEngine = async () => { events.push('build:gate'); };",
      'const rollout = async () => { events.push("retain:rollout"); };',
      'const record = (_label, value) => records.push(value);',
      'const poll = async (_label, check) => { for (let n = 0; n < 3; n++) { const value = await check(); if (value !== undefined) return value; } throw failure; };',
      stop, extract('row'), extract('retired'), extract('retire'), gate, 'return gate;',
    ].join('\n')
    const run = new Function('client', 'codexRetirementCheckpoint', 'liveInstances', 'events', 'records', 'failure', 'engines', 'preparation', 'lifecycle', 'queue',
      new Bun.Transpiler({ loader: 'ts' }).transformSync(program))(
      client, codexRetirementCheckpoint, live, events, records, failure,
      stopOwner('engine'), stopOwner('preparation'), stopOwner('lifecycle'), stopOwner('queue'))
    const result = run().then(() => null, (error: unknown) => error)
    await killReached
    expect(events).toEqual(['observe:false', 'stop:engine', 'stop:preparation', 'stop:lifecycle', 'stop:queue', 'kill'])
    expect(live.has('cscb_codex_delivery')).toBe(true)
    releaseKill()
    if (outcome !== 'kill failure' && outcome !== 'sweep failure') {
      await sweepReached
      expect(events.slice(-3)).toEqual(['sweep', 'get:waiting', 'sweep'])
      expect(events.some(event => event.startsWith('spawn:'))).toBe(false)
      expect(live.has('cscb_codex_delivery')).toBe(true)
      releaseSweep()
    }
    const error = await result
    if (outcome === 'ended' || outcome === 'missing') {
      expect(error).toBeNull()
      expect(events.slice(-5)).toEqual([`get:${outcome}`, 'retain:rollout', `get:${outcome}`, 'spawn:gate', 'build:gate'])
      expect(live.size).toBe(0)
      expect(records).toEqual([{ label: 'delivery', instance: 'cscb_codex_delivery', method: 'kill-and-find-missing', state: outcome, retired: true }])
    } else {
      expect(error).toBe(failure)
      expect(events.some(event => event.startsWith('spawn:'))).toBe(false)
      expect(live.has('cscb_codex_delivery')).toBe(true)
      expect(records).toEqual([])
    }
    assertNoLeak({ events, records, error })
  })
  test.each(['absent', 'existing', 'escaped-parent', 'symlink', 'hardlink'])('%s AD config stays inside scratch', kind => {
    const root = mkdtempSync('/tmp/codex-config-')
    try {
      const scratch = join(root, 'scratch'), home = join(scratch, 'home'), parent = join(home, '.config/agent-director')
      const outside = join(root, 'outside'), target = join(outside, 'config.toml'), config = join(parent, 'config.toml')
      mkdirSync(parent, { recursive: true }); mkdirSync(outside)
      const original = '[other]\nkeep = true\n[launch]\ncodex_path = "old"\n'
      writeFileSync(target, original)
      if (kind === 'existing') writeFileSync(config, original)
      if (kind === 'escaped-parent') { rmSync(parent, { recursive: true }); symlinkSync(outside, parent) }
      if (kind === 'symlink') symlinkSync(target, config)
      if (kind === 'hardlink') linkSync(target, config)
      if (['absent', 'existing'].includes(kind)) {
        configureScratchCodex(scratch, home)
        const content = readFileSync(config, 'utf8')
        expect(content).toContain(`[launch]\ncodex_path = "${CODEX_NATIVE}"`)
        expect(content.match(/\[launch\]/g)).toHaveLength(1)
        if (kind === 'existing') expect(content).toContain('[other]\nkeep = true')
        else expect(lstatSync(config).mode & 0o777).toBe(0o600)
        assertNoLeak(content)
      } else expect(() => configureScratchCodex(scratch, home)).toThrow()
      expect(readFileSync(target, 'utf8')).toBe(original)
      assertNoLeak(readFileSync(target, 'utf8'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test.each(['valid', 'regular-auth', 'foreign-target', 'config', 'public-home'])('%s auth contract projects only independent metadata booleans', kind => {
    const root = mkdtempSync('/tmp/codex-contract-'), home = join(root, '.codex')
    try {
      mkdirSync(home, { mode: 0o700 })
      const auth = join(home, 'auth.json')
      if (kind === 'regular-auth') writeFileSync(auth, fakeToken(BOT_TOKEN_PREFIX, 'scratch-auth'))
      else symlinkSync(kind === 'foreign-target' ? join(root, 'unreadable-synthetic-target') : CODEX_AUTH_MOUNT, auth)
      if (kind === 'config') writeFileSync(join(home, 'config.toml'), '')
      if (kind === 'public-home') chmodSync(home, 0o755)
      const projection = scratchCodexContract(home)
      expect(projection).toEqual({ symlink: kind !== 'regular-auth', targetMatches: !['regular-auth', 'foreign-target'].includes(kind),
        scratchConfigPresent: kind === 'config', privateHome: kind !== 'public-home' })
      assertNoLeak(projection)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test.each(['waiting', 'working', 'pending', 'stopping', 'unverified', 'ended', 'missing'])('retirement sweep accepts only terminal state %s', async state => {
    const calls: string[] = []
    expect(await codexRetirementCheckpoint({ findMissing: async () => { calls.push('sweep') },
      state: async () => { calls.push('get'); return state },
    })).toBe(state === 'ended' || state === 'missing')
    expect(calls).toEqual(['sweep', 'get'])
  })

})

describe('decision 22 native scratch config lifecycle', () => {
  test('first prepare requires absence; only a returned guarded spawn establishes durable provenance', () => withScratchLifecycle(f => {
    const guard = f.guard()
    expect(guard.check()).toMatchObject({ scratchConfigPresent: false, keyNames: [], unknownKeyCount: 0, nativeSpawnRecorded: false })
    expect(() => guard.afterSpawn('synthetic_row')).toThrow('lifecycle contract failed')
    expect(() => lstatSync(f.receipt)).toThrow()
    guard.beforeSpawn()
    f.writeConfig(nativeConfig) // simulate native startup, never a real launch
    expect(guard.afterSpawn('synthetic_row')).toMatchObject({ scratchConfigPresent: true, nativeSpawnRecorded: true,
      keyNames: ['tui.screen_reader_detection_done', 'tui'], unknownKeyCount: 0, allowed: true })
    expect(lstatSync(f.receipt).mode & 0o777).toBe(0o400)
    expect(f.guard().check('prepare').nativeSpawnRecorded).toBe(true)
    const secondRow = f.guard()
    secondRow.beforeSpawn(); secondRow.afterSpawn('synthetic_second_row')
    expect(f.guard().check('final').allowed).toBe(true)
    assertNoLeak(readFileSync(f.receipt, 'utf8'))
  }))
  test.each(['empty', 'native-marker', 'unknown'])('preexisting %s config never establishes prior native provenance and is retained', kind => withScratchLifecycle(f => {
    const value = kind === 'empty' ? '' : kind === 'native-marker' ? nativeConfig : 'model = "synthetic"\n'
    f.writeConfig(value)
    expect(() => f.guard().check()).toThrow('lifecycle contract failed')
    expect(readFileSync(f.config, 'utf8')).toBe(value)
    expect(() => lstatSync(f.receipt)).toThrow()
  }))
  test('a crash during an unconfirmed spawn cannot grant native provenance on recovery', () => withScratchLifecycle(f => {
    f.guard().beforeSpawn()
    f.writeConfig(nativeConfig)
    expect(() => f.guard().check()).toThrow('lifecycle contract failed')
    expect(readFileSync(f.config, 'utf8')).toBe(nativeConfig)
  }))
  test('replacing the home during the first spawn cannot transfer its absence proof', () => withScratchLifecycle(f => {
    const guard = f.guard()
    guard.beforeSpawn()
    renameSync(f.home, join(f.root, 'original-home')); mkdirSync(f.home, { mode: 0o700 })
    symlinkSync(CODEX_AUTH_MOUNT, join(f.home, 'auth.json')); f.writeConfig(nativeConfig)
    expect(() => guard.afterSpawn('synthetic_row')).toThrow('lifecycle contract failed')
    expect(() => lstatSync(f.receipt)).toThrow()
  }))
  test.each(['prepare', 'prespawn', 'postidle', 'final', 'on-error'])('%s revalidates keys after a durable native spawn', checkpoint => withScratchLifecycle(f => {
    const guard = f.guard()
    guard.beforeSpawn(); guard.afterSpawn('synthetic_row')
    const secret = fakeToken(BOT_TOKEN_PREFIX, 'codex-config-value')
    f.writeConfig(`unexpected = "${secret}"\n`)
    expect(() => checkpoint === 'prespawn' ? guard.beforeSpawn() : f.guard().check(checkpoint)).toThrow('lifecycle contract failed')
    expect(f.checks.at(-1)).toMatchObject({ keyNames: ['unexpected'], unknownKeyCount: 1, allowed: false })
    expect(JSON.stringify(f.checks)).not.toContain(secret)
  }))
  test.each([
    ['unknown', 'unexpected = true\n'], ['model', 'model = "synthetic"\n'], ['reasoning', 'model_reasoning_effort = "synthetic"\n'],
    ['profile', '[profiles.synthetic]\n'], ['provider', '[model_providers.synthetic]\n'], ['auth', 'auth = {}\n'],
  ])('%s keys fail without retaining config values', (_kind, config) => withScratchLifecycle(f => {
    const guard = f.guard()
    guard.beforeSpawn(); guard.afterSpawn('synthetic_row')
    f.writeConfig(config)
    expect(() => f.guard().check()).toThrow('lifecycle contract failed')
    expect(f.checks.at(-1)).toMatchObject({ allowed: false })
    expect(readFileSync(f.config, 'utf8')).toBe(config)
  }))
  test.each([
    [['tui']], [['tui'], ['tui', 'screen_reader_detection_done']], [['tui'], ['tui', 'other_host_setting']],
  ])('native lifecycle admits the amended host namespace overlap: %j', (...paths) => withScratchLifecycle(f => {
    const guard = f.guard(encodeCodexHostConfigKeys([['model'], ...paths as string[][]]))
    guard.beforeSpawn()
    f.writeConfig(nativeConfig)
    guard.afterSpawn('synthetic_row')
    expect(lstatSync(f.receipt).isFile()).toBe(true)
    expect(f.checks.at(-1)).toMatchObject({ allowed: true, unknownKeyCount: 0 })
    f.writeConfig(`${nativeConfig}other_host_setting = true\n`)
    expect(() => guard.check()).toThrow('lifecycle contract failed')
    expect(f.checks.at(-1)).toMatchObject({ allowed: false, unknownKeyCount: 1 })
  }))
  test.each(['missing', 'malformed', 'unversioned', 'truncated', 'bad-toml'])('%s metadata or TOML fails with a fixed value-free error', kind => withScratchLifecycle(f => {
    const secret = fakeToken(BOT_TOKEN_PREFIX, 'projection-error')
    const projection = kind === 'missing' ? undefined : kind === 'malformed' ? secret
      : kind === 'unversioned' ? '{}' : kind === 'truncated' ? '{"version":1,"keys":[]}' : hostProjection
    const guard = createScratchCodexLifecycle({ root: f.root, home: f.home, stateDir: f.stateDir,
      hostProjection: projection, checkConfigKeys: checkCodexScratchConfigKeys })
    if (kind === 'bad-toml') {
      guard.beforeSpawn(); guard.afterSpawn('synthetic_row')
      f.writeConfig(`[tui]\nscreen_reader_detection_done = "${secret}`)
    }
    let error: unknown
    try { guard.check() } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('scratch Codex auth/config lifecycle contract failed')
    assertNoLeak(error)
  }))
  test.each(['symlink', 'dangling-symlink', 'directory', 'hardlink', 'public-writable', 'oversize', 'invalid-utf8'])('unsafe %s config is refused without following or changing it', kind => withScratchLifecycle(f => {
    const guard = f.guard()
    guard.beforeSpawn(); guard.afterSpawn('synthetic_row')
    const outside = join(f.root, 'untrusted.toml')
    writeFileSync(outside, nativeConfig)
    if (kind === 'symlink') symlinkSync(outside, f.config)
    if (kind === 'dangling-symlink') symlinkSync(join(f.root, 'missing'), f.config)
    if (kind === 'directory') mkdirSync(f.config)
    if (kind === 'hardlink') linkSync(outside, f.config)
    if (kind === 'public-writable') { f.writeConfig(nativeConfig); chmodSync(f.config, 0o666) }
    if (kind === 'oversize') f.writeConfig(' '.repeat(1024 * 1024 + 1))
    if (kind === 'invalid-utf8') writeFileSync(f.config, Buffer.concat([Buffer.from('[tui]\nscreen_reader_detection_done = "'), Buffer.from([0xff]), Buffer.from('"\n')]), { mode: 0o600 })
    expect(() => f.guard().check('final')).toThrow('lifecycle contract failed')
    expect(readFileSync(outside, 'utf8')).toBe(nativeConfig)
  }))
  test.each(['public-home', 'foreign-auth', 'regular-auth', 'home-symlink', 'state-symlink', 'replaced-home', 'receipt-symlink', 'receipt-hardlink', 'public-receipt', 'partial-receipt'])('recovery refuses %s even beside allowlisted config', kind => withScratchLifecycle(f => {
    const guard = f.guard()
    guard.beforeSpawn(); f.writeConfig(nativeConfig); guard.afterSpawn('synthetic_row')
    if (kind === 'public-home') chmodSync(f.home, 0o755)
    if (kind === 'foreign-auth' || kind === 'regular-auth') {
      rmSync(join(f.home, 'auth.json'))
      if (kind === 'foreign-auth') symlinkSync(join(f.root, 'foreign'), join(f.home, 'auth.json'))
      else writeFileSync(join(f.home, 'auth.json'), fakeToken(BOT_TOKEN_PREFIX, 'unread-login'))
    }
    if (kind === 'home-symlink' || kind === 'state-symlink') {
      const path = kind === 'home-symlink' ? f.home : f.stateDir
      rmSync(path, { recursive: true }); mkdirSync(join(f.root, 'replacement'), { mode: 0o700 }); symlinkSync(join(f.root, 'replacement'), path)
    }
    if (kind === 'replaced-home') {
      // Keep the old inode allocated so replacement cannot reuse it.
      renameSync(f.home, join(f.root, 'old-home')); mkdirSync(f.home, { mode: 0o700 })
      symlinkSync(CODEX_AUTH_MOUNT, join(f.home, 'auth.json')); f.writeConfig(nativeConfig)
    }
    if (kind === 'receipt-symlink') { const copy = readFileSync(f.receipt); rmSync(f.receipt); writeFileSync(join(f.root, 'receipt'), copy); symlinkSync(join(f.root, 'receipt'), f.receipt) }
    if (kind === 'receipt-hardlink') linkSync(f.receipt, join(f.root, 'receipt'))
    if (kind === 'public-receipt') chmodSync(f.receipt, 0o644)
    if (kind === 'partial-receipt') { chmodSync(f.receipt, 0o600); writeFileSync(f.receipt, '{'); chmodSync(f.receipt, 0o400) }
    expect(() => f.guard().check('prepare')).toThrow('lifecycle contract failed')
  }))
})

describe('synthetic Codex native-evidence controls', () => {
  test('completed own current turn is distinct from a take-in receipt', () => {
    const { data, window } = sample(), completed = completedCodexTurn(data, window)
    expect(completed).toMatchObject({ model, answer: 'OK', send: { session, at: sentAt, offset: window.offset }, tokens: { input: 12, output: 2, cache_read: 3, cache_creation: 0 } })
    expect(completed.receipt.offset).toBeLessThan(completed.completion.offset)
    assertNoLeak(completed)
  })
  test.each(['wrong-session', 'stale', 'assistant-only', 'incomplete-turn', 'wrong-model', 'foreign-turn', 'aborted', 'wrong-text', 'later-user', 'stale-assistant'])('%s evidence cannot complete a trial', kind => {
    const values = rows()
    if (kind === 'wrong-session') values[0].payload.id = 'foreign-session'
    if (kind === 'stale') values[3].timestamp = new Date(sentAt - 1).toISOString()
    if (kind === 'assistant-only') values[3].payload.role = 'assistant'
    if (kind === 'incomplete-turn') values.pop()
    if (kind === 'wrong-model') values[2].payload.model = 'foreign-model'
    if (kind === 'foreign-turn') values.at(-1)!.payload.turn_id = 'foreign-turn'
    if (kind === 'aborted') values.splice(5, 0, native('event_msg', { type: 'turn_aborted' }))
    if (kind === 'wrong-text') values[3].payload.content[0].text += ' changed'
    if (kind === 'later-user') values.splice(4, 0, native('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'another input' }] }))
    if (kind === 'stale-assistant') values[4].timestamp = new Date(sentAt - 1).toISOString()
    expect(() => result(values)).toThrow()
  })
  test('a pre-send record cannot qualify even with a current timestamp', () => {
    const { data, window } = sample()
    expect(() => completedCodexTurn(data, { ...window, offset: data.records[3]!.end })).toThrow('take-in')
  })
  test.each(['partial', 'damaged', 'missing-owner', 'duplicate-owner'])('%s rollout cannot provide completion evidence', kind => {
    const values = rows()
    if (kind === 'missing-owner') values.shift()
    if (kind === 'duplicate-owner') values.push(values[0])
    const encoded = bytes(values)
    expect(() => {
      const data = projectCodexRollout(kind === 'partial' ? Buffer.concat([encoded, Buffer.from('{')]) : kind === 'damaged' ? Buffer.concat([encoded, Buffer.from('invalid\n')]) : encoded, session)
      completedCodexTurn(data, { session, offset: 0, sentAt, text, model })
    }).toThrow()
  })
  test('only safe event metadata survives projection, even from arbitrary native payloads', () => {
    const values = rows(), secret = fakeToken(BOT_TOKEN_PREFIX, 'codex-projection')
    values[0].payload.config = { credential: secret }; values[0].payload.cwd = secret
    values.push(native('unknown', { auth: secret, headers: { authorization: secret }, content: secret }))
    const { data } = sample(values), safe = safeCodexEvents(data)
    expect(JSON.stringify(safe).includes(secret)).toBe(false)
    expect(JSON.stringify(safe).includes(text)).toBe(false)
    assertNoLeak(safe)
  })
})
