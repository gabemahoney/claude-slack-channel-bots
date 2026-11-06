/**
 * tests/fixtures/ad-gate/fake-jobsched.ts — a recording stand-in for the
 * job-scheduler CLI (`jobsched list|submit|status|results|wait`), for the
 * command-line runs in tests/ad-gate.test.ts. It schedules nothing: `submit`
 * writes the run.log entry.sh would print for the shard at once. Jobs end
 * immediately by default; `waitBatches` instead ends the named jobs on each
 * successive successful wait, leaving the others running. Once the batches
 * are exhausted, waits end all requested jobs. `list --json` reports the
 * scenario's slots (6, none active or queued, by default), its raw
 * `listOutput`, or, with `listFails`, fails.
 *
 * Reads the scenario named by `AD_GATE_FAKE_SCENARIO` (`FakeScenario` in
 * tests/ad-gate.test.ts), appends each call's arguments to `jobsched-calls.jsonl`
 * beside it and keeps its jobs under `jobs/` there. A script fails when the
 * scenario fails it for the job's role (`cand`/`ref`, from `--name`) and, with
 * `onlyRelease`, for that CSCB release's jobs alone, or when the job's
 * `GATE_INJECT_FAIL` names it; every other script passes. The scenario's
 * evidence switches, each naming a role, make that role's jobs report an OOM
 * kill, keep no result.json, or show `status` a wrong name, a wrong context
 * directory or a context hash of their own. Runs no child.
 *
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

type Role = 'cand' | 'ref'

interface Scenario {
  readonly fail: Readonly<Record<Role, readonly string[]>>
  readonly onlyRelease?: string
  readonly slots?: { readonly limit: number; readonly active: number; readonly queued: number }
  readonly listOutput?: string
  readonly listFails?: boolean
  readonly badManifestLine?: Role
  readonly failWaitOnce?: boolean
  readonly waitBatches?: readonly (readonly string[])[]
  readonly oomKilled?: Role
  readonly noResult?: Role
  readonly wrongName?: Role
  readonly wrongContextDir?: Role
  readonly contextHashDiffers?: Role
}

interface Job {
  readonly id: string
  readonly name: string
  readonly context: string
  readonly role: Role
  readonly state: 'succeeded' | 'failed'
  readonly exitCode: number
  readonly ended: boolean
}

const scenarioPath = process.env['AD_GATE_FAKE_SCENARIO'] ?? ''
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as Scenario
const dir = dirname(scenarioPath)
const jobsDir = join(dir, 'jobs')
const [command, ...args] = process.argv.slice(2)
appendFileSync(join(dir, 'jobsched-calls.jsonl'), `${JSON.stringify(process.argv.slice(2))}\n`)

/** The values of a repeatable option before `--`. */
function optionValues(options: readonly string[], flag: string): string[] {
  return options.flatMap((arg, index) => (options[index - 1] === flag ? [arg] : []))
}

function jobPath(id: string, suffix: string): string {
  return join(jobsDir, `${id}${suffix}`)
}

function readJob(id: string): Job {
  if (!existsSync(jobPath(id, '.json'))) {
    process.stderr.write(`fake jobsched: unknown job ${id}\n`)
    process.exit(3)
  }
  return JSON.parse(readFileSync(jobPath(id, '.json'), 'utf8')) as Job
}

/** Whether `file` is one of `names`, given as test-<n> or as the file name. */
function named(file: string, names: readonly string[]): boolean {
  return names.some((name) => file === name || file.startsWith(`${name}-`))
}

function submit(): void {
  const end = args.indexOf('--')
  const options = args.slice(0, end)
  const scripts = args.slice(end + 1)
  const name = optionValues(options, '--name')[0]
  const context = optionValues(options, '--context')[0]
  const [, release, role] = /^adg-(.+)-(cand|ref)-s[0-9]+$/.exec(name) as unknown as [string, string, Role]
  const env = new Map(optionValues(options, '--env').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
  const injected = (env.get('GATE_INJECT_FAIL') ?? '').split(' ').filter((word) => word !== '')
  const failed = scenario.onlyRelease === undefined || scenario.onlyRelease === release ? scenario.fail[role] : []
  const failing = scripts.filter((file) => named(file, failed) || injected.includes(file))
  const filter = env.get('GATE_FILTER') === '1' ? 'pass' : 'skipped'
  const passed = failing.length === 0

  const manifest = JSON.parse(readFileSync(join(context, 'inputs', 'manifest.json'), 'utf8')) as Record<string, unknown>
  const shown = scenario.badManifestLine === role ? { ...manifest, ad_role: 'tampered' } : manifest
  const runLog = [
    'ad-gate: subject: claude-slack-channel-bots fixture vs agent-director fixture (000000000000)',
    `ad-gate: manifest: ${JSON.stringify(shown)}`,
    ...scripts.map((file) => `AD-GATE-EXPECT ${file}`),
    ...scripts.map((file) => `AD-GATE-SCRIPT ${file} ${failing.includes(file) ? 'fail' : 'pass'} 1.500`),
    'AD-GATE-RUNNER done',
    `AD-GATE-FILTER ${filter}`,
    passed ? 'AD-GATE PASS: fixture' : 'AD-GATE FAIL: fixture',
    '',
  ].join('\n')

  mkdirSync(jobsDir, { recursive: true })
  const count = readdirSync(jobsDir).filter((entry) => entry.endsWith('.json') && !entry.endsWith('.result.json')).length
  const id = `j20261106000000-${(count + 1).toString(16).padStart(6, '0')}`
  const job: Job = { id, name, context, role, state: passed ? 'succeeded' : 'failed', exitCode: passed ? 0 : 1, ended: scenario.waitBatches === undefined }
  const oomKilled = scenario.oomKilled === role
  writeFileSync(jobPath(id, '.run.log'), runLog)
  if (scenario.noResult !== role) {
    writeFileSync(jobPath(id, '.result.json'), JSON.stringify({ oom_killed: oomKilled, oom_notes: oomKilled ? ['fixture: an OOM kill in the container'] : [] }))
  }
  writeFileSync(jobPath(id, '.json'), JSON.stringify(job))
  process.stdout.write(`${id}\n`)
}

function status(id: string): void {
  const job = readJob(id)
  process.stdout.write(
    JSON.stringify({
      id,
      state: job.ended ? job.state : 'running',
      terminal: job.ended,
      exit_code: job.ended ? job.exitCode : null,
      name: scenario.wrongName === job.role ? `${job.name}-other` : job.name,
      context_dir: scenario.wrongContextDir === job.role ? `${job.context}-other` : job.context,
      context_sha256: createHash('sha256')
        .update(scenario.contextHashDiffers === job.role ? `${job.context} ${job.id}` : job.context)
        .digest('hex'),
      queued_s: 1,
      build_s: 2,
      run_s: 3,
      peak_memory: 1048576,
      remote_host: 'fixture-host',
      reason: null,
      submitted_at: '2026-11-06T00:00:00Z',
      ended_at: job.ended ? '2026-11-06T00:00:06Z' : null,
      queue_position: null,
      dispatcher_running: true,
    }),
  )
}

function results(id: string): void {
  const job = readJob(id)
  process.stdout.write(
    JSON.stringify({
      paths: { run_log: jobPath(id, '.run.log'), result: jobPath(id, '.result.json') },
      present: { run_log: true, result: scenario.noResult !== job.role },
    }),
  )
}

function wait(): void {
  const marker = join(dir, 'wait-failed-once')
  if (scenario.failWaitOnce === true && !existsSync(marker)) {
    writeFileSync(marker, '')
    process.stderr.write('fake jobsched: wait interrupted\n')
    process.exit(1)
  }
  const ids = args.filter((arg) => /^j[0-9]{14}-[0-9a-f]{6}$/.test(arg))
  let batch: readonly string[] | undefined
  if (scenario.waitBatches !== undefined) {
    const countPath = join(dir, 'wait-count.json')
    const count = existsSync(countPath) ? JSON.parse(readFileSync(countPath, 'utf8')) as number : 0
    batch = scenario.waitBatches[count]
    writeFileSync(countPath, JSON.stringify(count + 1))
  }
  const ended = ids.map(readJob).flatMap((job) => {
    if (!job.ended && batch !== undefined && !batch.includes(job.name)) return []
    if (!job.ended) writeFileSync(jobPath(job.id, '.json'), JSON.stringify({ ...job, ended: true }))
    return [{ id: job.id, state: job.state }]
  })
  process.stdout.write(JSON.stringify({ jobs: ended }))
}

function list(): void {
  if (scenario.listFails === true) {
    process.stderr.write('fake jobsched: list refused\n')
    process.exit(4)
  }
  if (scenario.listOutput !== undefined) {
    process.stdout.write(scenario.listOutput)
    return
  }
  const slots = scenario.slots ?? { limit: 6, active: 0, queued: 0 }
  process.stdout.write(
    JSON.stringify({ summary: { dispatcher_running: true, active_slots_used: slots.active, active_slots_limit: slots.limit, queued: slots.queued }, jobs: [] }),
  )
}

if (command === 'list') list()
else if (command === 'submit') submit()
else if (command === 'status') status(args[args.length - 1])
else if (command === 'results') results(args[args.length - 1])
else if (command === 'wait') wait()
else {
  process.stderr.write(`fake jobsched: no command ${JSON.stringify(command)}\n`)
  process.exit(2)
}
