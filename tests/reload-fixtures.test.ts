/** Execute the integration printer bodies with real package modules and scratch files. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { spawnSync } from 'node:child_process'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import ts from 'typescript'
import * as config from '../src/config.ts'
import * as shared from '../src/shared-channels.ts'
import * as requests from '../src/reload-request.ts'
import * as reviews from '../src/reload-review.ts'
import * as fingerprints from '../src/reload-fingerprint.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun } from './test-helpers/reload-harness.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { MIN_CLAUDE_CODE_VERSION } from './test-helpers/agent-director-versions.ts'

const source = readFileSync(join(import.meta.dir, 'integration/fixtures/fmk-texts.ts'), 'utf8')
const declarations = source.slice(source.indexOf('async function readSharedConfiguration('), source.indexOf('const sharedAuthorityStartLine: Entry'))
const modules: Record<string, Record<string, unknown>> = {
  'config.ts': config, 'shared-channels.ts': shared, 'reload-request.ts': requests,
  'reload-review.ts': reviews, 'reload-fingerprint.ts': fingerprints,
}
const names = ['operatorReviewRequest', 'operatorReviewPending', 'sharedReviewConsumed', 'sharedApplicationPreserved', 'sharedAuthorityPreserved', 'stoppedDowngradeBaseline']
const entries = new Function('packageFunction', 'expectArguments', 'usageFail', 'PrinterFailure', 'PRINTER_FAIL_EXIT', 'isDeepStrictEqual', 'dirname', 'Buffer',
  ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + `\nreturn {${names.join(',')}};`)(
  async (_: unknown, file: string, name: string) => {
    const fn = modules[file]?.[name]; expect(fn).toBeTypeOf('function'); return fn
  },
  (_: string, args: unknown[], wanted: string[]) => { if (args.length !== wanted.length) throw new Error('invalid arguments') },
  () => { throw new Error('invalid arguments') }, Error, 1, isDeepStrictEqual, dirname, Buffer,
) as Record<string, { print(args: string[], context: object): Promise<string> }>
let h: ReloadHarness, run: ReloadRun
beforeEach(async () => {
  h = makeReloadHarness()
  const alpha = h.persona('alpha'); h.materialize(alpha)
  h.writeConfig({ resume_enabled: false, personas: [alpha] })
  run = await h.startDetecting({ dryRun: true }); await tick()
})
afterEach(async () => { try { expect(run.slackPosts()).toEqual([]); assertNoLeak(run.captured()) } finally { await run.stop(); await h.cleanup() } })
async function tick() { await run.ticks.tick(); expect(run.slackPosts()).toEqual([]); assertNoLeak(run.captured()) }
function print(name: string, ...args: string[]) { return entries[name]!.print(args, {}) }

test.each([...config.DELIVERY_MODES])('integration request printer builds valid production %s intent and requires its exact current review', async delivery => {
  const state = run.controller.sharedChannels()!, persona = state.config().personas[0]!, channel = persona.channels[0]!.id
  const text = await print('operatorReviewRequest', h.paths.config, h.paths.lastApplied, 'fixture', 'request', `alpha/${channel}/${delivery}`)
  const request = requests.parseReviewRequestBytes(Buffer.from(text))
  expect(request).toEqual(requests.buildReviewRequest('fixture', 0, 'request', [requests.buildOperatorAssignment(persona, state.incarnation('alpha')!, channel, delivery)]))
  h.writeRequestBytes(text); await tick()
  expect(await print('operatorReviewPending', h.paths.config, h.paths.lastApplied, h.paths.pending, 'fixture')).toBe('')
  await expect(print('operatorReviewPending', h.paths.config, h.paths.lastApplied, h.paths.pending, 'unknown')).rejects.toThrow()
  run.request('refresh', [], 'new-review'); await tick()
  await expect(print('operatorReviewPending', h.paths.config, h.paths.lastApplied, h.paths.pending, 'fixture')).rejects.toThrow()
  expect(await print('operatorReviewPending', h.paths.config, h.paths.lastApplied, h.paths.pending, 'new-review')).toBe('')
  const before = join(h.root, 'before-authority'); writeFileSync(before, h.readRecord()!)
  run.request('cancel'); await tick()
  await expect(print('operatorReviewPending', h.paths.config, h.paths.lastApplied, h.paths.pending, 'fixture')).rejects.toThrow()
  expect(await print('sharedApplicationPreserved', h.paths.config, before, h.paths.lastApplied)).toBe('')
  await expect(print('sharedAuthorityPreserved', h.paths.config, before, h.paths.lastApplied)).rejects.toThrow()
  state.assign('alpha', state.incarnation('alpha')!, channel, 'mentions', state.revision)
  await expect(print('sharedApplicationPreserved', h.paths.config, before, h.paths.lastApplied)).rejects.toThrow()
})

test('test10 consumed-review oracle rejects missing, merely previewed, attempted and superseded outcomes while accepting exactly the applied gesture', async () => {
  run.request('request'); await tick()
  const review = join(h.root, 'rotation.review'); writeFileSync(review, h.readPending()!)
  const fp = h.pendingFingerprint()!, current = h.readRecord()!
  await expect(print('sharedReviewConsumed', h.paths.config, h.paths.lastApplied, review)).rejects.toThrow()
  assertNoLeak(run.captured()); h.confirm(); await tick()
  expect(await print('sharedReviewConsumed', h.paths.config, h.paths.lastApplied, review)).toBe('')
  const consumed = h.readRecord()!
  for (const status of ['attempted', 'superseded', 'rejected'] as const) {
    const state = shared.parseSharedChannelState(consumed, h.paths.lastApplied)!
    reviews.reviewLedger(state)!.outcomes[fp]!.status = status
    writeFileSync(h.paths.lastApplied, shared.serializeSharedChannelState(state))
    await expect(print('sharedReviewConsumed', h.paths.config, h.paths.lastApplied, review)).rejects.toThrow()
  }
  writeFileSync(h.paths.lastApplied, current)
  await expect(print('sharedReviewConsumed', h.paths.config, h.paths.lastApplied, review)).rejects.toThrow()
  writeFileSync(h.paths.lastApplied, consumed)
  writeFileSync(review, fingerprints.composePendingFile('0'.repeat(64), 'foreign review'))
  await expect(print('sharedReviewConsumed', h.paths.config, h.paths.lastApplied, review)).rejects.toThrow()
})

test.each([
  { present: true, oldPresent: true }, { present: true, oldPresent: false },
  { present: false, oldPresent: true }, { present: false, oldPresent: false },
])('test40 stopped transition restores original operator files present=$present and archives old-run files present=$oldPresent', async ({ present, oldPresent }) => {
  const script = readFileSync(join(import.meta.dir, 'integration/test-40-fmk-real-downgrade.sh'), 'utf8')
  const functions = script.slice(script.indexOf('prepare_stopped_downgrade()'), script.indexOf(`real_prepare ${MIN_CLAUDE_CODE_VERSION}`))
  const baseline = await print('stoppedDowngradeBaseline', h.paths.config, h.paths.lastApplied)
  expect(config.parsePersonaConfigBytes(Buffer.from(baseline), h.paths.config, dirname(h.paths.config)).resume_enabled).toBe(false)
  const baselinePath = join(h.root, 'baseline.json'); writeFileSync(baselinePath, baseline)
  const authority = h.readRecord()!, input = h.readConfig()!
  const operatorFiles = ['config.json.request', 'config.json.pending', 'config.json.apply']
  const request = await print('operatorReviewRequest', h.paths.config, h.paths.lastApplied, 'stopped-request', 'request')
  const pending = fingerprints.composePendingFile('1'.repeat(64), 'exact pending review 😀\n')
  const apply = fingerprints.composePendingFile('2'.repeat(64), 'exact confirmation review 😀\n')
  if (present) {
    h.writeRequestBytes(request); h.writePendingBytes(pending); h.writeApplyBytes(apply)
  }
  const originals = new Map<string, Buffer | undefined>([
    ['config.json', input], ['config.json.last-applied', authority],
    ...operatorFiles.map((name, i) => [name, present ? Buffer.from([request, pending, apply][i]!) : undefined] as const),
  ])
  // The shell fixture is exercised without installing or running an old/native
  // release. The old-loader call is a controlled boundary with a refusal case.
  for (const mode of ['live', 'queued', 'old-loader-refuses', 'success']) {
    const scenario = join(h.root, mode); mkdirSync(scenario)
    const queue = join(dirname(h.paths.config), 'queue'); mkdirSync(queue, { recursive: true })
    if (mode === 'queued') writeFileSync(join(queue, 'alpha.jsonl'), 'accepted item\n')
    const result = spawnSync('bash', ['-eu', '-c', `
SLACK_STATE_DIR=$1 SCENARIO_ROOT=$2 SCENARIO_FIXTURES=$2 INSTALL=$2 REAL_KEY=alpha
fail() { echo "$*" >&2; exit 1; }
server_pid() { if [[ "$mode" == live ]]; then echo 42; fi; }
bun() { if [[ $1 == -e ]]; then [[ "$mode" != old-loader-refuses ]]; else cat "$baseline"; fi; }
configuration_applied_is() { cmp -s "$SLACK_STATE_DIR/config.json.last-applied" "$expected"; }
${functions}
prepare_stopped_downgrade
cmp -s "$SLACK_STATE_DIR/config.json" "$baseline"
cmp -s "$SLACK_STATE_DIR/config.json.last-applied" "$baseline"
for name in config.json.request config.json.pending config.json.apply; do
  [[ ! -e "$SLACK_STATE_DIR/$name" ]]
  if [[ "$present" == true ]]; then
    cmp -s "$DOWNGRADE_SNAPSHOT/$name" "$DOWNGRADE_SNAPSHOT/$name.withheld"
  else
    [[ ! -e "$DOWNGRADE_SNAPSHOT/$name" && ! -e "$DOWNGRADE_SNAPSHOT/$name.withheld" ]]
  fi
done
for name in config.json config.json.last-applied; do printf 'old-run %s\n' "$name" > "$SLACK_STATE_DIR/$name"; done
if [[ "$oldPresent" == true ]]; then
  for name in config.json.request config.json.pending config.json.apply; do printf 'old-run %s\n' "$name" > "$SLACK_STATE_DIR/$name"; done
fi
restore_stopped_downgrade
`, 'fixture', dirname(h.paths.config), scenario, baselinePath, mode], {
      encoding: 'utf8', env: hostSafeChildEnv(h.root, { tools: ['bash', 'cat', 'mkdir', 'cp', 'cmp', 'mv'], extras: { mode, present: String(present), oldPresent: String(oldPresent), baseline: baselinePath, expected: join(scenario, 'current-format-before-downgrade/config.json.last-applied') } }),
    })
    rmSync(join(queue, 'alpha.jsonl'), { force: true })
    expect(result.status).toBe(mode !== 'success' ? 1 : 0)
    expect(h.readRecord()).toEqual(authority); expect(h.readConfig()).toEqual(input)
    const snapshot = join(scenario, 'current-format-before-downgrade')
    for (const [name, bytes] of originals) {
      const read = (path: string): Buffer | undefined => existsSync(path) ? readFileSync(path) : undefined
      expect(read(join(dirname(h.paths.config), name))).toEqual(bytes)
      if (mode === 'old-loader-refuses' || mode === 'success') expect(read(join(snapshot, name))).toEqual(bytes)
      expect(read(join(snapshot, `${name}.withheld`))).toEqual(mode === 'success' && operatorFiles.includes(name) ? bytes : undefined)
      expect(read(join(snapshot, 'old-run', name))).toEqual(mode === 'success' && (!operatorFiles.includes(name) || oldPresent)
        ? Buffer.from(`old-run ${name}\n`) : undefined)
    }
    assertNoLeak(result)
  }
  const stop = script.indexOf('stop_server --stop-bots', script.indexOf('real_prepare'))
  const install = script.indexOf('(cd "${INSTALL}"', stop)
  const prepare = script.indexOf('\nprepare_stopped_downgrade\n', install)
  const start = script.indexOf('\nstart_server --live', prepare)
  expect(stop).toBeLessThan(install); expect(install).toBeLessThan(prepare); expect(prepare).toBeLessThan(start)
})

test('test40 baseline refuses resume=true and unconsumed operator intent instead of discarding it', async () => {
  run.request('request'); await tick()
  await expect(print('stoppedDowngradeBaseline', h.paths.config, h.paths.lastApplied)).rejects.toThrow()
  run.request('cancel'); await tick()
  const input = JSON.parse(h.readConfig()!.toString()); input.resume_enabled = true; h.writeConfig(input)
  await tick(); h.confirm(); await tick()
  await expect(print('stoppedDowngradeBaseline', h.paths.config, h.paths.lastApplied)).rejects.toThrow()
})

test('test9 unchanged-persona isolation counts every runtime line, excluding only review lines', () => {
  const script = readFileSync(join(import.meta.dir, 'integration/test-9-reload-destructive-and-server-wide.sh'), 'utf8')
  const start = script.indexOf('persona_runtime_count() {'), end = script.indexOf('\n}', start) + 2
  expect(start).toBeGreaterThan(0)
  writeFileSync(join(dirname(h.paths.config), 'server.log'), [
    '[slack] reload-preview: persona "alpha" (key=alpha): copied',
    '[slack] persona-start: personas[0] "alpha" (key=alpha): bring-up starting',
    '[slack] Session connected: persona "alpha" (key=alpha)',
    '[slack] persona teardown of "alpha" (key=alpha): starting',
    '[slack] persona "beta" (key=beta): updated in place',
    '[slack] reload-preview: persona "beta" (key=beta): unchanged',
    '[slack] persona "alphabet" (key=alphabet): updated in place',
  ].join('\n'))
  const result = spawnSync('bash', ['-eu', '-c', `SLACK_STATE_DIR=$1\n${script.slice(start, end)}\npersona_runtime_count alpha\npersona_runtime_count beta`, 'fixture', dirname(h.paths.config)], {
    encoding: 'utf8', env: hostSafeChildEnv(h.root, { tools: ['bash', 'awk'] }),
  })
  expect(result.status).toBe(0); expect(result.stdout).toBe('3\n1\n'); assertNoLeak(result)
})

test.each([
  'shared', 'fmk',
  'missing-image', 'missing-root', 'unset-state', 'outside-state', 'root-as-state', 'traversal-state', 'symlink-state',
  ...['config.json', 'config.json.last-applied', 'config.json.pending', 'config.json.request', 'config.json.request.tmp'].map(name => `symlink-${name}`),
  'dangling-temp', 'directory-temp',
])('configuration_request scratch containment: %s', async mode => {
  const script = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
  const extract = (name: string) => {
    const start = script.indexOf(`\n${name}() {`), end = script.indexOf('\n}', start) + 2
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    return script.slice(start, end)
  }
  const scenario = join(h.root, 'scenario'), inside = join(scenario, 'state'), outside = join(h.root, 'outside')
  mkdirSync(inside, { recursive: true }); mkdirSync(outside)
  const home = mode === 'fmk' ? join(scenario, 'home') : h.root
  if (mode === 'fmk') mkdirSync(home)
  const marker = join(scenario, 'image-marker'), target = join(outside, 'protected')
  writeFileSync(target, 'outside state must not change\n')
  if (mode !== 'missing-image') writeFileSync(marker, '')
  let root = scenario, state = inside
  if (mode === 'missing-root') root = join(h.root, 'missing')
  if (mode === 'unset-state') state = ''
  if (mode === 'outside-state') state = outside
  if (mode === 'root-as-state') state = scenario
  if (mode === 'traversal-state') state = `${scenario}/../outside`
  if (mode === 'symlink-state') { state = join(scenario, 'linked-state'); symlinkSync(outside, state) }
  if (mode.startsWith('symlink-config')) symlinkSync(target, join(inside, mode.slice('symlink-'.length)))
  if (mode === 'dangling-temp') symlinkSync(join(outside, 'absent'), join(inside, 'config.json.request.tmp'))
  if (mode === 'directory-temp') mkdirSync(join(inside, 'config.json.request.tmp'))
  const requestBytes = join(scenario, 'expected-request')
  const bytes = await print('operatorReviewRequest', h.paths.config, h.paths.lastApplied, 'shared-request', 'request')
  writeFileSync(requestBytes, bytes)
  // Execute the real guards/publisher, with only the image marker relocated
  // into scratch and Bun/wait replaced at their process boundaries. No image,
  // install, daemon or scenario setup runs on the host.
  const functions = ['require_ci_image', 'require_scenario_state', 'configuration_request'].map(extract).join('\n')
    .replaceAll('/etc/cscb-ci-image', '"$fixture_marker"')
  const result = spawnSync('bash', ['-eu', '-c', `
SCENARIO_ROOT=$1 SLACK_STATE_DIR=$2 SCENARIO_FIXTURES=$3
fail() { echo "$*" >&2; exit 1; }
bun() {
  [[ "$3" == "$SLACK_STATE_DIR/config.json" && "$4" == "$SLACK_STATE_DIR/config.json.last-applied" ]] || return 90
  case "$2" in
    operatorReviewRequest)
      [[ "$5" == shared-request && "$6" == request ]] || return 91
      printf called > "$SCENARIO_ROOT/printer-called"
      cat "$request_bytes" ;;
    operatorReviewPending)
      [[ "$5" == "$SLACK_STATE_DIR/config.json.pending" && "$6" == shared-request ]] || return 92
      [[ ! -e "$SLACK_STATE_DIR/config.json.request.tmp" ]] || return 93
      cmp -s "$request_bytes" "$SLACK_STATE_DIR/config.json.request" || return 94
      printf checked > "$SCENARIO_ROOT/review-checked" ;;
    *) exit 99 ;;
  esac
}
wait_until() { [[ "$1" == 30 ]]; shift 2; "$@"; }
${functions}
configuration_request shared-request request
`, 'fixture', root, state, scenario], {
    encoding: 'utf8', env: hostSafeChildEnv(home, { tools: ['bash', 'realpath', 'cat', 'mv', 'cmp'], extras: { fixture_marker: marker, request_bytes: requestBytes } }),
  })
  const allowed = mode === 'shared' || mode === 'fmk'
  expect(result.status).toBe(allowed ? 0 : 1)
  expect(existsSync(join(scenario, 'printer-called'))).toBe(allowed)
  expect(existsSync(join(scenario, 'review-checked'))).toBe(allowed)
  if (allowed) expect(readFileSync(join(inside, 'config.json.request'), 'utf8')).toBe(bytes)
  else expect(result.stderr).toContain('refused:')
  expect(readFileSync(target, 'utf8')).toBe('outside state must not change\n')
  expect(existsSync(join(outside, 'absent'))).toBe(false)
  expect(existsSync(join(outside, 'config.json.request'))).toBe(false)
  assertNoLeak(result)
})
