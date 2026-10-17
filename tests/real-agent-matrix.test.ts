/** Heavy coordinator contracts, driven with fake fetch, streams and children.
 * No Docker, agent, agent-director, tmux or model call runs on the host.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AI_CRITERIA, GATE_SLUGS, HEAVY_SCRIPTS, MATRIX_CPUS, MATRIX_MEMORY, MATRIX_TIMEOUT_MS,
  MATRIX_VERSIONS, SCHEDULER_JOB_CONTRACT, assertJobComplete, discoverGateScripts,
  matrixDockerArgs, matrixOptions, matrixPlan, safeModel, parseResultLine, runMatrix,
  type MatrixJob, type MatrixResult,
} from '../scripts/real-agent-matrix.ts'
import { CPUS_PER_SHARD, SHARD_MEMORY_CAP_BYTES, SHARD_PIDS_LIMIT } from '../scripts/ci-run.ts'
import { assertNoLeak, fakeToken, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { LIVE_CLAUDE_CODE_VERSION, MIN_CLAUDE_CODE_VERSION } from './test-helpers/agent-director-versions.ts'

const gateNames = () => GATE_SLUGS.map((slug, i) => `test-${32 + i}-fmk-real-${slug}.sh`)
const heavyNames = () => [...HEAVY_SCRIPTS, ...AI_CRITERIA.map(ac => `test-${100 + ac}-fmk-real-ai-ac${ac}.sh`)]
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

describe('heavy execution with fake children', () => {
  let root: string, repo: string, output: string
  let stdout: string[], calls: { argv: string[]; key: string | undefined; model: string | undefined; aiModel: string | undefined; pid: number; detached: boolean | undefined; tmpdir: string | undefined }[], stage: string | undefined
  let response: (argv: string[]) => { code?: number; text?: string; hang?: boolean; retainPipes?: boolean; ignoreKill?: boolean }
  let latestResponse: () => Promise<Response>
  let activeJobs: number, maxJobs: number
  const clock = createFakeClock()
  let kills: string[]
  let groupKills: { pid: number; signal: string | number | undefined }[], cancelledPipes: number[]
  const envNames = ['CI_ANTHROPIC_API_KEY', 'CI_ANTHROPIC_MODEL', 'CI_ANTHROPIC_BASE_URL', 'CI_ANTHROPIC_OPUS_MODEL', 'CI_ANTHROPIC_AI_MODEL'] as const
  let oldEnv: Record<string, string | undefined>
  let restore: (() => void)[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'matrix-test-'))
    repo = join(root, 'repo'); output = join(root, 'output')
    for (const dir of ['tests/integration', 'tests/real-agent', 'docker']) mkdirSync(join(repo, dir), { recursive: true })
    for (const name of gateNames()) writeFileSync(join(repo, 'tests/integration', name), '')
    for (const name of heavyNames()) writeFileSync(join(repo, 'tests/real-agent', name), '')
    stdout = []; calls = []; kills = []; stage = undefined; activeJobs = 0; maxJobs = 0
    groupKills = []; cancelledPipes = []
    oldEnv = Object.fromEntries(envNames.map(n => [n, process.env[n]]))
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
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, ms: number) => clock.setTimeout(cb, ms)) as unknown as typeof setTimeout)
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(handle => clock.clearTimeout(handle))
    restore.push(() => timerSpy.mockRestore(), () => clearSpy.mockRestore())
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((argv: string[], options: { env?: Record<string, string | undefined>; detached?: boolean }) => {
      const pid = 600_000 + calls.length
      calls.push({ argv: [...argv], key: options.env?.ANTHROPIC_API_KEY, model: options.env?.ANTHROPIC_MODEL, aiModel: options.env?.REAL_AGENT_AI_MODEL, pid, detached: options.detached, tmpdir: options.env?.TMPDIR })
      stage = options.env?.TMPDIR
      const isJob = argv[0] === 'docker' && argv[1] === 'run'
      if (isJob) { activeJobs++; maxJobs = Math.max(maxJobs, activeJobs) }
      if (argv[0] === 'bun') {
        const archive = argv[argv.indexOf('--filename') + 1]!
        stage = dirname(archive); writeFileSync(archive, 'fake packed production')
      }
      const answer = response(argv)
      let text = answer.text ?? ''
      if (isJob && answer.text === undefined) {
        text = resultsFor(jobForArgv(argv), options.env?.ANTHROPIC_MODEL, options.env?.REAL_AGENT_AI_MODEL).map(resultLine).join('\n') + '\n'
      }
      let finish!: (code: number) => void, stream!: ReadableStreamDefaultController<Uint8Array>
      const exited = new Promise<number>(resolve => { finish = resolve })
      const out = new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller
        if (!answer.hang) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); finish(answer.code ?? 0) }
      }, cancel() { cancelledPipes.push(pid) } })
      return {
        pid, stdout: out, stderr: new ReadableStream({ start(c) { if (!answer.retainPipes) c.close() }, cancel() { cancelledPipes.push(pid) } }),
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
      assertNoLeak(stdout)
      assertNoLeak(calls.map(c => c.argv))
      if (existsSync(output)) assertNoLeak(readdirSync(output).map(n => writtenFile(join(output, n))))
      if (stage) expect(existsSync(stage)).toBe(false)
      expect(clock.pendingCount()).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  const run = (planOnly = false) => runMatrix({ repo, output, planOnly })
  const jobsRun = () => calls.filter(c => c.argv[1] === 'run')
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
    expect(await run()).toBe(true)
    expect(fetches).toBe(1)
    expect(jobsRun()).toHaveLength(3)
    expect(maxJobs).toBe(1)
    expect(calls.filter(c => c.argv[0] === 'bun')).toHaveLength(1)
    expect(calls.filter(c => c.argv.slice(0, 3).join(' ') === 'docker rm -f')).toHaveLength(3)
    expect(calls.at(-1)!.argv.slice(0, 3)).toEqual(['docker', 'image', 'rm'])
    const count = plan().reduce((sum, j) => sum + j.invocations.length, 0)
    const totals = JSON.parse(stdout.find(l => l.startsWith('tokens: '))!.slice('tokens: '.length))
    expect(totals).toEqual({ input: count * 7, output: count * 3, cache_read: count * 5, cache_creation: count, duplicates: count * 2 })
    expect(stdout.filter(l => /^REAL-AGENT-VERDICT /.test(l))).toHaveLength(1)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT PASS /)
    const reports = readdirSync(output).filter(n => n.startsWith('job-'))
    expect(reports).toHaveLength(3)
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
      if (argv[1] !== 'run') return {}
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

  test.each(['timeout', 'SIGTERM'] as const)('%s kills the active child and cleans up without starting the next version', async kind => {
    let unrelatedSignals = 0
    const unrelated = () => { unrelatedSignals++ }
    process.on('SIGTERM', unrelated)
    restore.push(() => { process.off('SIGTERM', unrelated) })
    const before = process.listenerCount('SIGTERM')
    const signalHandlers = process.listeners('SIGTERM')
    response = argv => argv[1] === 'run' ? { hang: true } : {}
    const pending = run()
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
    expect(active.detached).toBe(true)
    expect(active.tmpdir).toBe(ownedStage)
    if (kind === 'timeout') await clock.advance(step === 'job' ? MATRIX_TIMEOUT_MS : 30 * 60_000)
    else interruptMatrix(signalHandlers)
    await clock.flush()
    expect(settled).toBe(false)
    expect(groupKills).toEqual([{ pid: -active.pid, signal: kind === 'timeout' ? 'SIGKILL' : 'SIGTERM' }])
    await clock.advance(999)
    expect(settled).toBe(false)
    await clock.advance(1)
    expect(settled).toBe(true)
    expect(await pending).toBe(false)
    expect(groupKills).toEqual([
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
      if (argv[1] !== 'run') return {}
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
      if (argv[1] !== 'run') return {}
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
    expect(rows.filter(r => r.script.includes('-ai-ac')).every(r => r.model === selected)).toBe(true)
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
      if (argv[1] !== 'run') return {}
      const job = jobForArgv(argv), rows = resultsFor(job, model, selected)
      const at = job.invocations.findIndex(i => (i.model === 'opus') === (kind === 'AI'))
      if (at < 0) return { text: rows.map(resultLine).join('\n') }
      rows[at]!.model = kind === 'AI' ? model : selected
      return { text: rows.map(resultLine).join('\n') }
    }
    expect(await run()).toBe(false)
    expect(stdout.at(-1)).toMatch(/^REAL-AGENT-VERDICT FAIL /)
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
