/** Heavy coordinator contracts, driven with fake fetch, streams and children.
 * No Docker, agent, agent-director, tmux or model call runs on the host.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  AI_CRITERIA, GATE_SLUGS, HEAVY_SCRIPTS, MATRIX_CPUS, MATRIX_MEMORY, MATRIX_TIMEOUT_MS,
  MATRIX_VERSIONS, SCHEDULER_JOB_CONTRACT, assertJobComplete, discoverGateScripts,
  matrixDockerArgs, matrixOptions, matrixPlan, selectedClaudePlan, safeModel, parseResultLine, runMatrix,
  CODEX_AI_CRITERIA, localCodexExtension, assertCodexJobComplete, codexMatrixDockerArgs,
  type MatrixJob, type MatrixResult,
} from '../scripts/real-agent-matrix.ts'
import { CPUS_PER_SHARD, SHARD_MEMORY_CAP_BYTES, SHARD_PIDS_LIMIT } from '../scripts/ci-run.ts'
import * as ciRunner from '../scripts/ci-run.ts'
import { assertNoLeak, fakeToken, writtenFile } from './test-helpers/credentials.ts'
import { makeFakeCodexHome, probeFlock } from './test-helpers/ci-run.ts'
import { CODEX_VERSION, CODEX_LOGIN_TARGET, CODEX_EXTRA_MEMORY_BYTES, codexLoginContainerListArgs } from '../scripts/codex-login.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { LIVE_CLAUDE_CODE_VERSION, MIN_CLAUDE_CODE_VERSION } from './test-helpers/agent-director-versions.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { decodeCodexHostConfigKeys } from '../src/codex-config-keys.ts'
import { AI_FAILURE_PREFIX } from './real-agent/ai-failure-diagnostics.ts'

const gateNames = () => GATE_SLUGS.map((slug, i) => `test-${32 + i}-fmk-real-${slug}.sh`)
const heavyNames = () => [...HEAVY_SCRIPTS, ...AI_CRITERIA.map(ac => `test-${100 + ac}-fmk-real-ai-ac${ac}.sh`)]
const codexNames = () => CODEX_AI_CRITERIA.map(ac => `test-${100 + ac}-fmk-real-codex-ai-ac${ac}.sh`)
const codexExtension = () => localCodexExtension(codexNames())
const codexModel = 'test/model:1'
function codexResults(): MatrixResult[] {
  return codexExtension().invocations.map(i => ({ script: i.script, trial: i.trial, version: CODEX_VERSION, model: codexModel, agent: 'codex', completed: true, exit: 0, reported: true, duplicates: 0, tokens: { input: 7, output: 3, cache_read: 5, cache_creation: 1 } }))
}
const gates = () => discoverGateScripts(gateNames())
const plan = (latest = '2.1.999') => matrixPlan(latest, gates(), heavyNames())
const model = 'claude-opus-5-5'
const opus = model

function resultsFor(job: MatrixJob, defaultModel = model, aiModel = defaultModel): MatrixResult[] {
  return job.invocations.map(i => ({ script: i.script, trial: i.trial, version: job.version,
    model: i.model === 'opus' ? aiModel : defaultModel, exit: 0, reported: true, duplicates: 2,
    tokens: { input: 7, output: 3, cache_read: 5, cache_creation: 1 } }))
}
const resultLine = (result: unknown) => `real-agent-result: ${JSON.stringify(result)}`
function jobForArgv(argv: string[]): MatrixJob {
  const imageAt = argv.findIndex(a => a.startsWith('cscb-real-agent:'))
  const version = argv[imageAt + 1]!
  return plan(version)[Number(argv[imageAt + 2]) === 1 ? 2 : MATRIX_VERSIONS.indexOf(version as typeof MATRIX_VERSIONS[number])]!
}

describe('heavy planning and result validation', () => {
  test('explicit Claude versions require all twenty scenarios at three trials per version', () => {
    const jobs = selectedClaudePlan(['2.1.304', MIN_CLAUDE_CODE_VERSION], gates(), heavyNames())
    expect(jobs.map(j => j.version)).toEqual(['2.1.304', MIN_CLAUDE_CODE_VERSION])
    for (const job of jobs) {
      expect(job.runtimeLatest).toBe(false)
      expect(job.invocations).toHaveLength(60)
      for (const script of [...gates(), ...heavyNames().map(n => `real-agent/${n}`)]) {
        expect(job.invocations.filter(i => i.script === script).map(i => i.trial)).toEqual([1, 2, 3])
      }
      const results = resultsFor(job)
      expect(() => assertJobComplete(job, results, model, model)).not.toThrow()
      expect(() => assertJobComplete(job, results.slice(1), model, model)).toThrow()
    }
  })

  test('pins the two native versions, resolves a separate runtime-latest job, and requires all gate and heavy cases', () => {
    expect(MATRIX_VERSIONS).toEqual([MIN_CLAUDE_CODE_VERSION, LIVE_CLAUDE_CODE_VERSION])
    expect(AI_CRITERIA).toEqual([11, 12, 15, 20, 23, 91, 106])
    const jobs = plan(MATRIX_VERSIONS[1])
    expect(jobs.map(j => [j.version, j.runtimeLatest])).toEqual([
      [MATRIX_VERSIONS[0], false], [MATRIX_VERSIONS[1], false], [MATRIX_VERSIONS[1], true],
    ])
    for (const job of jobs) {
      const requiredHeavy = [HEAVY_SCRIPTS[0], HEAVY_SCRIPTS[1], HEAVY_SCRIPTS[3],
        ...(!job.runtimeLatest && job.version === MATRIX_VERSIONS[1] ? [HEAVY_SCRIPTS[2]] : [])]
      expect(job.invocations.filter(i => i.model === 'default')).toEqual([
        ...gates().map(script => ({ script, trial: 1, model: 'default' as const })),
        ...requiredHeavy.map(name => ({ script: `real-agent/${name}`, trial: 1, model: 'default' as const })),
      ])
    }
    jobs[0]!.invocations[0]!.trial = 3
    expect(jobs[1]!.invocations[0]!.trial).toBe(1)
  })

  test('runs each AI criterion exactly three times using the AI selector across the matrix', () => {
    const invocations = plan().flatMap(job => job.invocations)
    for (const ac of AI_CRITERIA) expect(invocations.filter(i => i.script.endsWith(`-ai-ac${ac}.sh`)))
      .toEqual([1, 2, 3].map(trial => ({ script: `real-agent/test-${100 + ac}-fmk-real-ai-ac${ac}.sh`, trial, model: 'opus' as const })))
  })

  test('native idle runs once per version job and a missing or failed case blocks that job; latency100 runs once overall', () => {
    const jobs = plan(MATRIX_VERSIONS[1])
    for (const job of jobs) {
      const results = resultsFor(job), idle = 'real-agent/test-104-fmk-real-idle-compact.sh'
      expect(job.invocations.filter(i => i.script === idle)).toEqual([{ script: idle, trial: 1, model: 'default' }])
      expect(() => assertJobComplete(job, results.filter(r => r.script !== idle), model, opus)).toThrow()
      expect(() => assertJobComplete(job, results.map(r => r.script === idle ? { ...r, exit: 1 } : r), model, opus)).toThrow()
    }
    expect(jobs.flatMap(j => j.invocations).filter(i => i.script.endsWith('-latency100.sh'))).toHaveLength(1)
  })

  test.each(['latest', '2.1', '2.1.296-beta', '2.1.296\nextra'])('rejects non-exact runtime latest %j', version => {
    expect(() => plan(version)).toThrow('exact version')
  })

  test.each(heavyNames())('refuses to plan when required heavy script %s is missing', name => {
    expect(() => matrixPlan('2.1.999', gates(), heavyNames().filter(n => n !== name))).toThrow(name)
  })

  test('discovers exactly nine Claude gates in stable order, independently of directory order and Codex', () => {
    expect(discoverGateScripts([...gateNames().reverse(), 'test-41-fmk-real-codex.sh', 'helper.sh']))
      .toEqual(gateNames().map(n => `integration/${n}`))
    expect(() => discoverGateScripts(gateNames().slice(1))).toThrow('exactly nine')
    expect(() => discoverGateScripts([...gateNames(), 'test-99-fmk-real-other.sh'])).toThrow('exactly nine')
    expect(() => discoverGateScripts([...gateNames().slice(1), 'test-99-fmk-real-keys.sh'])).toThrow('for order')
  })

  test.each([
    ['missing trial', (r: MatrixResult[]) => r.slice(0, -1)],
    ['duplicate trial', (r: MatrixResult[]) => r.map((v, i) => i === r.length - 1 ? r[i - 1]! : v)],
    ['reordered results', (r: MatrixResult[]) => [...r].reverse()],
    ['wrong version', (r: MatrixResult[]) => r.map((v, i) => i === 0 ? { ...v, version: '2.1.998' } : v)],
    ['model substitution', (r: MatrixResult[]) => r.map(v => ({ ...v, model: 'claude-opus-4-8' }))],
    ['failed AI trial', (r: MatrixResult[]) => r.map((v, i) => i === r.length - 1 ? { ...v, exit: 1 } : v)],
    ['missing scenario report', (r: MatrixResult[]) => r.map((v, i) => i === 0 ? { ...v, reported: false } : v)],
  ] as const)('blocks PASS on %s', (_name, change) => {
    const job = plan().find(j => j.invocations.some(i => i.model === 'opus'))!, results = resultsFor(job)
    expect(() => assertJobComplete(job, results, model, opus)).not.toThrow()
    expect(() => assertJobComplete(job, change(results), model, opus)).toThrow()
  })

  test.each([
    { duplicates: -1 }, { trial: 4 }, { exit: 0.5 }, { reported: 'true' },
    { tokens: { input: -1, output: 0, cache_read: 0, cache_creation: 0 } },
    { tokens: { input: 0, output: 0, cache_read: 0 } },
    { tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 } },
  ])('rejects malformed result patch %j', patch => {
    expect(() => parseResultLine(resultLine({ ...resultsFor(plan()[0]!)[0], ...patch }))).toThrow()
  })

  test('ignores ordinary output and accepts reported duplicates with all token fields', () => {
    const result = resultsFor(plan()[0]!)[0]!
    expect(parseResultLine('recorded: real-agent-result: ignored')).toBeNull()
    expect(parseResultLine(resultLine(result))).toEqual(result)
    expect(() => parseResultLine('real-agent-result: {')).toThrow()
  })

  test.each(['tokens', 'duplicates', 'both'] as const)('accepts missing %s only for an unreported result and preserves the observed fields', missing => {
    const result = { ...resultsFor(plan()[0]!)[0]!, reported: false,
      ...(missing !== 'duplicates' ? { tokens: null } : {}),
      ...(missing !== 'tokens' ? { duplicates: null } : {}) }
    expect(parseResultLine(resultLine(result))).toEqual(result)
    expect(() => parseResultLine(resultLine({ ...result, reported: true }))).toThrow('Malformed real-agent-result')
    const job = plan()[0]!, results = resultsFor(job)
    results[0] = result
    expect(() => assertJobComplete(job, results, model, opus)).toThrow('did not pass')
  })

  test.each([
    ['azure/openai/gpt-6-astra', true], ['claude-opus-5-5', true], ['org/model:version@pin', true],
    ['', false], ['model with spaces', false], ['model\n', false], ['model\r', false],
    ['-model', false], ['a'.repeat(257), false], ['model$(command)', false],
  ])('safe selected model %j accepted=%s', (value, expected) => expect(safeModel(value)).toBe(expected))

  test('Codex local manifest contains exactly five criteria with three independent trials each', () => {
    expect(CODEX_AI_CRITERIA).toEqual([11, 12, 15, 20, 106])
    expect(codexExtension()).toEqual({ agent: 'codex', localOnly: true, invocations: CODEX_AI_CRITERIA.flatMap(ac => [1, 2, 3].map(trial => ({ script: `real-agent/test-${100 + ac}-fmk-real-codex-ai-ac${ac}.sh`, trial, model: 'default' }))) })
    for (const name of codexNames()) expect(() => localCodexExtension(codexNames().filter(file => file !== name))).toThrow('absent')
    const results = codexResults().map(row => parseResultLine(resultLine(row))!)
    expect(() => assertCodexJobComplete(codexExtension(), results, codexModel)).not.toThrow()
    expect(plan().flatMap(job => job.invocations).some(item => item.script.includes('codex'))).toBe(false)
    expect(SCHEDULER_JOB_CONTRACT.plainEnv).not.toContain('CODEX_TEST_MODEL')
    expect(SCHEDULER_JOB_CONTRACT.plainEnv).not.toContain('CODEX_HOST_CONFIG_KEYS')
    expect(SCHEDULER_JOB_CONTRACT.context.some(item => item.includes('auth.json'))).toBe(false)
  })

  test.each([0, 3, Number.MAX_SAFE_INTEGER])('preserves a Codex message-copy count of %s without failing completed trials', duplicates => {
    const rows = codexResults()
    rows[0]!.duplicates = duplicates
    const parsed = rows.map(row => parseResultLine(resultLine(row))!)
    expect(parsed).toEqual(rows)
    expect(() => assertCodexJobComplete(codexExtension(), parsed, codexModel)).not.toThrow()
  })

  test.each([null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '1'])('rejects an invalid Codex message-copy count %j', duplicates => {
    const rows = codexResults()
    rows[0]!.duplicates = duplicates as number | null
    expect(() => parseResultLine(resultLine(rows[0]))).toThrow('Malformed real-agent-result')
    expect(() => assertCodexJobComplete(codexExtension(), rows, codexModel)).toThrow('did not pass')
  })

  test('local jobs use CI resource caps, bare runtime environment names and a three-hour timeout; future scheduler reserves separately', () => {
    const args = matrixDockerArgs('test-job', 'test-image', plan()[0]!)
    const flag = (name: string) => args[args.indexOf(name) + 1]
    expect(MATRIX_MEMORY).toBe(String(SHARD_MEMORY_CAP_BYTES))
    expect(MATRIX_CPUS).toBe(CPUS_PER_SHARD)
    expect(flag('--memory')).toBe(MATRIX_MEMORY)
    expect(flag('--memory-swap')).toBe(MATRIX_MEMORY)
    expect(flag('--cpus')).toBe(String(MATRIX_CPUS))
    expect(flag('--pids-limit')).toBe(String(SHARD_PIDS_LIMIT))
    expect(flag('--log-driver')).toBe('none')
    // The coordinator checks explicit removal; Docker must leave the stopped container for that step.
    expect(args).not.toContain('--rm')
    expect(MATRIX_TIMEOUT_MS).toBe(3 * 60 * 60 * 1000)
    expect(args.flatMap((a, i) => a === '--env' ? [args[i + 1]] : [])).toEqual([
      'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'REAL_AGENT_AI_MODEL',
    ])
    expect(SCHEDULER_JOB_CONTRACT).toMatchObject({ memory: '8GiB', cpus: 4, timeout: '3h', network: 'on', secret: 'env:CI_ANTHROPIC_API_KEY:ANTHROPIC_API_KEY' })
    assertNoLeak(args)
  })
})

test.each(['installed', 'missing', 'wrong version', 'installer failure'])('Claude entrypoint exact version setup: %s', mode => {
  const root = mkdtempSync(join(tmpdir(), 'claude-job-setup-'))
  try {
    const entrypoint = readFileSync(join(import.meta.dir, '..', 'docker/real-agent-job.sh'), 'utf8')
    const setup = entrypoint.slice(entrypoint.indexOf('[[ "$version" =~'), entrypoint.indexOf('export REAL_AGENT_CLAUDE_VERSION'))
      .replaceAll('/opt/claude-code/$version/claude', '$fake')
    expect(setup.startsWith('[[ "$version" =~')).toBe(true)
    const fake = join(root, 'claude')
    writeFileSync(fake, `#!/bin/bash\nprintf '%s\\n' '${mode === 'wrong version' ? '2.1.999' : '2.1.304'} (Claude Code)'\n`, { mode: mode === 'installed' ? 0o700 : 0o600 })
    const program = `set -euo pipefail
version=2.1.304
latest=0
fake="$1"
mode="$2"
bash() {
  [[ "$1" == /opt/cscb-ci/install-real-agents.sh && "$2" == "$version" ]] || exit 9
  printf 'installer-called\\n'
  [[ "$mode" != 'installer failure' ]] || return 8
  chmod +x "$fake"
}
${setup}`
    const child = spawnSync('bash', ['-c', program, 'job-setup', fake, mode], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'chmod'] }), encoding: 'utf8', timeout: 5000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(mode === 'installer failure' ? 8 : mode === 'wrong version' ? 1 : 0)
    expect(child.stdout.includes('installer-called')).toBe(mode !== 'installed')
    expect(child.stdout.includes('recorded: matrix native Claude 2.1.304')).toBe(['installed', 'missing'].includes(mode))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.each([false, true].flatMap(keepGoing => ['exit', 'missing report'].map(failure => [keepGoing, failure] as const)))('Claude entrypoint keep-going=%s handles %s and preserves failure status', (keepGoing, failure) => {
  const root = mkdtempSync(join(tmpdir(), 'claude-job-loop-'))
  try {
    const entrypoint = readFileSync(join(import.meta.dir, '..', 'docker/real-agent-job.sh'), 'utf8')
    const loop = entrypoint.slice(entrypoint.indexOf('failed=0\n')).replace('log="/tmp/real-agent-script.log"', 'log="$trial_log"')
    expect(loop.startsWith('failed=0\n')).toBe(true)
    // Execute the actual scenario/report loop. Only the scenario launch is
    // stubbed; no install, Docker, agent, model or host state is involved.
    const program = `set -euo pipefail
keep_going="$1"
failure="$2"
visited="$3"
trial_log="$4"
shift 4
version=${MIN_CLAUDE_CODE_VERSION}
default_model=test/model
ai_model=test/ai
gosu() {
  printf '%s\\n' "$script" >> "$visited"
  if [[ "$script" == *test-101-* && "$failure" == 'missing report' ]]; then return 0; fi
  printf 'duplicates: 0\\ntokens: {"input":1,"output":1,"cache_read":0,"cache_creation":0}\\n'
  if [[ "$script" == *test-101-* && "$failure" == exit ]]; then return 7; fi
}
${loop}`
    const scripts = ['test-101-fmk-real-busy.sh', 'test-102-fmk-real-replies.sh', 'test-104-fmk-real-idle-compact.sh'].map(name => `real-agent/${name}`)
    const visited = join(root, 'visited'), log = join(root, 'trial.log')
    const child = spawnSync('bash', ['-c', program, 'job-loop', keepGoing ? '1' : '0', failure, visited, log,
      ...scripts.map(script => `${script}:1:default`)], { env: hostSafeChildEnv(root, { tools: ['bash', 'python3', 'cat', 'rm'] }), encoding: 'utf8', timeout: 10000 })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(1)
    expect(child.stderr).toBe('')
    expect(readFileSync(visited, 'utf8').trim().split('\n')).toEqual(keepGoing ? scripts : scripts.slice(0, 1))
    const results = child.stdout.split('\n').map(line => parseResultLine(line)).filter(Boolean)
    expect(results).toHaveLength(keepGoing ? 3 : 1)
    expect(results[0]).toMatchObject({ exit: failure === 'exit' ? 7 : 0, reported: failure === 'exit' })
    if (keepGoing) expect(results.slice(1).every(row => row!.exit === 0 && row!.reported)).toBe(true)
    expect(existsSync(log)).toBe(false)
    assertNoLeak({ stdout: child.stdout, stderr: child.stderr, results, visited: writtenFile(visited) })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

describe('Codex entrypoint trial reporting', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-trial-report-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  test.each(['valid', 'missing', 'malformed', 'incomplete'] as const)('entrypoint host-key preflight %s validates the real environment payload', kind => {
    // Run only the entrypoint's admission program against its repo module.
    // The surrounding shell/native/container commands are never executed.
    const entrypoint = readFileSync(join(import.meta.dir, '..', 'docker/real-agent-codex-job.sh'), 'utf8')
    const program = entrypoint.match(/^gosu testuser bun -e '(.+)'$/m)?.[1]
    expect(program).toBeDefined()
    const code = program!.replace('/test-repo/node_modules/claude-slack-channel-bots/src/codex-config-keys.ts', join(import.meta.dir, '..', 'src/codex-config-keys.ts'))
    const payload = kind === 'valid' ? JSON.stringify({ version: 1, keys: [['model'], ['tui']] })
      : kind === 'incomplete' ? JSON.stringify({ version: 1, keys: [['model'], ['tui', 'other']] })
      : kind === 'malformed' ? fakeToken('', 'invalid-projection') : undefined
    const child = spawnSync(process.execPath, ['-e', code], {
      env: hostSafeChildEnv(root, { tools: [], extras: payload === undefined ? {} : { CODEX_HOST_CONFIG_KEYS: payload } }),
      encoding: 'utf8', timeout: 5000,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(kind === 'valid' ? 0 : 64)
    expect(child.stdout).toBe('')
    expect(child.stderr).toBe(kind === 'valid' ? '' : 'FAIL: Codex host config key projection is missing or invalid\n')
    assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
  })

  test.each([
    ['0', 0, true], ['4', 4, true], ['-1', -1, false],
    ['1.5', null, false], ['invalid', null, false],
  ] as const)('reports message-copy text %j as count %s with completed=%s', (count, expected, valid) => {
    // Execute only the entrypoint's real report parser, never its container,
    // package-install, agent-director or native-model commands.
    const entrypoint = readFileSync(join(import.meta.dir, '..', 'docker/real-agent-codex-job.sh'), 'utf8')
    const parser = entrypoint.match(/<<'PY'[^\n]*\n([\s\S]*?)\nPY\n/)?.[1]
    expect(parser).toBeDefined()
    const log = join(root, 'trial.log')
    const row = { ...codexResults()[0]!, duplicates: expected, completed: valid, reported: valid }
    writeFileSync(log, [
      `duplicates: ${count}`, `tokens: ${JSON.stringify(row.tokens)}`,
      `recorded: codex-model ${codexModel}`, 'recorded: codex-completed true',
      'recorded: codex-auth-symlink true',
    ].join('\n') + '\n')
    const child = spawnSync('python3', ['-B', '-c', parser!, row.script, String(row.trial), codexModel, '0', log], {
      env: hostSafeChildEnv(root, { tools: ['python3'] }), encoding: 'utf8', timeout: 5000,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.stderr).toBe('')
    expect(child.status).toBe(valid ? 0 : 1)
    const report = JSON.parse(child.stdout.trim().slice('real-agent-result: '.length))
    expect(report).toMatchObject({ agent: 'codex', duplicates: expected, completed: valid, reported: valid })
    if (valid) expect(parseResultLine(child.stdout.trim())).toEqual(row)
    assertNoLeak({ log: writtenFile(log), stdout: child.stdout, stderr: child.stderr })
  })
})

describe('heavy execution with fake children', () => {
  let root: string, repo: string, output: string
  let stdout: string[], stderr: string[], calls: { argv: string[]; key: string | undefined; model: string | undefined; aiModel: string | undefined; codexModel: string | undefined; hostConfigKeys: string | undefined; pid: number; detached: boolean | undefined; tmpdir: string | undefined }[], stage: string | undefined
  let response: (argv: string[]) => { code?: number; text?: string; stderr?: string; hang?: boolean; retainPipes?: boolean; ignoreKill?: boolean }
  let latestResponse: () => Promise<Response>
  let activeJobs: number, maxJobs: number
  const clock = createFakeClock()
  let kills: string[]
  let groupKills: { pid: number; signal: string | number | undefined }[], cancelledPipes: number[]
  const envNames = ['CI_ANTHROPIC_API_KEY', 'CI_ANTHROPIC_MODEL', 'CI_ANTHROPIC_BASE_URL', 'CI_ANTHROPIC_OPUS_MODEL', 'CI_ANTHROPIC_AI_MODEL', 'CODEX_HOME', 'CODEX_TEST_MODEL', 'CODEX_HOST_CONFIG_KEYS'] as const
  let codex: ReturnType<typeof makeFakeCodexHome>
  let oldEnv: Record<string, string | undefined>
  let restore: (() => void)[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'matrix-test-'))
    repo = join(root, 'repo'); output = join(root, 'output')
    for (const dir of ['tests/integration', 'tests/real-agent', 'docker']) mkdirSync(join(repo, dir), { recursive: true })
    for (const name of gateNames()) writeFileSync(join(repo, 'tests/integration', name), '')
    for (const name of [...heavyNames(), ...codexNames()]) writeFileSync(join(repo, 'tests/real-agent', name), '')
    stdout = []; stderr = []; calls = []; kills = []; stage = undefined; activeJobs = 0; maxJobs = 0
    groupKills = []; cancelledPipes = []
    oldEnv = Object.fromEntries(envNames.map(n => [n, process.env[n]]))
    codex = makeFakeCodexHome(root, codexModel)
    process.env.CODEX_HOME = codex.home
    process.env.CODEX_TEST_MODEL = 'inherited-model'
    process.env.CODEX_HOST_CONFIG_KEYS = 'inherited-untrusted-projection'
    process.env.CI_ANTHROPIC_API_KEY = fakeToken('', 'anthropic')
    process.env.CI_ANTHROPIC_MODEL = model
    process.env.CI_ANTHROPIC_BASE_URL = 'https://model.invalid'
    process.env.CI_ANTHROPIC_OPUS_MODEL = opus
    delete process.env.CI_ANTHROPIC_AI_MODEL
    response = () => ({})
    latestResponse = async () => new Response('2.1.999\n')
    restore = []
    const killSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => { groupKills.push({ pid, signal }); return true })
    restore.push(() => killSpy.mockRestore())
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => latestResponse()) as unknown as typeof fetch)
    restore.push(() => fetchSpy.mockRestore())
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((text: string) => { stdout.push(String(text)); return true }) as typeof process.stdout.write)
    restore.push(() => stdoutSpy.mockRestore())
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((text: string) => { stderr.push(String(text)); return true }) as typeof process.stderr.write)
    restore.push(() => stderrSpy.mockRestore())
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, ms: number) => clock.setTimeout(cb, ms)) as unknown as typeof setTimeout)
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(handle => clock.clearTimeout(handle))
    restore.push(() => timerSpy.mockRestore(), () => clearSpy.mockRestore())
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((argv: string[], options: { env?: Record<string, string | undefined>; detached?: boolean }) => {
      const pid = 600_000 + calls.length
      calls.push({ argv: [...argv], key: options.env?.ANTHROPIC_API_KEY, model: options.env?.ANTHROPIC_MODEL, aiModel: options.env?.REAL_AGENT_AI_MODEL, codexModel: options.env?.CODEX_TEST_MODEL, hostConfigKeys: options.env?.CODEX_HOST_CONFIG_KEYS, pid, detached: options.detached, tmpdir: options.env?.TMPDIR })
      stage = options.env?.TMPDIR
      const isJob = argv[0] === 'docker' && argv[1] === 'run' && !argv.includes('id')
      if (isJob) { activeJobs++; maxJobs = Math.max(maxJobs, activeJobs) }
      if (argv[0] === 'bun') {
        const archive = argv[argv.indexOf('--filename') + 1]!
        stage = dirname(archive); writeFileSync(archive, 'fake packed production')
      }
      const answer = response(argv)
      let text = answer.text ?? ''
      if (argv[0] === 'docker' && argv[1] === 'image' && argv[2] === 'inspect' && answer.text === undefined) {
        text = JSON.stringify([{ Id: 'a'.repeat(64), Config: { Env: [`ANTHROPIC_API_KEY=${fakeToken('', 'inspect-default')}`] } }])
      }
      if (argv[0] === 'docker' && argv[1] === 'container' && argv[2] === 'inspect' && answer.text === undefined) {
        text = JSON.stringify([{ Id: 'b'.repeat(64), Image: 'sha256:' + 'a'.repeat(64), Name: '/' + argv[3],
          State: { Running: false, OOMKilled: false, ExitCode: 0 }, Config: { Env: [], Labels: {} },
          HostConfig: { Memory: Number(MATRIX_MEMORY) + CODEX_EXTRA_MEMORY_BYTES },
          Mounts: [{ Type: 'bind', Source: codex.auth, Destination: CODEX_LOGIN_TARGET, RW: true }] }])
      }
      if (argv[0] === 'docker' && argv[1] === 'run' && argv.includes('id') && answer.text === undefined) text = String(process.getuid!()) + '\n'
      if (isJob && argv.includes('/opt/cscb-ci/real-agent-codex-job.sh') && answer.text === undefined) text = codexResults().map(resultLine).join('\n') + '\n'
      else if (isJob && answer.text === undefined) {
        text = resultsFor(jobForArgv(argv), options.env?.ANTHROPIC_MODEL, options.env?.REAL_AGENT_AI_MODEL).map(resultLine).join('\n') + '\n'
      }
      let finish!: (code: number) => void, stream!: ReadableStreamDefaultController<Uint8Array>
      const exited = new Promise<number>(resolve => { finish = resolve })
      const out = new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller
        if (!answer.hang) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); finish(answer.code ?? 0) }
      }, cancel() { cancelledPipes.push(pid) } })
      return {
        pid, stdout: out, stderr: new ReadableStream({ start(c) {
          if (answer.stderr) c.enqueue(new TextEncoder().encode(answer.stderr))
          if (!answer.retainPipes) c.close()
        }, cancel() { cancelledPipes.push(pid) } }),
        exited: exited.finally(() => { if (isJob) activeJobs-- }),
        kill(signal: string) { kills.push(signal); if (answer.hang && !answer.ignoreKill) { if (!answer.retainPipes) stream.close(); finish(137) } },
      }
    }) as unknown as typeof Bun.spawn)
    restore.push(() => spawnSpy.mockRestore())
  })

  afterEach(() => {
    for (const fn of [...restore].reverse()) fn()
    for (const n of envNames) { if (oldEnv[n] === undefined) delete process.env[n]; else process.env[n] = oldEnv[n] }
    try {
      assertNoLeak({ stdout, stderr })
      assertNoLeak(calls.map(c => c.argv))
      if (existsSync(output)) assertNoLeak(readdirSync(output).map(n => writtenFile(join(output, n))))
      if (stage) expect(existsSync(stage)).toBe(false)
      expect(clock.pendingCount()).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  const run = (planOnly = false, codexOnly = false, keepGoing = false) => runMatrix({ repo, output, planOnly, codexOnly, keepGoing })
  const jobsRun = () => calls.filter(c => c.argv[1] === 'run' && !c.argv.includes('id') && !c.argv.includes('/opt/cscb-ci/real-agent-codex-job.sh'))
  const codexRuns = () => calls.filter(c => c.argv.includes('/opt/cscb-ci/real-agent-codex-job.sh'))
  test.each([[false, false], [true, false], [false, true], [true, true]])('explicit Claude execution skips Codex login and latest lookup, failed=%s, aiOnly=%s', (failed, aiOnly) => {
    return (async () => {
      const versions = ['2.1.304', MIN_CLAUDE_CODE_VERSION]
      const jobs = selectedClaudePlan(versions, gates(), heavyNames(), aiOnly)
      process.env.CODEX_HOME = join(root, 'absent-login')
      latestResponse = async () => { throw new Error('unexpected latest lookup') }
      response = argv => {
        if (argv[0] !== 'docker' || argv[1] !== 'run') return {}
        const job = jobs.find(j => argv.includes(j.version))!
        const results = resultsFor(job)
        if (failed && job.version === versions[0]) results[0]!.exit = 1
        return { code: results.some(r => r.exit) ? 1 : 0, text: results.map(resultLine).join('\n') + '\n' }
      }
      expect(await runMatrix({ repo, output, planOnly: false, keepGoing: true, claudeVersions: versions, aiOnly })).toBe(!failed)
      if (aiOnly) for (const job of jobs) {
        expect(job.invocations).toEqual(AI_CRITERIA.flatMap(ac => [1, 2, 3].map(trial => ({
          script: `real-agent/test-${100 + ac}-fmk-real-ai-ac${ac}.sh`, trial, model: 'opus',
        }))))
      }
      expect(jobsRun()).toHaveLength(2)
      expect(codexRuns()).toHaveLength(0)
      expect(calls.some(c => c.argv.includes(CODEX_LOGIN_TARGET))).toBe(false)
      expect(existsSync(join(root, 'absent-login'))).toBe(false)
      expect(JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8'))).toMatchObject({
        selection: aiOnly ? 'claude-ai-only' : 'claude-only', totalInvocations: aiOnly ? 42 : 120, codexModel: null, localAgents: [], jobs,
      })
      expect(stdout.join('')).toContain(`REAL-AGENT-CLAUDE${aiOnly ? '-AI' : ''}-VERDICT ${failed ? 'FAIL' : 'PASS'}`)
      expect(calls.at(-1)!.argv.slice(0, 3)).toEqual(['docker', 'image', 'rm'])
    })()
  })

  test.each(['', 'latest', '2.1.304,', '2.1.304,2.1.304', '2.1.304\n'])('rejects invalid Claude selection %j', versions => {
    expect(() => matrixOptions(['--claude-versions', versions], repo)).toThrow('Usage')
  })

  test('Claude selection is exclusive with Codex and parsed without changing defaults', () => {
    expect(matrixOptions(['--claude-versions', `2.1.304,${MIN_CLAUDE_CODE_VERSION}`, '--output', output], repo))
      .toEqual({ repo, output, planOnly: false, claudeVersions: ['2.1.304', MIN_CLAUDE_CODE_VERSION] })
    expect(() => matrixOptions(['--codex-only', '--claude-versions', '2.1.304'], repo)).toThrow('Usage')
    expect(matrixOptions(['--claude-versions', '2.1.304', '--ai-only', '--output', output], repo))
      .toEqual({ repo, output, planOnly: false, claudeVersions: ['2.1.304'], aiOnly: true })
    for (const args of [['--ai-only'], ['--codex-only', '--ai-only']]) {
      expect(() => matrixOptions(args, repo)).toThrow('Usage')
    }
  })
  const interruptMatrix = (before: ReturnType<typeof process.listeners>) => {
    // Invoke only this run's handler: emitting a process signal also reaches
    // unrelated listeners installed by other suites in a combined Bun run.
    const handlers = process.listeners('SIGTERM').filter(handler => !before.includes(handler))
    expect(handlers).toHaveLength(1)
    handlers[0]!('SIGTERM')
  }

  test('resolves latest once, packs one production archive, runs sequentially, aggregates every usage/duplicate and ends in one PASS', async () => {
    let fetches = 0
    latestResponse = async () => { fetches++; return new Response('2.1.999\n') }
    const passed = await run()
    expect(stdout.filter(line => line.startsWith('FAIL:'))).toEqual([])
    expect(passed).toBe(true)
    expect(fetches).toBe(1)
    expect(jobsRun()).toHaveLength(3)
    expect(maxJobs).toBe(1)
    expect(calls.filter(c => c.argv[0] === 'bun')).toHaveLength(1)
    expect(calls.filter(c => c.argv.slice(0, 3).join(' ') === 'docker rm -f')).toHaveLength(5)
    expect(codexRuns()).toHaveLength(1)
    expect(calls.at(-1)!.argv.slice(0, 3)).toEqual(['docker', 'image', 'rm'])
    const count = plan().reduce((sum, j) => sum + j.invocations.length, 0)
    const totals = JSON.parse(stdout.find(l => l.startsWith('tokens: '))!.slice('tokens: '.length))
    expect(totals).toEqual({ input: (count + 15) * 7, output: (count + 15) * 3, cache_read: (count + 15) * 5, cache_creation: count + 15, duplicates: count * 2 })
    expect(stdout.filter(l => /^REAL-AGENT-VERDICT /.test(l))).toHaveLength(1)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT PASS /)
    const reports = readdirSync(output).filter(n => n.startsWith('job-'))
    expect(reports).toHaveLength(4)
    for (const name of reports) {
      expect(statSync(join(output, name)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(join(output, name), 'utf8')).packageSha256).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(jobsRun().map(c => c.key)).toEqual(Array(3).fill(process.env.CI_ANTHROPIC_API_KEY))
    expect(calls.every(c => c.detached === true)).toBe(true)
  })

  test('plan-only discovers required files and records no execution verdict or child process', async () => {
    delete process.env.CI_ANTHROPIC_API_KEY
    expect(await run(true)).toBe(true)
    expect(calls).toEqual([])
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-PLAN /)
    expect(stdout.some(l => l.startsWith('REAL-AGENT-VERDICT'))).toBe(false)
    expect(JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8')).jobs).toHaveLength(3)
    expect(JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8'))).toMatchObject({ selection: 'full', totalInvocations: 73 })
  })

  test.each(['claude', 'codex'])('failed %s job retains scrubbed scenario records after container and context cleanup', async agent => {
    response = argv => (agent === 'codex' ? argv.includes('/opt/cscb-ci/real-agent-codex-job.sh') : argv[1] === 'run' && !argv.includes('id')) ? { code: 1,
      text: AI_FAILURE_PREFIX + JSON.stringify({ agent, scenario: 'test-101-native', trial: '1', event: 'transcript',
        record: { type: 'assistant', agentId: process.env.CI_ANTHROPIC_API_KEY, message: { stop_reason: 'refusal' } } }) + '\n' } : {}
    expect(await run()).toBe(false)
    expect(jobsRun()).toHaveLength(agent === 'claude' ? 1 : 3)
    const file = join(output, 'real-agent-failures.jsonl'), record = JSON.parse(readFileSync(file, 'utf8'))
    expect(record).toMatchObject({ scenario: 'test-101-native', record: { message: { stop_reason: 'refusal' } } })
    expect(record.record.agentId).not.toContain(process.env.CI_ANTHROPIC_API_KEY)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(calls.some(c => c.argv.slice(0, 3).join(' ') === 'docker rm -f')).toBe(true)
    expect(stdout.join('')).not.toContain('real-agent-failure-evidence:')
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test('Codex-only plan needs no auth, Claude credential, Claude script or runtime-latest request', async () => {
    for (const name of envNames.filter(name => name.startsWith('CI_ANTHROPIC'))) delete process.env[name]
    rmSync(codex.home, { recursive: true, force: true })
    rmSync(join(repo, 'tests/integration'), { recursive: true, force: true })
    for (const name of heavyNames()) rmSync(join(repo, 'tests/real-agent', name))
    let fetches = 0
    latestResponse = async () => { fetches++; throw new Error('must not fetch') }
    expect(await run(true, true)).toBe(true)
    expect(fetches).toBe(0); expect(calls).toEqual([])
    expect(existsSync(codex.home)).toBe(false)
    const p = JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8'))
    expect(p).toMatchObject({ selection: 'codex-only', totalInvocations: 15, model: null, aiModel: null, codexModel: null, jobs: [], scheduler: null, localAgents: [codexExtension()] })
    expect(stdout.at(-1)).toBe(`REAL-AGENT-CODEX-PLAN ${p.runId}\n`)
    expect(stdout.some(line => line.includes('-VERDICT'))).toBe(false)
  })

  test('Codex-only execution runs exactly fifteen trials with the common local safety lifecycle and a distinct verdict', async () => {
    for (const name of envNames.filter(name => name.startsWith('CI_ANTHROPIC'))) delete process.env[name]
    // Malformed Claude routing settings must also be irrelevant to this leg.
    process.env.CI_ANTHROPIC_MODEL = 'unused invalid model'
    process.env.CI_ANTHROPIC_AI_MODEL = 'unused invalid model'
    let fetches = 0, lockHeld = false
    latestResponse = async () => { fetches++; throw new Error('must not fetch') }
    response = argv => {
      if (argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) lockHeld = probeFlock(join(codex.home, 'codex-login.lock')) === 'held'
      return {}
    }
    expect(await run(false, true)).toBe(true)
    expect(fetches).toBe(0); expect(jobsRun()).toEqual([]); expect(codexRuns()).toHaveLength(1)
    const args = codexRuns()[0]!.argv, ext = codexExtension()
    expect(args.slice(args.indexOf('/opt/cscb-ci/real-agent-codex-job.sh') + 1)).toEqual(ext.invocations.map(i => `${i.script}:${i.trial}`))
    expect(args.filter((_, i) => args[i - 1] === '--mount')).toEqual([`type=bind,source=${codex.auth},target=${CODEX_LOGIN_TARGET}`])
    expect(args.filter((_, i) => args[i - 1] === '--env')).toEqual(['CODEX_TEST_MODEL', 'CODEX_HOST_CONFIG_KEYS'])
    expect(lockHeld).toBe(true); expect(probeFlock(join(codex.home, 'codex-login.lock'))).toBe('free')
    expect(calls.filter(c => c.argv.includes('id'))).toHaveLength(1)
    expect(calls.filter(c => c.argv[1] === 'container' && c.argv[2] === 'inspect')).toHaveLength(1)
    expect(calls.filter(c => c.argv[1] === 'rm')).toHaveLength(2)
    expect(calls.at(-1)!.argv.slice(0, 3)).toEqual(['docker', 'image', 'rm'])
    const p = JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8'))
    expect(p).toMatchObject({ selection: 'codex-only', totalInvocations: 15, model: null, aiModel: null, codexModel, jobs: [], scheduler: null, localAgents: [ext] })
    expect(JSON.parse(readFileSync(join(output, 'job-codex.json'), 'utf8'))).toMatchObject({ selection: 'codex-only', version: CODEX_VERSION, codexModel, results: codexResults() })
    expect(stdout.at(-1)).toBe(`REAL-AGENT-CODEX-VERDICT PASS ${p.runId}\n`)
    expect(stdout.some(line => /^REAL-AGENT-VERDICT /.test(line))).toBe(false)
    expect(calls.every(call => ['bun', 'bash', 'docker'].includes(call.argv[0]!))).toBe(true)
  })

  test.each([['--codex-only', '--codex-only'], ['--codex-only=true'], ['--codex-only', 'true'], ['--plan', '--plan', '--codex-only']].map(args => [args] as const))('focused option refuses malformed or duplicate argv %j', args => {
    expect(() => matrixOptions(args, repo)).toThrow('Usage')
    expect(calls).toEqual([]); expect(existsSync(output)).toBe(false)
  })

  test('focused options preserve explicit output and plan selection', () => {
    expect(matrixOptions(['--codex-only', '--plan', '--output', output], repo)).toEqual({ repo, output, planOnly: true, codexOnly: true })
  })

  test('routes image inspection through private full JSON capture before any child line can stream', async () => {
    // These inspection-only values are absent from the coordinator environment;
    // ordinary log masking cannot protect them if inspect reaches the streaming runner.
    const inspectedValues = ['api-key', 'auth-token', 'gateway', 'model', 'future'].map(label => fakeToken('', `inspect-${label}`))
    response = argv => argv[1] === 'image' && argv[2] === 'inspect' ? {
      text: JSON.stringify([{ Id: 'a'.repeat(64), Config: { Env: inspectedValues.map((value, i) => `ANTHROPIC_TEST_${i}=${value}`),
        Labels: { copied: inspectedValues.join(' '), [`copied-${inspectedValues[1]}`]: inspectedValues[2] } },
        Nested: { Env: [`ANTHROPIC_NESTED=${fakeToken('', 'inspect-nested')}`] } }]),
      stderr: `private inspect diagnostic ${inspectedValues.join(' ')}\n`,
    } : {}
    expect(await run()).toBe(true)
    assertNoLeak({ stdout, stderr, artifacts: readdirSync(output).map(n => writtenFile(join(output, n))) })
    expect(stderr).toEqual([])
    expect(stdout).toContain('a'.repeat(64) + '\n')
    expect(stdout.some(line => line.includes('private inspect diagnostic'))).toBe(false)
    expect(calls.find(c => c.argv[1] === 'image' && c.argv[2] === 'inspect')!.argv)
      .toEqual(['docker', 'image', 'inspect', 'cscb-ci-base:v8'])
    expect(calls.filter(c => c.argv[0] === 'bash')).toEqual([])
  })

  test.each(['malformed JSON', 'nonzero exit'] as const)('inspect %s discards both pipes before the existing base-build fallback', async kind => {
    response = argv => {
      if (argv[1] === 'image' && argv[2] === 'inspect') return {
        text: kind === 'malformed JSON' ? `[{"note":"${fakeToken('', 'partial-inspect')}"` : JSON.stringify([{ Id: 'a'.repeat(64), Config: { Env: [] } }]),
        stderr: fakeToken('', 'inspect-failure-stderr'), code: kind === 'nonzero exit' ? 7 : 0,
      }
      return argv[0] === 'bash' ? { code: 1 } : {}
    }
    expect(await run()).toBe(false)
    assertNoLeak({ stdout, stderr })
    expect(stderr).toEqual([])
    expect(calls.map(c => c.argv.slice(0, 3))).toEqual([
      ['docker', 'container', 'ls'], ['docker', 'image', 'inspect'], ['bash', 'scripts/ci-base-build.sh'],
    ])
    expect(jobsRun()).toEqual([])
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test.each(['HTTP error', 'malformed version', 'network error'] as const)('latest resolution %s blocks all execution and emits FAIL', async kind => {
    latestResponse = async () => {
      if (kind === 'network error') throw new Error('offline')
      return kind === 'HTTP error' ? new Response('', { status: 503 }) : new Response('latest')
    }
    expect(await run()).toBe(false)
    expect(calls).toEqual([])
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test.each(['nonzero exit', 'missing result', 'failed AI trial', 'unreported usage', 'malformed result'] as const)('job %s stops without a retry, removes container and image, and never writes a success report', async kind => {
    response = argv => {
      if (argv[1] !== 'run' || argv.includes('id') || argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) return {}
      const job = jobForArgv(argv), rows = resultsFor(job)
      if (kind === 'failed AI trial' && !job.invocations.some(i => i.model === 'opus')) return {}
      if (kind === 'nonzero exit') return { code: 1 }
      if (kind === 'missing result') rows.pop()
      if (kind === 'failed AI trial') rows.at(-1)!.exit = 1
      if (kind === 'unreported usage') rows[0]!.reported = false
      return { text: kind === 'malformed result' ? 'real-agent-result: {\n' : rows.map(resultLine).join('\n') }
    }
    expect(await run()).toBe(false)
    const failedJob = kind === 'failed AI trial' ? plan().findIndex(j => j.invocations.some(i => i.model === 'opus')) : 0
    expect(jobsRun()).toHaveLength(failedJob + 1)
    expect(calls.at(-2)!.argv.slice(0, 3)).toEqual(['docker', 'rm', '-f'])
    expect(calls.at(-1)!.argv.slice(0, 3)).toEqual(['docker', 'image', 'rm'])
    expect(existsSync(join(output, `job-${failedJob + 1}.json`))).toBe(false)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test.each(['nonzero exit', 'missing result', 'failed AI trial', 'malformed result'] as const)('keep-going retains %s failures, executes subsequent versions and Codex once, and cannot pass', async kind => {
    response = argv => {
      if (argv[1] !== 'run' || argv.includes('id') || argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) return {}
      const job = jobForArgv(argv)
      if (job.runtimeLatest) return {}
      const rows = resultsFor(job)
      if (kind === 'missing result') rows.pop()
      if (kind === 'failed AI trial') rows.at(-1)!.exit = 1
      const evidence = AI_FAILURE_PREFIX + JSON.stringify({ scenario: 'same-scenario', trial: 1, event: 'transcript', record: { agentId: 'child', type: 'assistant' } })
      return { code: kind === 'nonzero exit' ? 1 : 0,
        text: evidence + '\n' + (kind === 'malformed result' ? 'real-agent-result: {\n' : rows.map(resultLine).join('\n')) }
    }
    expect(await run(false, false, true)).toBe(false)
    expect(jobsRun()).toHaveLength(3); expect(codexRuns()).toHaveLength(1); expect(maxJobs).toBe(1)
    expect(jobsRun().every(c => c.argv.includes('--keep-going'))).toBe(true)
    const retained = readFileSync(join(output, 'real-agent-failures.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(retained.map(r => [r.job, r.version, r.scenario])).toEqual([[1, MIN_CLAUDE_CODE_VERSION, 'same-scenario'], [2, LIVE_CLAUDE_CODE_VERSION, 'same-scenario']])
    expect(JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8'))).toMatchObject({ keepGoing: true, totalInvocations: 73 })
    for (const index of [1, 2]) {
      expect(existsSync(join(output, `job-${index}.json`))).toBe(false)
      expect(JSON.parse(readFileSync(join(output, `failed-job-${index}.json`), 'utf8')).error).toBeTruthy()
    }
    expect(existsSync(join(output, 'job-3.json'))).toBe(true)
    expect(existsSync(join(output, 'job-codex.json'))).toBe(true)
    expect(stdout.filter(l => /^REAL-AGENT-VERDICT /.test(l))).toHaveLength(1)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
    assertNoLeak(retained)
  })

  test('keep-going passes only when the entire unchanged matrix passes', async () => {
    expect(matrixOptions(['--keep-going', '--output', output], repo)).toEqual({ repo, output, planOnly: false, keepGoing: true })
    expect(() => matrixOptions(['--keep-going', '--keep-going'], repo)).toThrow('Usage')
    expect(await run(false, false, true)).toBe(true)
    expect(jobsRun()).toHaveLength(3); expect(codexRuns()).toHaveLength(1)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT PASS /)
  })

  test('keep-going still stops after a container cleanup failure', async () => {
    response = argv => argv[1] === 'rm' ? { code: 1 } : {}
    expect(await run(false, false, true)).toBe(false)
    expect(jobsRun()).toHaveLength(1); expect(codexRuns()).toHaveLength(0)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test.each(['base build', 'pack', 'image build'] as const)('%s failure has no scenario retry and cleans its context', async kind => {
    response = argv => {
      if (kind === 'base build' && (argv[2] === 'inspect' || argv[0] === 'bash')) return { code: 1 }
      if (kind === 'pack' && argv[0] === 'bun') return { code: 1 }
      if (kind === 'image build' && argv[1] === 'build') return { code: 1 }
      return {}
    }
    expect(await run()).toBe(false)
    expect(jobsRun()).toEqual([])
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test.each([['timeout', false], ['SIGTERM', false], ['SIGTERM', true]] as const)('%s (keep-going=%s) kills the active child and cleans up without starting the next version', async (kind, keepGoing) => {
    let unrelatedSignals = 0
    const unrelated = () => { unrelatedSignals++ }
    process.on('SIGTERM', unrelated)
    restore.push(() => { process.off('SIGTERM', unrelated) })
    const before = process.listenerCount('SIGTERM')
    const signalHandlers = process.listeners('SIGTERM')
    response = argv => argv[1] === 'run' ? { hang: true } : {}
    const pending = run(false, false, keepGoing)
    for (let i = 0; i < 10 && jobsRun().length === 0; i++) await clock.flush()
    expect(jobsRun()).toHaveLength(1)
    if (kind === 'timeout') {
      expect(clock.pending().map(p => p.delayMs)).toContain(MATRIX_TIMEOUT_MS)
      await clock.advance(MATRIX_TIMEOUT_MS)
    } else interruptMatrix(signalHandlers)
    expect(await pending).toBe(false)
    expect(unrelatedSignals).toBe(0)
    expect(kills).toContain(kind === 'timeout' ? 'SIGKILL' : 'SIGTERM')
    const pid = jobsRun()[0]!.pid
    expect(groupKills).toContainEqual({ pid: -pid, signal: kind === 'timeout' ? 'SIGKILL' : 'SIGTERM' })
    expect(jobsRun()).toHaveLength(1)
    expect(process.listenerCount('SIGTERM')).toBe(before)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test.each([
    ['timeout', 'job'], ['SIGTERM', 'job'], ['timeout', 'base build'], ['SIGTERM', 'base build'],
  ] as const)('%s bounds a %s descendant-held pipe drain and removes all owned contexts', async (kind, step) => {
    let nestedContext: string | undefined
    response = argv => {
      if (step === 'base build' && argv[1] === 'image' && argv[2] === 'inspect') return { code: 1 }
      if (step === 'job' ? argv[1] === 'run' : argv[0] === 'bash') {
        nestedContext = join(stage!, 'base-install-context')
        mkdirSync(nestedContext)
        writeFileSync(join(nestedContext, 'install-real-agents.sh'), 'fake nested build context')
        // Neither exit nor inherited output descriptors settle on a signal.
        return { hang: true, retainPipes: true, ignoreKill: true }
      }
      return {}
    }
    const listeners = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))
    const signalHandlers = process.listeners('SIGTERM')
    let settled = false
    const pending = run().then(result => { settled = true; return result })
    for (let i = 0; i < 20 && !nestedContext; i++) await clock.flush()
    expect(nestedContext).toBeDefined()
    expect(existsSync(nestedContext!)).toBe(true)
    const active = calls.at(-1)!, ownedStage = stage!
    // A refused private inspect is killed before falling back to the base build.
    const inspectionKills = step === 'base build' ? [{ pid: -calls.find(call => call.argv[1] === 'image' && call.argv[2] === 'inspect')!.pid, signal: 'SIGKILL' }] : []
    expect(groupKills).toEqual(inspectionKills)
    expect(active.detached).toBe(true)
    expect(active.tmpdir).toBe(ownedStage)
    if (kind === 'timeout') await clock.advance(step === 'job' ? MATRIX_TIMEOUT_MS : 30 * 60_000)
    else interruptMatrix(signalHandlers)
    await clock.flush()
    expect(settled).toBe(false)
    expect(groupKills).toEqual([...inspectionKills, { pid: -active.pid, signal: kind === 'timeout' ? 'SIGKILL' : 'SIGTERM' }])
    await clock.advance(999)
    expect(settled).toBe(false)
    await clock.advance(1)
    expect(settled).toBe(true)
    expect(await pending).toBe(false)
    expect(groupKills).toEqual([
      ...inspectionKills,
      { pid: -active.pid, signal: kind === 'timeout' ? 'SIGKILL' : 'SIGTERM' },
      { pid: -active.pid, signal: 'SIGKILL' },
    ])
    expect(cancelledPipes.filter(pid => pid === active.pid)).toHaveLength(2)
    expect(existsSync(ownedStage)).toBe(false)
    expect(existsSync(nestedContext!)).toBe(false)
    expect(jobsRun()).toHaveLength(step === 'job' ? 1 : 0)
    expect(calls.filter(c => c.argv[0] === 'bash')).toHaveLength(step === 'base build' ? 1 : 0)
    if (step === 'job') {
      expect(calls.at(-2)!.argv.slice(0, 3)).toEqual(['docker', 'rm', '-f'])
      expect(calls.at(-1)!.argv.slice(0, 3)).toEqual(['docker', 'image', 'rm'])
    }
    expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(listeners)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test.each(['tokens', 'duplicates', 'both'] as const)('missing %s keeps partial run accounting, explains incompleteness and fails without retry', async missing => {
    response = argv => {
      if (argv[1] !== 'run' || argv.includes('id') || argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) return {}
      const rows = resultsFor(jobForArgv(argv))
      rows[1] = { ...rows[1]!, reported: false,
        ...(missing !== 'duplicates' ? { tokens: null } : {}),
        ...(missing !== 'tokens' ? { duplicates: null } : {}) }
      return { text: rows.map(resultLine).join('\n') }
    }
    expect(await run()).toBe(false)
    const count = plan()[0]!.invocations.length
    const usages = count - (missing === 'duplicates' ? 0 : 1)
    const duplicates = count - (missing === 'tokens' ? 0 : 1)
    const totals = JSON.parse(stdout.find(l => l.startsWith('tokens: '))!.slice('tokens: '.length))
    expect(totals).toEqual({ input: usages * 7, output: usages * 3, cache_read: usages * 5, cache_creation: usages, duplicates: duplicates * 2 })
    expect(stdout.filter(l => l.includes('matrix usage report incomplete; totals include observed reports only'))).toHaveLength(1)
    expect(jobsRun()).toHaveLength(1)
    expect(existsSync(join(output, 'job-1.json'))).toBe(false)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test('redacts the runtime key even when a failed child echoes it, including a final unterminated line', async () => {
    response = argv => argv[1] === 'run' ? { code: 1, text: `diagnostic ${process.env.CI_ANTHROPIC_API_KEY}` } : {}
    expect(await run()).toBe(false)
    expect(stdout.join('')).toContain('diagnostic <redacted>')
  })

  test('rejects a child-injected credential field before writing result artifacts', async () => {
    response = argv => argv[1] === 'run' ? {
      text: resultsFor(plan()[0]!).map(r => resultLine({ ...r, credential: process.env.CI_ANTHROPIC_API_KEY })).join('\n'),
    } : {}
    expect(await run()).toBe(false)
    expect(jobsRun()).toHaveLength(1)
    expect(existsSync(join(output, 'job-1.json'))).toBe(false)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test.each(['container', 'image'] as const)('failed %s cleanup blocks PASS rather than leaving a successful verdict', async kind => {
    response = argv => (kind === 'container' ? argv[1] === 'rm' : argv[1] === 'image' && argv[2] === 'rm') ? { code: 1 } : {}
    expect(await run()).toBe(false)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test('a failing scenario still contributes its reported token use and duplicates to the run total', async () => {
    response = argv => {
      if (argv[1] !== 'run' || argv.includes('id') || argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) return {}
      const rows = resultsFor(jobForArgv(argv)).slice(0, 2)
      rows[1]!.exit = 1
      return { code: 1, text: rows.map(resultLine).join('\n') }
    }
    expect(await run()).toBe(false)
    expect(jobsRun()).toHaveLength(1)
    const totals = JSON.parse(stdout.find(l => l.startsWith('tokens: '))!.slice('tokens: '.length))
    expect(totals).toEqual({ input: 14, output: 6, cache_read: 10, cache_creation: 2, duplicates: 4 })
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test.each(['CI_ANTHROPIC_API_KEY', 'CI_ANTHROPIC_MODEL'] as const)('missing %s refuses before filesystem or child effects', async key => {
    delete process.env[key]
    await expect(run()).rejects.toThrow('required')
    expect(calls).toEqual([])
    expect(existsSync(output)).toBe(false)
  })

  test('defaults AI routing to the selected CI model and ignores the legacy Opus override', async () => {
    process.env.CI_ANTHROPIC_OPUS_MODEL = 'claude-opus-4-8'
    expect(await run()).toBe(true)
    expect(jobsRun().map(c => [c.model, c.aiModel])).toEqual(Array(3).fill([model, model]))
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT PASS /)
  })

  test('accepts an explicitly selected non-Opus AI model while keeping ordinary routing separate', async () => {
    const selected = 'azure/openai/gpt-6-astra'
    process.env.CI_ANTHROPIC_AI_MODEL = selected
    process.env.CI_ANTHROPIC_OPUS_MODEL = 'ignored-legacy-model'
    expect(await run()).toBe(true)
    expect(jobsRun().map(c => [c.model, c.aiModel])).toEqual(Array(3).fill([model, selected]))
    const recorded = JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8'))
    expect([recorded.model, recorded.aiModel]).toEqual([model, selected])
    const rows = readdirSync(output).filter(n => n.startsWith('job-')).flatMap(n => JSON.parse(readFileSync(join(output, n), 'utf8')).results)
    expect(rows.filter(r => r.script.includes('-ai-ac') && r.agent !== 'codex').every(r => r.model === selected)).toBe(true)
    expect(rows.filter(r => !r.script.includes('-ai-ac')).every(r => r.model === model)).toBe(true)
  })

  test('defaults AI to a non-Opus CI model without imposing a family restriction', async () => {
    process.env.CI_ANTHROPIC_MODEL = 'azure/openai/gpt-6-astra'
    expect(await run()).toBe(true)
    expect(jobsRun().map(c => [c.model, c.aiModel])).toEqual(Array(3).fill(['azure/openai/gpt-6-astra', 'azure/openai/gpt-6-astra']))
  })

  test.each(['', 'model with spaces', 'model\n', 'model\r', '-model', 'a'.repeat(257), 'model$(command)'])('invalid AI override %j refuses before filesystem or child effects', async value => {
    process.env.CI_ANTHROPIC_AI_MODEL = value
    await expect(run()).rejects.toThrow('Invalid matrix model identifier')
    expect(calls).toEqual([])
    expect(existsSync(output)).toBe(false)
  })

  test.each(['AI', 'ordinary'])('a result using the other routing model fails its %s invocation', async kind => {
    const selected = 'azure/openai/gpt-6-astra'
    process.env.CI_ANTHROPIC_AI_MODEL = selected
    response = argv => {
      if (argv[1] !== 'run' || argv.includes('id') || argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) return {}
      const job = jobForArgv(argv), rows = resultsFor(job, model, selected)
      const at = job.invocations.findIndex(i => (i.model === 'opus') === (kind === 'AI'))
      if (at < 0) return { text: rows.map(resultLine).join('\n') }
      rows[at]!.model = kind === 'AI' ? model : selected
      return { text: rows.map(resultLine).join('\n') }
    }
    expect(await run()).toBe(false)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test('Codex runs once locally after Claude with only its one login mount and recorded model', async () => {
    const privateValue = fakeToken('', 'host-config-value')
    writeFileSync(codex.config, `model="${codexModel}"\nmodel_reasoning_effort="${privateValue}"\n[profiles.private]\nendpoint="${privateValue}"\n`)
    let lockHeld = false
    response = argv => {
      if (argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) lockHeld = probeFlock(join(codex.home, 'codex-login.lock')) === 'held'
      return {}
    }
    expect(await run()).toBe(true)
    expect(lockHeld).toBe(true)
    expect(probeFlock(join(codex.home, 'codex-login.lock'))).toBe('free')
    const call = codexRuns()[0]!, args = call.argv
    expect(call.codexModel).toBe(codexModel)
    expect(decodeCodexHostConfigKeys(call.hostConfigKeys)).toEqual([
      ['model'], ['model_reasoning_effort'], ['profiles', 'private', 'endpoint'], ['profiles', 'private'], ['profiles'],
    ])
    expect(args.filter((_, i) => args[i - 1] === '--env')).toEqual(['CODEX_TEST_MODEL', 'CODEX_HOST_CONFIG_KEYS'])
    expect(args.some(arg => arg.includes(call.hostConfigKeys!) || arg.includes('inherited-untrusted-projection'))).toBe(false)
    expect(jobsRun().every(call => !call.argv.includes('CODEX_HOST_CONFIG_KEYS'))).toBe(true)
    assertNoLeak(call.hostConfigKeys)
    expect(args.filter((_, i) => args[i - 1] === '--mount')).toEqual([`type=bind,source=${codex.auth},target=${CODEX_LOGIN_TARGET}`])
    expect(args[args.indexOf('--ulimit') + 1]).toBe('core=0')
    expect(args[args.indexOf('--memory') + 1]).toBe(String(Number(MATRIX_MEMORY) + CODEX_EXTRA_MEMORY_BYTES))
    expect(args[args.indexOf('--memory-swap') + 1]).toBe(String(Number(MATRIX_MEMORY) + CODEX_EXTRA_MEMORY_BYTES))
    expect(args).not.toContain('--rm')
    expect(jobsRun().every(call => !call.argv.includes('--mount') && !call.argv.includes(codex.auth))).toBe(true)
    expect(calls.every(call => ['bun', 'bash', 'docker'].includes(call.argv[0]!))).toBe(true)
    const report = JSON.parse(readFileSync(join(output, 'job-codex.json'), 'utf8'))
    expect(report.codexModel).toBe(codexModel)
    expect(report.results).toEqual(codexResults())
    expect(stdout).toContain(`recorded: codex-model ${codexModel}\n`)
  })

  test('invalid host-key projection refuses the heavy run before build, lock or launch', async () => {
    writeFileSync(codex.config, `model="${codexModel}"\nmodel="duplicate"\n`)
    expect(await run()).toBe(false)
    expect(calls).toEqual([])
    expect(existsSync(join(codex.home, 'codex-login.lock'))).toBe(false)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
  })

  test('Codex positive message-copy counts survive reports and contribute to totals without failing the matrix', async () => {
    const rows = codexResults().map((row, i) => ({ ...row, duplicates: i + 1 }))
    response = argv => argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')
      ? { text: rows.map(resultLine).join('\n') } : {}
    expect(await run()).toBe(true)
    expect(codexRuns()).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(output, 'job-codex.json'), 'utf8')).results).toEqual(rows)
    const claudeCopies = plan().reduce((sum, job) => sum + job.invocations.length * 2, 0)
    const totals = JSON.parse(stdout.find(line => line.startsWith('tokens: '))!.slice('tokens: '.length))
    expect(totals.duplicates).toBe(claudeCopies + rows.reduce((sum, row) => sum + row.duplicates, 0))
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT PASS /)
  })

  test.each((['missing', 'duplicate-result-row', 'wrong-version', 'wrong-model', 'failed', 'unreported', 'unfinished', 'wrong-agent', 'missing-copy-count', 'negative-copy-count', 'fractional-copy-count', 'unsafe-copy-count', 'missing-usage', 'malformed-usage', 'zero-usage'] as const).flatMap(kind => [false, true].map(codexOnly => [kind, codexOnly] as const)))('Codex %s (codexOnly=%s) evidence blocks PASS and retires without retry', async (kind, codexOnly) => {
    response = argv => {
      if (!argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) return {}
      const rows = codexResults()
      const row = rows[rows.length - 1]!
      if (kind === 'missing') rows.pop()
      if (kind === 'duplicate-result-row') rows[rows.length - 1] = rows[0]!
      if (kind === 'wrong-version') row.version = '0.159.1'
      if (kind === 'wrong-model') row.model = 'other-model'
      if (kind === 'failed') row.exit = 1
      if (kind === 'unreported') row.reported = false
      if (kind === 'unfinished') row.completed = false
      if (kind === 'wrong-agent') delete row.agent
      if (kind === 'missing-copy-count') row.duplicates = null
      if (kind === 'negative-copy-count') row.duplicates = -1
      if (kind === 'fractional-copy-count') row.duplicates = 0.5
      if (kind === 'unsafe-copy-count') row.duplicates = Number.MAX_SAFE_INTEGER + 1
      if (kind === 'missing-usage') row.tokens = null
      if (kind === 'malformed-usage') row.tokens!.input = -1
      if (kind === 'zero-usage') row.tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
      return { text: rows.map(resultLine).join('\n') }
    }
    expect(await run(false, codexOnly)).toBe(false)
    expect(jobsRun()).toHaveLength(codexOnly ? 0 : 3)
    expect(codexRuns()).toHaveLength(1)
    expect(existsSync(join(output, 'job-codex.json'))).toBe(false)
    expect(probeFlock(join(codex.home, 'codex-login.lock'))).toBe('free')
    expect(calls.some(call => call.argv[1] === 'rm' && call.argv.at(-1)?.endsWith('-codex'))).toBe(true)
    expect(stdout.at(-1)).toMatch(codexOnly ? /^REAL-AGENT-CODEX-VERDICT FAIL / : /^REAL-AGENT-VERDICT FAIL /)
  })

  test.each((['original', 'rotated'] as const).flatMap(kind => [false, true].map(codexOnly => [kind, codexOnly] as const)))('rejects a leaked %s (codexOnly=%s) Codex token while masking every artifact', async (generation, codexOnly) => {
    response = argv => {
      if (!argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) return {}
      codex.writeLogin('rotated')
      const secret = generation === 'original' ? codex.tokens.access : fakeToken('', 'codex-access-rotated')
      return { text: `private diagnostic ${secret}\n` + codexResults().map(resultLine).join('\n') }
    }
    expect(await run(false, codexOnly)).toBe(false)
    expect(readFileSync(join(output, 'codex-docker.log'), 'utf8')).toContain('private diagnostic <redacted>')
    expect(stdout.at(-1)).toMatch(codexOnly ? /^REAL-AGENT-CODEX-VERDICT FAIL / : /^REAL-AGENT-VERDICT FAIL /)
  })

  test.each((['invalid-json', 'replacement', 'mode'] as const).flatMap(kind => [false, true].map(codexOnly => [kind, codexOnly] as const)))('post-run login %s (codexOnly=%s) corruption blocks PASS and releases the lock', async (kind, codexOnly) => {
    response = argv => {
      if (!argv.includes('/opt/cscb-ci/real-agent-codex-job.sh')) return {}
      if (kind === 'invalid-json') writeFileSync(codex.auth, fakeToken('', 'broken-login'))
      if (kind === 'replacement') { renameSync(codex.auth, join(codex.home, 'old-auth')); codex.writeLogin('replacement') }
      if (kind === 'mode') chmodSync(codex.auth, 0o644)
      return {}
    }
    expect(await run(false, codexOnly)).toBe(false)
    expect(stdout.join('')).toContain('codex login --device-auth')
    expect(probeFlock(join(codex.home, 'codex-login.lock'))).toBe('free')
    expect(existsSync(join(output, 'job-codex.json'))).toBe(false)
  })

  test.each((['uid', 'uid-cleanup', 'codex-cleanup', 'inspect', 'inspect-exit', 'inspect-running', 'inspect-memory'] as const).flatMap(kind => [false, true].map(codexOnly => [kind, codexOnly] as const)))('Codex %s (codexOnly=%s) failure prevents PASS', async (kind, codexOnly) => {
    let cleanupFailures = 0
    response = argv => {
      if (kind === 'uid' && argv.includes('id')) return { text: String(process.getuid!() + 1) }
      if (kind === 'uid-cleanup' && argv[1] === 'rm' && argv.at(-1)?.endsWith('-uid')) return { code: 1 }
      if (kind === 'codex-cleanup' && argv[1] === 'rm' && argv.at(-1)?.endsWith('-codex') && cleanupFailures++ === 0) return { code: 1 }
      if (argv[1] === 'container' && argv[2] === 'inspect') {
        if (kind === 'inspect') return { text: 'not JSON' }
        const state = { Running: kind === 'inspect-running', OOMKilled: false, ExitCode: kind === 'inspect-exit' ? 7 : 0 }
        const row = { Id: 'b'.repeat(64), Config: { Env: [] }, State: state,
          Mounts: [{ Source: codex.auth, Destination: CODEX_LOGIN_TARGET, RW: true }],
          HostConfig: { Memory: kind === 'inspect-memory' ? 1 : Number(MATRIX_MEMORY) + CODEX_EXTRA_MEMORY_BYTES } }
        return { text: JSON.stringify([row]) }
      }
      return {}
    }
    expect(await run(false, codexOnly)).toBe(false)
    expect(stdout.at(-1)).toMatch(codexOnly ? /^REAL-AGENT-CODEX-VERDICT FAIL / : /^REAL-AGENT-VERDICT FAIL /)
  })

  test.each((['timeout', 'SIGTERM'] as const).flatMap(kind => [false, true].map(codexOnly => [kind, codexOnly] as const)))('Codex %s (codexOnly=%s) retires its local job, postchecks the login and releases the lock', async (kind, codexOnly) => {
    const before = process.listeners('SIGTERM')
    response = argv => argv.includes('/opt/cscb-ci/real-agent-codex-job.sh') ? { hang: true } : {}
    const pending = run(false, codexOnly)
    for (let i = 0; i < 100 && codexRuns().length === 0; i++) await clock.flush()
    expect(codexRuns()).toHaveLength(1)
    if (kind === 'timeout') await clock.advance(MATRIX_TIMEOUT_MS)
    else interruptMatrix(before)
    expect(await pending).toBe(false)
    expect(jobsRun()).toHaveLength(codexOnly ? 0 : 3)
    expect(codexRuns()).toHaveLength(1)
    expect(probeFlock(join(codex.home, 'codex-login.lock'))).toBe('free')
    expect(existsSync(join(output, 'job-codex.json'))).toBe(false)
    expect(stdout.at(-1)).toMatch(codexOnly ? /^REAL-AGENT-CODEX-VERDICT FAIL / : /^REAL-AGENT-VERDICT FAIL /)
  })

  test.each((['survivor', 'unreadable'] as const).flatMap(kind => [false, true].map(codexOnly => [kind, codexOnly] as const)))('Codex %s (codexOnly=%s) retirement proof refuses the heavy run before building or launching', async (kind, codexOnly) => {
    response = argv => argv.join(' ') === codexLoginContainerListArgs().join(' ')
      ? kind === 'survivor' ? { text: 'earlier-container-id\n' } : { code: 1 } : {}
    expect(await run(false, codexOnly)).toBe(false)
    expect(calls.map(call => call.argv)).toEqual([codexLoginContainerListArgs()])
    expect(jobsRun()).toEqual([])
    expect(codexRuns()).toEqual([])
    expect(probeFlock(join(codex.home, 'codex-login.lock'))).toBe('free')
    expect(stdout.at(-1)).toMatch(codexOnly ? /^REAL-AGENT-CODEX-VERDICT FAIL / : /^REAL-AGENT-VERDICT FAIL /)
  })

  test.each([false, true])('unresolved retirement preserves the login lease until runner exit (codexOnly=%s)', async codexOnly => {
    const open = ciRunner.openLockFile
    let release = () => {}
    const lockSpy = spyOn(ciRunner, 'openLockFile').mockImplementation(path => {
      const opened = open(path)
      if (opened.ok) release = () => opened.value.release()
      return opened
    })
    restore.push(() => lockSpy.mockRestore())
    response = argv => argv[1] === 'rm' && argv.at(-1)?.endsWith('-codex') ? { code: 1 } : {}
    try {
      expect(await run(false, codexOnly)).toBe(false)
      expect(codexRuns()).toHaveLength(1)
      expect(jobsRun()).toHaveLength(codexOnly ? 0 : 3)
      expect(probeFlock(join(codex.home, 'codex-login.lock'))).toBe('held')
      expect(stdout.join('')).toContain('Codex container retirement unresolved; login lease held until runner exit')
      expect(stdout.at(-1)).toMatch(codexOnly ? /^REAL-AGENT-CODEX-VERDICT FAIL / : /^REAL-AGENT-VERDICT FAIL /)
    } finally { release() }
    expect(probeFlock(join(codex.home, 'codex-login.lock'))).toBe('free')
  })

  test('output options forbid checkout and test-results paths and reject unknown or incomplete arguments', () => {
    expect(matrixOptions(['--plan', '--output', output], repo)).toEqual({ repo, output, planOnly: true })
    for (const path of [repo, join(repo, 'results'), '/test-results', '/test-results/run'])
      expect(() => matrixOptions(['--output', path], repo)).toThrow('outside')
    for (const args of [['--output'], ['--unknown']]) expect(() => matrixOptions(args, repo)).toThrow('Usage')
  })

  test('output refusal follows symlinked checkout paths before creating a result directory', () => {
    const alias = join(root, 'checkout-alias')
    symlinkSync(repo, alias, 'dir')
    expect(() => matrixOptions(['--output', join(alias, 'results')], repo)).toThrow('outside')
    expect(existsSync(join(repo, 'results'))).toBe(false)
  })
})
