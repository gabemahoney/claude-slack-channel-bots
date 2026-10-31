/** b.iy3: failure sensitivity of the exact HTTP/list oracles used by the
 * real-AD image scenarios. These are observation copies, never AD responses
 * supplied to a production client. No server, worker, Docker or host AD runs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertListStates, assertPermissionPosts } from './integration/fixtures/displayed-state-assertions.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const INSTANCE = 'displayed-instance'
const CHANNEL = 'C0DISPLAY'
function observations() {
  const trail = ['first', 'second'].map((request_token, i) => ({
    event: 'cscb.chat_post.attempted', request_token, instance_id: INSTANCE, channel: CHANNEL,
    slack_ts: `100.${i}`, ok: true, text: `request ${request_token}`, blocks: [{ type: 'section', block_id: request_token }],
  }))
  const rows = trail.map(event => ({ event: 'api', method: 'chat.postMessage', channel: CHANNEL,
    response_ts: event.slack_ts, answer: 'ok', args_token_like: false, text: event.text, blocks: event.blocks }))
  return { rows, trail }
}

describe('all-destination HTTP post bijection', () => {
  test('zero, one and two requests report measured counts and joined timestamps', () => {
    const { rows, trail } = observations()
    for (const count of [0, 1, 2]) {
      const events = trail.slice(0, count)
      const result = assertPermissionPosts(rows.slice(0, count), events, events.map(e => e.request_token), INSTANCE, CHANNEL)
      expect(result).toEqual({ post_count: count, posts: events.map(event => ({
        request_token: event.request_token, slack_ts: event.slack_ts, channel: CHANNEL,
      })) })
      assertNoLeak(result)
    }
  })

  test.each([CHANNEL, 'C0EXTRA'])('an extra post to %s fails the same oracle, including in the zero-post leg', (channel) => {
    const { rows, trail } = observations()
    const extra = { ...rows[0]!, channel, response_ts: 'extra' }
    for (const count of [0, 1, 2]) {
      const events = trail.slice(0, count)
      expect(() => assertPermissionPosts([...rows.slice(0, count), extra], events,
        events.map(e => e.request_token), INSTANCE, CHANNEL)).toThrow('HTTP post count differs from expected requests')
    }
  })

  test.each([
    ['duplicate event plus unmatched HTTP response', (o: ReturnType<typeof observations>) => { o.trail[1]!.slack_ts = o.trail[0]!.slack_ts }],
    ['duplicate HTTP response', (o: ReturnType<typeof observations>) => { o.rows[1]!.response_ts = o.rows[0]!.response_ts }],
    ['wrong destination', (o: ReturnType<typeof observations>) => { o.rows[0]!.channel = 'C0EXTRA' }],
    ['wrong text', (o: ReturnType<typeof observations>) => { o.rows[0]!.text = 'unrelated text' }],
    ['wrong blocks', (o: ReturnType<typeof observations>) => { o.rows[0]!.blocks = [] }],
    ['unsuccessful API response', (o: ReturnType<typeof observations>) => { o.rows[0]!.answer = 'refused' }],
    ['unsuccessful trail', (o: ReturnType<typeof observations>) => { o.trail[0]!.ok = false }],
    ['wrong instance', (o: ReturnType<typeof observations>) => { o.trail[0]!.instance_id = 'another-instance' }],
    ['reposted first token', (o: ReturnType<typeof observations>) => { o.trail[1]!.request_token = 'first' }],
    ['leaking API arguments', (o: ReturnType<typeof observations>) => { o.rows[0]!.args_token_like = true }],
    ['missing API leak flag', (o: ReturnType<typeof observations>) => { Reflect.deleteProperty(o.rows[0]!, 'args_token_like') }],
  ] as const)('%s is rejected', (_label, mutate) => {
    const observed = observations()
    mutate(observed)
    expect(() => assertPermissionPosts(observed.rows, observed.trail, ['first', 'second'], INSTANCE, CHANNEL)).toThrow()
    assertNoLeak(observed)
  })
})

describe('returned list states', () => {
  test.each([
    { state: 'working', displayed_state: 'idle_screen' },
    { state: 'idle_screen' }, { state: 'working' },
    { state: 'needs_intelligence' }, { state: 'check_permission' },
  ])('exact positive row %j; missing, duplicate and wrong state rejected', (expected) => {
    expect(() => assertListStates([{ ...expected }], expected)).not.toThrow()
    expect(() => assertListStates([], expected)).toThrow('unexpected list membership/count')
    expect(() => assertListStates([{ ...expected }, { ...expected }], expected)).toThrow('unexpected list membership/count')
    expect(() => assertListStates([{ ...expected, state: 'waiting' }], expected)).toThrow('wrong returned list state')
  })
  test('current displayed field is mandatory and legacy raw filter absence is exact', () => {
    const expected = { state: 'working', displayed_state: 'idle_screen' }
    expect(() => assertListStates([{ state: 'working' }], expected)).toThrow('wrong returned list displayed_state')
    expect(() => assertListStates([{ state: 'working', displayed_state: 'working' }], expected)).toThrow('wrong returned list displayed_state')
    expect(() => assertListStates([], null)).not.toThrow()
    expect(() => assertListStates([{ state: 'idle_screen' }], null)).toThrow('unexpected list membership/count')
  })
})

// Execute only the log assertions, closing/EXIT enforcement and output scan.
// No scenario setup is sourced; process discovery and teardown are inert.
describe('displayed-state closing diagnostics', () => {
  const scenario = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
  const displayed = readFileSync(join(import.meta.dir, 'integration/lib/displayed-states.sh'), 'utf8')
  function helper(name: string, source = scenario): string {
    const match = source.match(new RegExp(`^${name}\\(\\) \\{\n[\\s\\S]*?^\\}`, 'm'))
    if (!match) throw new Error(`missing shell declaration: ${name}`)
    return match[0]
  }
  const declarations = [
    'fail', 'on_exit', 'on_before_cleanup', '_scenario_add', '_scenario_to_us', '_scenario_record_load',
    '_scenario_role_at', '_scenario_split_line', '_scenario_eval_words', '_scenario_decode_words',
    '_scenario_ad_verb', '_scenario_finished_kill_words', '_scenario_shim_diagnostic', '_scenario_read_log', '_scenario_query_prep',
    '_scenario_offending', '_scenario_closing_ran', '_scenario_closing_passed',
    'assert_no_server_tmux', 'assert_no_cscb_include_finished', 'assert_no_cscb_delete',
    '_scenario_closing_check', '_scenario_closing_recheck', '_scenario_cleanup', 'count_token_like',
  ].map(name => helper(name)).join('\n')
  // Use the real registration/configuration block, before any runtime setup.
  const setup = displayed.slice(displayed.indexOf('    on_exit displayed_exit_checks'),
    displayed.indexOf('    local contract='))
  if (!setup.startsWith('    on_exit')) throw new Error('missing displayed exit-check setup')
  const closingList = scenario.match(/^SCENARIO_CLOSING_ASSERTIONS=\(.*\)$/m)![0]
  const cleanupTrap = scenario.match(/^trap _scenario_cleanup EXIT$/m)![0]
  const call = (pid: number, parentPid: number, parent: string, words: string) =>
    `call\t2.000000\t${pid}\t${parentPid}\t${parent}\t${words}\n`
  const cleanAd = call(200, 100, 'bun server.js', 'version')
  const cleanTmux = call(300, 200, 'agent-director', 'list-sessions')
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cscb-displayed-closing-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  type Phase = 'entrypoint' | 'cleanup'
  type Damage = 'malformed-ad' | 'malformed-tmux' | 'delete' | 'include-finished' | 'server-tmux'
  function run(entrypoint: string, { phase = 'entrypoint', damage, unsafe = true, originalStatus = 0,
    captureOnly = false, subshell = false, capture = true }: {
    phase?: Phase; damage?: Damage; unsafe?: boolean; originalStatus?: number
    captureOnly?: boolean; subshell?: boolean; capture?: boolean
  } = {}) {
    const root = join(home, 'scenario')
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(home, 'state'))
    writeFileSync(join(root, 'ad.log'), cleanAd)
    writeFileSync(join(root, 'tmux.log'), cleanTmux)
    writeFileSync(join(root, 'process.log'), 'proc\tserver\t100\t1\t1.000000\n')
    writeFileSync(join(root, 'displayed-driver.out'), 'DRIVER_EVIDENCE\n')
    const payload = unsafe ? fakeToken(BOT_TOKEN_PREFIX, 'closing') : 'safe-diagnostic-marker'
    const tmux = damage === 'malformed-tmux' || damage === 'server-tmux'
    const line = damage?.startsWith('malformed') ? `malformed ${payload}\n`
      : call(400, 100, 'bun server.js', `${damage === 'include-finished' ? 'kill --include-finished'
        : damage === 'server-tmux' ? 'list-sessions' : 'delete'} ${payload}`)
    writeFileSync(join(home, 'injected.txt'), line)
    const entry = readFileSync(join(import.meta.dir, 'integration', entrypoint), 'utf8')
    const invocation = entry.match(/^run_displayed_states (current|legacy)\n/m)![0]
    const closing = entry.slice(entry.indexOf(invocation) + invocation.length)
    const injection = `cat "$HOME/injected.txt" >> "${captureOnly ? '$SCENARIO_ROOT/displayed-closing.err'
      : tmux ? '$SCENARIO_TMUX_SHIM_LOG' : '$SCENARIO_AD_SHIM_LOG'}"`
    const child = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', `set -euo pipefail
exec 2>&1
${declarations}
${helper('displayed_exit_checks', displayed)}
TEST_NAME=closing-fixture
SCENARIO_ROOT="$HOME/scenario"
SCENARIO_BIN="$SCENARIO_ROOT/bin"
SCENARIO_AD_SHIM_LOG="$SCENARIO_ROOT/ad.log"
SCENARIO_TMUX_SHIM_LOG="$SCENARIO_ROOT/tmux.log"
SCENARIO_CSCB_RECORD="$SCENARIO_ROOT/process.log"
_SCENARIO_REAL_AD_SHIM_LOG="$SCENARIO_AD_SHIM_LOG"
_SCENARIO_REAL_TMUX_SHIM_LOG="$SCENARIO_TMUX_SHIM_LOG"
_SCENARIO_REAL_CSCB_RECORD="$SCENARIO_CSCB_RECORD"
SCENARIO_SHELL_CMDLINE='bash fixture.sh'
SCENARIO_FMK=1
_SCENARIO_CLOSED=()
_SCENARIO_EXIT_HOOKS=()
_SCENARIO_BEFORE_CLEANUP_HOOKS=()
_SCENARIO_FAILURE_HOOKS=()
_SCENARIO_STATE_DIRS=()
_SCENARIO_SERVER_PIDS=()
_SCENARIO_TRACKED_PIDS=()
_scenario_cscb_after() { :; }
_scenario_tmux_shim_reset() { :; }
_scenario_stop_recorded_servers() { :; }
_scenario_stop_tmux() { echo PROCESS_CLEANUP; }
${closingList}
${setup}
${capture ? '' : 'unset SCENARIO_SHIM_DIAGNOSTICS'}
${cleanupTrap}
inject_diagnostic() { ${injection}; }
${damage || captureOnly ? phase === 'entrypoint' ? 'inject_diagnostic' : 'on_before_cleanup inject_diagnostic' : ''}
${subshell ? `( ${closing} )` : closing}
printf 'CLOSED=%s\\n' "\${_SCENARIO_CLOSED[*]}"
exit ${originalStatus}
`], {
      encoding: 'utf8', timeout: 4000,
      env: hostSafeChildEnv(home, { tools: ['cat', 'find', 'grep', 'sed', 'wc', 'rm'],
        extras: { SLACK_STATE_DIR: join(home, 'state') } }),
    })
    // Check safely before any assertion can echo the captured text on failure.
    assertNoLeak({ stdout: child.stdout, stderr: child.stderr, error: child.error })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.stdout).toContain('PROCESS_CLEANUP')
    expect(existsSync(root)).toBe(false)
    return { status: child.status, output: child.stdout }
  }

  for (const entrypoint of ['test-42-fmk-displayed-current.sh', 'test-43-fmk-displayed-legacy.sh']) {
    describe(entrypoint, () => {
      test.each((['entrypoint', 'cleanup'] as const).flatMap(phase =>
        (['malformed-ad', 'malformed-tmux', 'delete', 'include-finished', 'server-tmux'] as const)
          .map(damage => [phase, damage] as const)))('%s contains %s shim diagnostics', (phase, damage) => {
        const result = run(entrypoint, { phase, damage })
        expect(result.status).toBe(1)
        const assertion = damage === 'delete' ? 'assert_no_cscb_delete'
          : damage === 'include-finished' ? 'assert_no_cscb_include_finished' : 'assert_no_server_tmux'
        expect(result.output).toContain(`${assertion}:`)
        if (phase === 'cleanup') expect(result.output).toContain('after the closing assertions:')
        expect(result.output).toContain('token-like match(es)')
        expect(result.output).not.toContain('DRIVER_EVIDENCE')
        expect(result.output).not.toContain('leak-check passed')
      })
      test.each(['entrypoint', 'cleanup'] as const)('%s releases safe offending records only after scanning', phase => {
        const result = run(entrypoint, { phase, damage: 'delete', unsafe: false })
        expect(result.status).toBe(1)
        const scan = result.output.indexOf('leak-check passed')
        expect(scan).toBeGreaterThan(-1)
        expect(result.output.indexOf('safe-diagnostic-marker')).toBeGreaterThan(scan)
        expect(result.output.indexOf('DRIVER_EVIDENCE')).toBeGreaterThan(scan)
      })
      test.each([0, 37])('clean assertions preserve original exit %i and same-shell bookkeeping', status => {
        const result = run(entrypoint, { originalStatus: status })
        expect(result.status).toBe(status)
        expect(result.output).toContain('CLOSED=assert_no_server_tmux assert_no_cscb_include_finished assert_no_cscb_delete')
        expect(result.output).toContain(`leak-check passed (scenario exit ${status})`)
        expect(result.output).toContain('DRIVER_EVIDENCE')
      })
      test('the captured diagnostics themselves are scanned, preserving an existing failure status', () => {
        const result = run(entrypoint, { phase: 'cleanup', originalStatus: 37, captureOnly: true })
        expect(result.status).toBe(37)
        expect(result.output).toContain('token-like match(es)')
        expect(result.output).not.toContain('DRIVER_EVIDENCE')
      })
      test('subshell closing assertions still cannot satisfy the same-shell requirement', () => {
        const result = run(entrypoint, { subshell: true })
        expect(result.status).toBe(1)
        expect(result.output).toContain('not passed in its own shell')
      })
    })
  }
  test.each(['malformed-ad', 'delete'] as const)('without capture, %s retains ordinary stderr diagnostics', damage => {
    const result = run('test-42-fmk-displayed-current.sh', { damage, unsafe: false, capture: false })
    expect(result.status).toBe(1)
    const diagnostic = result.output.indexOf('safe-diagnostic-marker')
    expect(diagnostic).toBeGreaterThan(-1)
    expect(diagnostic).toBeLessThan(result.output.indexOf('leak-check passed'))
  })
})
