#!/usr/bin/env bun
/** Local sequential heavy coordinator; never discovered by /ci (b.omv SR-14.4).
 * Future scheduler jobs use SCHEDULER_JOB_CONTRACT once secrets are supported;
 * this runner deliberately submits no scheduler work. E7 can extend the
 * manifest with a local-only agent leg without changing Claude's contract.
 */
import { closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { CPUS_PER_SHARD, SHARD_MEMORY_CAP_BYTES, SHARD_PIDS_LIMIT, checkShardRunList, maskScannedValues, scannedSecretValues } from './ci-run.ts'

export const MATRIX_VERSIONS = ['2.1.280', '2.1.296'] as const
export const GATE_SLUGS = ['order', 'keys', 'compact', 'restarts', 'crash', 'mcp', 'cron', 'fidelity', 'downgrade'] as const
export const HEAVY_SCRIPTS = [
  'test-101-fmk-real-busy.sh', 'test-102-fmk-real-replies.sh', 'test-103-fmk-real-latency100.sh',
  'test-104-fmk-real-idle-compact.sh',
] as const
export const AI_CRITERIA = [11, 12, 15, 20, 23, 91, 106] as const
export const AI_VERSION = MATRIX_VERSIONS[1]
// Local jobs obey the committed /ci shard caps. The future scheduler's
// distinct 8GiB/4CPU reservation is recorded below (b.omv SR-14.4).
export const MATRIX_MEMORY = String(SHARD_MEMORY_CAP_BYTES)
export const MATRIX_CPUS = CPUS_PER_SHARD
export const MATRIX_TIMEOUT_MS = 3 * 60 * 60 * 1000
export const SCHEDULER_JOB_CONTRACT = {
  memory: '8GiB', cpus: 4, timeout: '3h', network: 'on',
  secret: 'env:CI_ANTHROPIC_API_KEY:ANTHROPIC_API_KEY',
  plainEnv: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'REAL_AGENT_AI_MODEL'],
  context: ['package.tgz', 'tests', 'docker', 'pinned agent-director binary and client'],
} as const
// Retain the manifest's historical 'opus' selector for compatibility. It now
// means the explicitly selected AI model, without imposing a model family.
export interface MatrixInvocation { script: string; trial: number; model: 'default' | 'opus' }
export interface MatrixJob { version: string; runtimeLatest: boolean; invocations: MatrixInvocation[] }
export interface LocalAgentExtension { agent: string; localOnly: true; invocations: readonly MatrixInvocation[] }
export interface MatrixResult {
  script: string; trial: number; version: string; model: string; exit: number; reported: boolean
  duplicates: number | null; tokens: { input: number; output: number; cache_read: number; cache_creation: number } | null
}
function exactVersion(value: string): boolean { return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value) && !/[\r\n]/.test(value) }
export function safeModel(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value) && !/[\r\n]/.test(value) }
function gateScript(value: string): boolean { return /^integration\/test-[0-9]+-fmk-real-[a-z0-9-]+\.sh$/.test(value) && GATE_SLUGS.some(slug => value.endsWith(`-fmk-real-${slug}.sh`)) }
function heavyScript(value: string): boolean { return [...HEAVY_SCRIPTS, ...AI_CRITERIA.map(ac => `test-${100 + ac}-fmk-real-ai-ac${ac}.sh`)].some(file => value === `real-agent/${file}`) }
export function discoverGateScripts(names: readonly string[]): string[] {
  const real = names.filter(n => /^test-\d+-fmk-real-[a-z0-9-]+\.sh$/.test(n) && !n.endsWith('-codex.sh'))
  if (real.length !== GATE_SLUGS.length) throw new Error('Expected exactly nine Claude real gate scripts')
  return GATE_SLUGS.map(slug => {
    const found = real.filter(n => n.endsWith(`-fmk-real-${slug}.sh`))
    if (found.length !== 1) throw new Error(`Expected one real gate script for ${slug}`)
    return `integration/${found[0]}`
  })
}
export function matrixPlan(latest: string, gates: string[], heavyNames: readonly string[]): MatrixJob[] {
  if (!exactVersion(latest)) throw new Error('Runtime latest is not an exact version')
  if (gates.length !== GATE_SLUGS.length || gates.some((script, i) => !gateScript(script) || !script.endsWith(`-fmk-real-${GATE_SLUGS[i]}.sh`))) throw new Error('Invalid real gate script list')
  const available = new Set(heavyNames)
  const required = [...HEAVY_SCRIPTS, ...AI_CRITERIA.map(ac => `test-${100 + ac}-fmk-real-ai-ac${ac}.sh`)]
  for (const file of required) if (!available.has(file)) throw new Error(`Required heavy scenario is absent: ${file}`)
  const invocations: MatrixInvocation[] = [
    ...gates.map(script => ({ script, trial: 1, model: 'default' as const })),
    ...HEAVY_SCRIPTS.slice(0, 2).map(file => ({ script: `real-agent/${file}`, trial: 1, model: 'default' as const })),
    { script: `real-agent/${HEAVY_SCRIPTS[3]}`, trial: 1, model: 'default' as const },
  ]
  // Keep three jobs even if latest equals a pin: runtime-latest remains an
  // independently executed job whose actual native version is recorded.
  return [...MATRIX_VERSIONS, latest].map((version, i) => ({ version, runtimeLatest: i === 2, invocations: [
    ...invocations.map(x => ({ ...x })),
    // The seven criteria have three trials total, on the stable gate version.
    // Runtime-latest never repeats them, even when it resolves to this pin.
    ...(i < 2 && version === AI_VERSION ? [
      { script: `real-agent/${HEAVY_SCRIPTS[2]}`, trial: 1, model: 'default' as const },
      ...AI_CRITERIA.flatMap(ac => [1, 2, 3].map(trial => ({ script: `real-agent/test-${100 + ac}-fmk-real-ai-ac${ac}.sh`, trial, model: 'opus' as const }))),
    ] : []),
  ] }))
}
export function parseResultLine(line: string, secrets: readonly string[] = []): MatrixResult | null {
  if (!line.startsWith('real-agent-result: ')) return null
  let value: MatrixResult
  try { value = JSON.parse(line.slice('real-agent-result: '.length)) as MatrixResult }
  catch { throw new Error('Malformed real-agent-result record') }
  if (!value || Object.keys(value).sort().join(',') !== 'duplicates,exit,model,reported,script,tokens,trial,version'
    || typeof value.script !== 'string' || (!gateScript(value.script) && !heavyScript(value.script))
    || ![1, 2, 3].includes(value.trial) || typeof value.version !== 'string' || !exactVersion(value.version)
    || typeof value.model !== 'string' || !safeModel(value.model)
    || !Number.isSafeInteger(value.exit) || value.exit < 0 || value.exit > 255 || typeof value.reported !== 'boolean'
    || (value.duplicates === null ? value.reported : !Number.isSafeInteger(value.duplicates) || value.duplicates < 0)
    || (value.tokens === null ? value.reported : !value.tokens || Object.keys(value.tokens).sort().join(',') !== 'cache_creation,cache_read,input,output'
      || Object.values(value.tokens).some(v => !Number.isSafeInteger(v) || v < 0))
    || secrets.some(secret => secret && [value.script, value.version, value.model].some(field => field.includes(secret)))) throw new Error('Malformed real-agent-result record')
  return { script: value.script, trial: value.trial, version: value.version, model: value.model, exit: value.exit,
    reported: value.reported, duplicates: value.duplicates, tokens: value.tokens === null ? null : { input: value.tokens.input, output: value.tokens.output,
      cache_read: value.tokens.cache_read, cache_creation: value.tokens.cache_creation } }
}
export function assertJobComplete(job: MatrixJob, results: readonly MatrixResult[], model: string, aiModel: string): void {
  if (results.length !== job.invocations.length) throw new Error('Matrix job omitted required scenarios/trials')
  job.invocations.forEach((invocation, i) => {
    const result = results[i]!
    if (result.script !== invocation.script || result.trial !== invocation.trial || result.version !== job.version
      || result.model !== (invocation.model === 'opus' ? aiModel : model) || result.exit !== 0 || !result.reported) throw new Error('Matrix scenario/trial did not pass its required contract')
  })
}
export function matrixDockerArgs(name: string, image: string, job: MatrixJob): string[] {
  return ['run', '--init', '--log-driver', 'none', '--name', name,
    '--memory', MATRIX_MEMORY, '--memory-swap', MATRIX_MEMORY, '--cpus', String(MATRIX_CPUS), '--pids-limit', String(SHARD_PIDS_LIMIT),
    ...['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'REAL_AGENT_AI_MODEL'].flatMap(key => ['--env', key]),
    image, job.version, job.runtimeLatest ? '1' : '0', ...job.invocations.map(i => `${i.script}:${i.trial}:${i.model}`)]
}
export interface MatrixOptions { output: string; repo: string; planOnly: boolean }
/** Resolve existing ancestors too: output need not exist yet, but a link may. */
function resolvedPath(path: string): string {
  let parent = resolve(path)
  const missing: string[] = []
  while (true) {
    try { lstatSync(parent); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Matrix output must be outside the checkout and /test-results in a writable directory')
      missing.unshift(basename(parent))
      const next = dirname(parent)
      if (next === parent) throw new Error('Matrix output directory cannot be resolved')
      parent = next
    }
  }
  try { return resolve(realpathSync(parent), ...missing) }
  catch { throw new Error('Matrix output must be outside the checkout and /test-results in a writable directory') }
}
function outputDirectory(output: string, repo: string): string {
  const lexical = resolve(output), physical = resolvedPath(lexical)
  const roots = [resolve(repo), resolvedPath(repo), '/test-results', resolvedPath('/test-results')]
  if (roots.some(root => [lexical, physical].some(path => path === root || path.startsWith(root + '/')))) throw new Error('Matrix output must be outside the checkout and /test-results')
  return physical
}
function writePrivate(path: string, content: string, secrets: readonly string[]): void {
  if (secrets.some(secret => content.includes(secret) || content.includes(JSON.stringify(secret).slice(1, -1)))) throw new Error('Matrix artifact contains a secret')
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, content) } finally { closeSync(fd) }
}
export function matrixOptions(args: readonly string[], repo = resolve(dirname(import.meta.path), '..')): MatrixOptions {
  let output = join(tmpdir(), `cscb-real-agent-${new Date().toISOString().replace(/[^0-9]/g, '')}`), planOnly = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan') planOnly = true
    else if (args[i] === '--output' && args[i + 1]) output = resolve(args[++i]!)
    else throw new Error('Usage: bun scripts/real-agent-matrix.ts [--output DIR] [--plan]')
  }
  // Never permit secrets/logs inside the source checkout, nor /test-results.
  outputDirectory(output, repo)
  return { output, repo, planOnly }
}
export async function runMatrix(options: MatrixOptions): Promise<boolean> {
  const key = process.env.CI_ANTHROPIC_API_KEY ?? '', model = process.env.CI_ANTHROPIC_MODEL ?? ''
  // Decision 19: an owner-selected available model can run the AI trials.
  // This is explicit routing, never a refusal-triggered or hidden fallback.
  const explicitAiModel = process.env.CI_ANTHROPIC_AI_MODEL
  const aiModel = explicitAiModel ?? model
  const secrets = scannedSecretValues(process.env, { shardVariables: { CI_ANTHROPIC_API_KEY: key } })
  if (!options.planOnly && (!key || !model || (!key.startsWith('sk-ant-') && !process.env.CI_ANTHROPIC_BASE_URL))) throw new Error('CI_ANTHROPIC_API_KEY, CI_ANTHROPIC_MODEL and gateway base URL are required')
  if ((model && !safeModel(model)) || (explicitAiModel !== undefined && !safeModel(explicitAiModel))
    || secrets.some(secret => [model, aiModel].some(value => value.includes(secret)))) throw new Error('Invalid matrix model identifier')
  let output = outputDirectory(options.output, options.repo)
  mkdirSync(output, { recursive: true, mode: 0o700 })
  output = outputDirectory(output, options.repo)
  const logFd = openSync(join(output, 'run.log'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  // JSON-escaped copies are masked too, before any child line reaches a sink.
  const masks = [...secrets, ...secrets.map(secret => JSON.stringify(secret).slice(1, -1))]
  const redact = (value: string) => maskScannedValues(value, masks)
  const say = (line: string) => { const safe = redact(line); process.stdout.write(safe + '\n'); writeFileSync(logFd, safe + '\n') }
  const runId = `real-${Date.now()}-${process.pid}`
  const stage = mkdtempSync(join(tmpdir(), 'cscb-real-context-'))
  let stopped = false
  let terminateActive: (() => void) | undefined
  const aborted = new AbortController()
  // Every child is its own process-group leader. Killing only bash leaves
  // docker (and inherited pipe descriptors) alive after a build timeout.
  const killGroup = (child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals) => {
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      try { process.kill(-child.pid, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    try { child.kill(signal) } catch { /* the group may have already exited */ }
  }
  // Own nested mktemp contexts too (notably ci-base-build.sh's extracted
  // install script), even when SIGKILL prevents a shell's normal cleanup.
  const childEnv = { ...process.env, TMPDIR: stage, ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: process.env.CI_ANTHROPIC_BASE_URL ?? '', ANTHROPIC_MODEL: model, REAL_AGENT_AI_MODEL: aiModel }
  const run = async (argv: string[], timeoutMs: number, collect = false, cleanup = false): Promise<{ code: number; text: string }> => {
    if (stopped && !cleanup) throw new Error('Matrix interrupted')
    if (!checkShardRunList(argv, secrets).ok) throw new Error('Matrix child argument list contains a secret')
    const child = Bun.spawn(argv, { cwd: options.repo, env: childEnv, stdout: 'pipe', stderr: 'pipe', detached: true })
    let finishTermination!: (code: number) => void, forced = false, consuming = true
    const termination = new Promise<number>(resolve => { finishTermination = resolve })
    const terminate = (signal: NodeJS.Signals, code: number) => {
      forced = true
      killGroup(child, signal)
      finishTermination(code)
    }
    const stop = () => terminate('SIGTERM', 143)
    terminateActive = stop
    const timer = setTimeout(() => terminate('SIGKILL', 124), timeoutMs)
    let output = ''
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(), decoder = new TextDecoder(); let pending = ''
      readers.push(reader)
      try {
        while (consuming) {
          const { done, value } = await reader.read()
          if (done || !consuming) break
          pending += decoder.decode(value, { stream: true })
          let n: number
          while ((n = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, n); pending = pending.slice(n + 1); say(line); if (collect) output += line + '\n' }
        }
        pending += decoder.decode()
        if (consuming && pending) { say(pending); if (collect) output += pending + '\n' }
      } finally { reader.releaseLock() }
    }
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const streams = Promise.all([consume(child.stdout), consume(child.stderr)])
    // Observe failures immediately even while waiting for process exit.
    void streams.catch(() => {})
    try {
      const code = await Promise.race([child.exited, termination])
      let drained = false
      await Promise.race([
        streams.then(() => { drained = true }),
        new Promise<void>(resolve => { drainTimer = setTimeout(resolve, 1000) }),
      ])
      if (forced || !drained) {
        killGroup(child, 'SIGKILL')
        consuming = false
        for (const reader of readers) void reader.cancel().catch(() => {})
      }
      return { code: forced ? (stopped ? 143 : 124) : code, text: output }
    } catch (error) {
      killGroup(child, 'SIGKILL')
      throw error
    } finally {
      consuming = false
      for (const reader of readers) void reader.cancel().catch(() => {})
      clearTimeout(timer)
      clearTimeout(drainTimer)
      if (terminateActive === stop) terminateActive = undefined
    }
  }
  const interrupt = () => { stopped = true; aborted.abort(); terminateActive?.() }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  let passed = false, planned = false
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, duplicates: 0 }
  try {
    const latestResponse = await fetch('https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest', { signal: AbortSignal.any([aborted.signal, AbortSignal.timeout(30_000)]) })
    if (!latestResponse.ok) throw new Error('Could not resolve native runtime-latest')
    const latest = (await latestResponse.text()).trim()
    if (stopped) throw new Error('Matrix interrupted')
    const gates = discoverGateScripts(readdirSync(join(options.repo, 'tests/integration')))
    const heavyDir = join(options.repo, 'tests/real-agent')
    const jobs = matrixPlan(latest, gates, existsSync(heavyDir) ? readdirSync(heavyDir) : [])
    say(`recorded: matrix ${JSON.stringify({ runId, latest, model, aiModel, jobs: jobs.map(j => ({ version: j.version, runtimeLatest: j.runtimeLatest, scenarios: j.invocations.length })) })}`)
    writePrivate(join(output, 'plan.json'), JSON.stringify({ runId, model, aiModel, jobs, scheduler: SCHEDULER_JOB_CONTRACT }, null, 2) + '\n', secrets)
    if (options.planOnly) { planned = true; return true }
    if ((await run(['docker', 'image', 'inspect', 'cscb-ci-base:v8', '--format', '{{.Id}}'], 30_000)).code !== 0) {
      if ((await run(['bash', 'scripts/ci-base-build.sh'], 30 * 60_000)).code !== 0) throw new Error('Heavy base build failed')
    }
    if ((await run(['bun', 'pm', 'pack', '--ignore-scripts', '--filename', join(stage, 'package.tgz'), '--quiet'], 120_000)).code !== 0) throw new Error('Packing production failed')
    const packageSha256 = createHash('sha256').update(readFileSync(join(stage, 'package.tgz'))).digest('hex')
    say(`recorded: packed production sha256=${packageSha256}`)
    cpSync(join(options.repo, 'tests'), join(stage, 'tests'), { recursive: true })
    cpSync(join(options.repo, 'docker'), join(stage, 'docker'), { recursive: true })
    const image = `cscb-real-agent:${runId}`
    try {
      if ((await run(['docker', 'build', '-f', join(stage, 'docker/Dockerfile.real-agent'), '-t', image, stage], 15 * 60_000)).code !== 0) throw new Error('Heavy image build failed')
      for (let index = 0; index < jobs.length; index++) {
        if (stopped) throw new Error('Matrix interrupted')
        const job = jobs[index]!, name = `${runId}-${index + 1}`
        say(`recorded: matrix-job ${JSON.stringify({ index: index + 1, version: job.version, runtimeLatest: job.runtimeLatest })}`)
        try {
          const answer = await run(['docker', ...matrixDockerArgs(name, image, job)], MATRIX_TIMEOUT_MS, true)
          const results: MatrixResult[] = []
          for (const line of answer.text.split('\n')) {
            const result = parseResultLine(line, secrets)
            if (!result) continue
            results.push(result)
            // Failed jobs still spent tokens: retain every valid usage report.
            if (result.duplicates !== null) totals.duplicates += result.duplicates
            if (result.tokens !== null) for (const field of ['input', 'output', 'cache_read', 'cache_creation'] as const) totals[field] += result.tokens[field]
            if (result.tokens === null || result.duplicates === null) say('recorded: matrix usage report incomplete; totals include observed reports only')
          }
          if (answer.code !== 0 || stopped) throw new Error(`Matrix job ${index + 1} failed (exit ${answer.code})`)
          assertJobComplete(job, results, model, aiModel)
          writePrivate(join(output, `job-${index + 1}.json`), JSON.stringify({ version: job.version, runtimeLatest: job.runtimeLatest, packageSha256, results }, null, 2) + '\n', secrets)
        } finally {
          const cleanup = await run(['docker', 'rm', '-f', name], 30_000, false, true)
          if (cleanup.code !== 0) throw new Error('Matrix container cleanup failed')
        }
      }
      passed = true
    } finally {
      if ((await run(['docker', 'image', 'rm', image], 30_000, false, true)).code !== 0) throw new Error('Matrix image cleanup failed')
    }
  } catch (error) { passed = false; say(`FAIL: real-agent-matrix: ${error instanceof Error ? error.message : 'unknown failure'}`) }
  finally {
    rmSync(stage, { recursive: true, force: true })
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
    if (planned) say(`REAL-AGENT-PLAN ${runId}`)
    else {
      say(`tokens: ${JSON.stringify(totals)}`)
      say(`REAL-AGENT-VERDICT ${passed ? 'PASS' : 'FAIL'} ${runId}`)
    }
    closeSync(logFd)
  }
  return passed
}
if (import.meta.main) {
  if (process.argv.includes('--help')) { console.log('bun scripts/real-agent-matrix.ts [--output DIR] [--plan]'); process.exit(0) }
  try { const options = matrixOptions(process.argv.slice(2)); const passed = await runMatrix(options); process.exit(passed ? 0 : 1) }
  catch { console.error('FAIL: real-agent-matrix: preflight refused; check credentials, model and output directory'); console.error('REAL-AGENT-VERDICT FAIL preflight'); process.exit(1) }
}
