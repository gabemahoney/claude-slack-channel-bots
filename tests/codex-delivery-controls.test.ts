/** D1 refusal and evidence controls only. Every rollout below is synthetic;
 * these controls perform no login access, model call or native launch. */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, readFileSync, writeFileSync, lstatSync, linkSync, chmodSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { codexContainment, codexArguments, configureScratchCodex, createScratchCodexLifecycle, scratchCodexContract, retireCodexObservation, codexRetirementCheckpoint, CODEX_NATIVE, CODEX_AUTH_MOUNT, CODEX_NO_REPLY } from './real-agent/codex-guards.ts'
import { checkCodexScratchConfigKeys, encodeCodexHostConfigKeys } from '../src/codex-config-keys.ts'
import { completedCodexTurn, codexNoTurn, projectCodexRollout, safeCodexEvents } from './real-agent/codex-evidence.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX } from './test-helpers/credentials.ts'

const session = 'synthetic-session', model = 'synthetic/model', text = 'synthetic exact input', sentAt = 1000
const hostProjection = encodeCodexHostConfigKeys([['model']])
const nativeConfig = '[tui]\nscreen_reader_detection_done = true\n'
const scenarioSource = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
function shellFunction(name: string) {
  const declaration = scenarioSource.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0]
  expect(declaration).toBeDefined()
  return declaration!
}

describe('D1 closing enforcement without a CSCB server (synthetic shell evidence)', () => {
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
  test.each([
    { name: 'idle popup', draft: true, waiting: true }, { name: 'idle multiline draft', draft: true, waiting: true },
    { name: 'busy multiline draft', draft: true, waiting: false }, { name: 'clean waiting row', draft: false, waiting: true },
    { name: 'busy row', draft: false, waiting: false },
  ])('$name uses supported AD operations and proves retirement', async options => {
    const calls: string[] = []
    let state = 'waiting'
    await retireCodexObservation({
      sendEscape: async () => { calls.push('Escape') },
      afterEscape: async () => { calls.push('pane-with-draft-still-present') },
      kill: async () => { calls.push('kill') }, // AD kill deliberately leaves row state unchanged.
      ended: () => codexRetirementCheckpoint({
        findMissing: async () => { calls.push('find-missing'); state = 'missing' },
        state: async () => { calls.push('get-state'); return state },
      }),
    }, options)
    expect(calls).toEqual(options.draft ? ['Escape', 'pane-with-draft-still-present', 'kill', 'find-missing', 'get-state']
      : ['kill', 'find-missing', 'get-state'])
    assertNoLeak(calls)
  })
  test('a failed Escape still kills the row and preserves the refusal', async () => {
    const calls: string[] = [], refusal = new Error('synthetic AD refusal')
    await expect(retireCodexObservation({ sendEscape: async () => { throw refusal }, afterEscape: async () => { calls.push('pane') },
      kill: async () => { calls.push('kill') }, ended: async () => false,
    }, { draft: true, waiting: true })).rejects.toBe(refusal)
    expect(calls).toEqual(['kill'])
  })
  test('a successful kill without ended-row evidence cannot complete cleanup', async () => {
    await expect(retireCodexObservation({ sendEscape: async () => {}, afterEscape: async () => {},
      kill: async () => {}, ended: async () => false,
    }, { draft: false, waiting: false })).rejects.toThrow('not confirmed')
  })
  test.each(['waiting', 'working', 'pending', 'stopping', 'unverified', 'ended', 'missing'])('retirement sweep accepts only terminal state %s', async state => {
    const calls: string[] = []
    expect(await codexRetirementCheckpoint({ findMissing: async () => { calls.push('sweep') },
      state: async () => { calls.push('get'); return state },
    })).toBe(state === 'ended' || state === 'missing')
    expect(calls).toEqual(['sweep', 'get'])
  })
  test('a failed retirement sweep cannot certify a stale terminal row', async () => {
    const refusal = new Error('synthetic sweep refusal'), calls: string[] = []
    await expect(codexRetirementCheckpoint({ findMissing: async () => { throw refusal },
      state: async () => { calls.push('get'); return 'ended' },
    })).rejects.toBe(refusal)
    expect(calls).toEqual([])
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
  test('a real send window with no new turn is diagnostic evidence only', () => {
    const { data } = sample()
    const window = { session, offset: data.size, sentAt: sentAt + 3, text, model }
    const proof = codexNoTurn(data, window, { at: sentAt + 1000, shimAt: sentAt + 4, shimText: text, noEnter: true })
    expect(proof).toEqual({ session, sentAt: sentAt + 3, shimAt: sentAt + 4, observedAt: sentAt + 1000,
      noEnter: true, afterOffset: data.size, size: data.size, observedForMs: 997, events: [] })
    expect(() => completedCodexTurn(data, window)).toThrow()
    assertNoLeak(proof)
  })
  test.each(['wrong-session', 'active-turn', 'unproven-send', 'submitted', 'zero-interval', 'invalid-offset', 'partial', 'pre-window-shim', 'future-shim', 'invalid-shim-time'])('%s cannot prove no turn began', kind => {
    const { data } = sample(), window = { session, offset: data.size, sentAt, text, model }, observation = { at: sentAt + 1000, shimAt: sentAt + 1, shimText: text, noEnter: true }
    if (kind === 'wrong-session') window.session = 'foreign-session'
    if (kind === 'active-turn') window.offset = data.records[0]!.end
    if (kind === 'unproven-send') observation.shimText = 'another text'
    if (kind === 'submitted') observation.noEnter = false
    if (kind === 'zero-interval') observation.at = sentAt
    if (kind === 'invalid-offset') window.offset = NaN
    if (kind === 'partial') data.incomplete = true
    if (kind === 'pre-window-shim') observation.shimAt = sentAt - 1
    if (kind === 'future-shim') observation.shimAt = observation.at + 1
    if (kind === 'invalid-shim-time') observation.shimAt = NaN
    expect(() => codexNoTurn(data, window, observation)).toThrow()
  })
})
