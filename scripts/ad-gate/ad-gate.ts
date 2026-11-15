#!/usr/bin/env bun
/**
 * scripts/ad-gate/ad-gate.ts — the agent-director (AD) release gate: the
 * shipped claude-slack-channel-bots (CSCB) release against a candidate AD
 * build, on CSCB's no-model integration scripts, sharded across job-scheduler
 * jobs (Bug b.fr9).
 *
 * Usage:
 *   bun scripts/ad-gate/ad-gate.ts --candidate-dist DIR --candidate-version X.Y.Z
 *     --channel ID --out DIR [options]   (`--help` lists every option)
 *
 * For the CSCB releases (npm `latest` unless `--cscb-version` names others):
 *   1. builds each release's candidate job context under `--out` from
 *      `template/`, with `prepare.sh` fetching every input and writing the
 *      manifest, and checks the inputs against the manifest and the tag;
 *   2. chooses each release's candidate shard count: `--shards`, else the
 *      count from 4 to 6 that finishes soonest on the scheduler's free slots
 *      now (`jobsched list`: slots minus active and queued jobs) shared by
 *      the releases (`fastestShardCount`);
 *   3. plans each release's shards from its tag's own `tests/integration`
 *      headers and `tests/ci-durations.tsv` (ci-run.ts's planner), measured
 *      times winning;
 *   4. submits every release's candidate shards together, one scheduler job
 *      per shard, longest first across releases, and waits on them all with
 *      `jobsched wait --timeout 20m` at a time;
 *   5. as soon as a release's candidate jobs have ended, reads each job's
 *      status, run.log (the only output the scheduler returns) and
 *      result.json (its OOM facts), checks each job is this gate's, and
 *      judges them (`gateVerdict`);
 *   6. only when candidate scripts (never test-1) ran and failed: builds that
 *      release's reference context (an AD release, by default the host's) and
 *      submits just those scripts and their prerequisites at once, sharded the
 *      same way, and judges again when they end;
 *   7. writes each release's `verdict.json` (with the kit's revision and file
 *      hashes and each job's context hash), `report.md` (with the shard
 *      choice) and `measured-durations.tsv`, then the combined verdict.
 * `--dry-run` does steps 1-3, prints the shard choice and every `jobsched
 * submit` command, and submits nothing. `--resume` continues a run recorded
 * in `--out/state.json` without submitting any shard twice, re-checking its
 * recorded plans and reusing its recorded shard choice.
 *
 * Exit status: 0 PASS (or a clean dry run), 1 FAIL, 2 the gate could not run
 * (inputs, prepare or the scheduler refused), 3 NON-RELEASE PASS (a pass of
 * an `--only` or `--inject-fail` run, which is no release verdict), 64 bad
 * arguments.
 *
 * The pure parts (`planShards`, `parseRunLog`, `gateVerdict`,
 * `submitCommands`) are exported for tests/ad-gate.test.ts; importing this
 * module runs nothing. No child gets an `ANTHROPIC_*` or `CI_ANTHROPIC_*`
 * variable, and no job gets a secret.
 *
 * Development-only: not in `package.json` `files`, never shipped.
 *
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  assignShards,
  checkPrerequisiteHeaders,
  DURATION_TABLE_HEADER,
  DURATION_TABLE_PATH,
  fileNameNumber,
  fileNameNumberForm,
  matchScript,
  parseDurationTable,
  parsePrerequisiteLines,
  schedulingUnits,
  SCRIPT_FILE_NAME_PATTERN,
  sortCanonical,
  type PrerequisiteMap,
  type Script,
} from '../ci-run.ts'

// --- Shared types ---

/** Which AD build a run tests: the release candidate or the reference release. */
export type GateRole = 'candidate' | 'reference'

/** A script's outcome as entry.sh reports it. */
export type ScriptOutcome = 'pass' | 'fail' | 'notrun' | 'unfinished'

/** The permission filter regression's outcome in one shard. */
export type FilterOutcome = 'pass' | 'fail' | 'skipped'

const SCRIPT_OUTCOMES: readonly ScriptOutcome[] = ['pass', 'fail', 'notrun', 'unfinished']
const FILTER_OUTCOMES: readonly FilterOutcome[] = ['pass', 'fail', 'skipped']

// --- Planning ---

/** The most shards a gate runs: one per scheduler slot. */
export const MAX_GATE_SHARDS = 6

/** The marker of the native-agent scripts, which need a model key and never run in the gate. */
const REAL_AGENT_MARK = '-fmk-real-'

/** test-13's switch-over installs from the npm registry, and gate jobs have no network. */
const REGISTRY_SCRIPT_NUMBER = 13

/** One tests/integration/test-*.sh at the shipped tag. */
export interface ScriptText {
  readonly fileName: string
  readonly text: string
}

/** What a plan is made from. */
export interface PlanInput {
  /** Every test-*.sh at the tag; the default set drops `-fmk-real-` scripts and test-13. */
  readonly scripts: readonly ScriptText[]
  /** The tag's tests/ci-durations.tsv text; null when the tag has none. */
  readonly durations: string | null
  /** The gate's own measured times, same `script<TAB>seconds` form; its entries win. */
  readonly measured?: string | null
  /** The requested N, 1 to 6. */
  readonly shards: number
  /** A subset (test-<n> or file names): plans these, their prerequisites and test-1. */
  readonly only?: readonly string[]
  /** Whether one shard runs the permission filter regression. */
  readonly filterRegression: boolean
}

/** One shard of a plan. */
export interface PlannedShard {
  /** k, from 1. */
  readonly shard: number
  /** File names in run order, test-1 first. */
  readonly scripts: readonly string[]
  /** The sum of its scripts' estimates. */
  readonly expectedSeconds: number
  /** Whether this shard runs the permission filter regression. */
  readonly filterRegression: boolean
}

/** A plan: every planned script, and the shards that run them. */
export interface ShardPlan {
  /** Every planned file name, in canonical order. */
  readonly scripts: readonly string[]
  readonly shards: readonly PlannedShard[]
}

/** Whether the gate runs a script by default: every no-model script but test-13. */
function inDefaultSet(fileName: string): boolean {
  return !fileName.includes(REAL_AGENT_MARK) && fileNameNumber(fileName) !== REGISTRY_SCRIPT_NUMBER
}

/** A tag's script as ci-run's planner takes it; throws for a name that is no script file name. */
function toScript(fileName: string): Script {
  const number = fileNameNumber(fileName)
  const numberForm = fileNameNumberForm(fileName)
  if (number === null || numberForm === null) throw new Error(`ad-gate: ${JSON.stringify(fileName)} is no script file name, test-<n>-<slug>.sh`)
  return { fileName, number, numberForm }
}

/** `roots` and every script they require, directly or through others; test-1 links are not in the map. */
function withPrerequisites(roots: readonly Script[], all: readonly Script[], prerequisites: PrerequisiteMap): Script[] {
  const chosen = new Map<string, Script>()
  const pending = [...roots]
  for (let script = pending.pop(); script !== undefined; script = pending.pop()) {
    if (chosen.has(script.fileName)) continue
    chosen.set(script.fileName, script)
    for (const name of prerequisites.get(script.fileName) ?? []) {
      const prerequisite = all.find((candidate) => candidate.fileName === name)
      if (prerequisite !== undefined) pending.push(prerequisite)
    }
  }
  return [...chosen.values()]
}

/** Why a script outside the default set cannot run in the gate. */
const NOT_RUNNABLE_TEXT = 'cannot run in the gate: -fmk-real- scripts need a model and test-13 needs the npm registry'

/** The scripts a subset names, each checked: a script of the tag the gate can run. */
function subsetRoots(only: readonly string[], all: readonly Script[]): Script[] {
  return only.map((name) => {
    const script = matchScript(name, all)
    if (script === null) throw new Error(`ad-gate: ${JSON.stringify(name)} names no integration script of the tag`)
    if (!inDefaultSet(script.fileName)) throw new Error(`ad-gate: ${script.fileName} ${NOT_RUNNABLE_TEXT}`)
    return script
  })
}

/** ci-run's note prefix for the tag's table, which a note about the measured times names instead as `--durations`. */
const TABLE_NOTE_PREFIX = `duration table ${DURATION_TABLE_PATH}`

/**
 * Every script's estimate, keyed by file name: the tag's table, then the
 * measured times entry by entry; and both tables' notes (ignored lines, a
 * missing table), the measured table's named as `--durations`. Both tables
 * are read against every script of the tag, so a planned subset adds no note.
 */
function scriptEstimates(input: PlanInput, tagScripts: readonly string[]): { estimates: Map<string, number>; notes: string[] } {
  const table = parseDurationTable(input.durations === null ? { kind: 'missing' } : { kind: 'text', text: input.durations }, tagScripts)
  const estimates = new Map(table.estimates)
  const notes = [...table.notes]
  if (input.measured !== undefined && input.measured !== null) {
    const measured = parseDurationTable({ kind: 'text', text: input.measured }, tagScripts)
    for (const name of tagScripts) {
      const seconds = measured.entries.get(fileNameNumberForm(name) ?? '')
      if (seconds !== undefined) estimates.set(name, seconds)
    }
    notes.push(...measured.notes.map((note) => (note.startsWith(TABLE_NOTE_PREFIX) ? `--durations${note.slice(TABLE_NOTE_PREFIX.length)}` : note)))
  }
  return { estimates, notes }
}

/** `planShards`' plan and the duration tables' notes, which the command line prints. */
export function planShardsWithNotes(input: PlanInput): { plan: ShardPlan; notes: string[] } {
  if (!Number.isSafeInteger(input.shards) || input.shards < 1 || input.shards > MAX_GATE_SHARDS) {
    throw new RangeError(`ad-gate: ${input.shards} shards: the gate runs 1 to ${MAX_GATE_SHARDS}`)
  }
  const all = input.scripts.map((script) => toScript(script.fileName))
  const check = checkPrerequisiteHeaders(all, input.scripts.map((script) => parsePrerequisiteLines(script.fileName, script.text)))
  if (!check.ok) throw new Error(`ad-gate: the tag's prerequisite headers are refused: ${check.failures.map((failure) => failure.reason).join('; ')}`)
  const test1 = matchScript('test-1', all)
  if (test1 === null) throw new Error('ad-gate: the tag has no test-1')

  const roots = input.only === undefined ? all.filter((script) => inDefaultSet(script.fileName)) : subsetRoots(input.only, all)
  const run = withPrerequisites([test1, ...roots], all, check.prerequisites)
  const names = sortCanonical(run.map((script) => script.fileName))
  const units = schedulingUnits(run, check.prerequisites)
  const count = Math.max(1, Math.min(input.shards, units.length))
  const { estimates, notes } = scriptEstimates(input, all.map((script) => script.fileName))
  const assignment = assignShards(test1.fileName, estimates, units, count, null)

  const smallest = Math.min(...assignment.map((entry) => entry.expectedSeconds))
  const filterShard = input.filterRegression ? assignment.find((entry) => entry.expectedSeconds === smallest)?.shard : undefined
  const plan = {
    scripts: names,
    shards: assignment.map((entry) => ({
      shard: entry.shard,
      scripts: entry.assigned,
      expectedSeconds: entry.expectedSeconds,
      filterRegression: entry.shard === filterShard,
    })),
  }
  return { plan, notes }
}

/**
 * Plans a gate run with ci-run.ts's planner: the default set (or `only`),
 * every prerequisite and test-1; scheduling units placed longest first in
 * min(N, units) shards, each test-1 first. With `filterRegression`, the shard
 * with the smallest total (lowest k on a tie) runs the filter regression.
 * Throws for N outside 1 to 6, a prerequisite header ci-run refuses, and a
 * subset name that matches no script the gate can run.
 */
export function planShards(input: PlanInput): ShardPlan {
  return planShardsWithNotes(input).plan
}

/**
 * Every way a plan fails to cover its script list: each listed script but
 * test-1 in exactly one shard, test-1 first in every shard, no shard script
 * outside the list or twice in its shard, shards numbered 1 to n, and at most
 * one filter shard. [] for a sound plan. The verdict and `--resume` both
 * check it, so neither trusts a recorded plan.
 */
export function planProblems(plan: ShardPlan): string[] {
  const problems: string[] = []
  const listed = new Set(plan.scripts)
  const test1 = plan.scripts.find((name) => fileNameNumber(name) === 1)
  if (test1 === undefined) problems.push('the plan lists no test-1')
  if (listed.size !== plan.scripts.length) problems.push('the plan lists a script twice')
  plan.shards.forEach((shard, index) => {
    if (shard.shard !== index + 1) problems.push(`shard ${shard.shard} is numbered out of order (expected ${index + 1})`)
    if (shard.scripts[0] !== test1) problems.push(`shard ${shard.shard} does not run test-1 first`)
    if (new Set(shard.scripts).size !== shard.scripts.length) problems.push(`shard ${shard.shard} names a script twice`)
    for (const file of shard.scripts) if (!listed.has(file)) problems.push(`shard ${shard.shard} runs ${file}, which the plan does not list`)
  })
  for (const file of plan.scripts) {
    if (file === test1) continue
    const count = plan.shards.filter((shard) => shard.scripts.includes(file)).length
    if (count !== 1) problems.push(`${file} is in ${count} shards, not exactly 1`)
  }
  if (plan.shards.length === 0) problems.push('the plan has no shard')
  if (plan.shards.filter((shard) => shard.filterRegression).length > 1) problems.push('more than one shard runs the filter regression')
  return problems
}

// --- run.log ---

/** One `AD-GATE-SCRIPT` line. */
export interface ScriptLine {
  readonly file: string
  readonly outcome: ScriptOutcome
  readonly seconds: number | null
  /** The runner's notrun reason: `dependency:<file>`, `fail-fast` or `unsafe-cleanup`. */
  readonly reason: string | null
}

/**
 * How entry.sh's wait for the runner ended: `done` (its end marker, so its
 * final cleanup was verified), `deadline` (GATE_DEADLINE_S passed with the
 * runner still going) or `exited` (it ended without the marker).
 */
export type RunnerEnd = 'done' | 'deadline' | 'exited'

const RUNNER_ENDS: readonly RunnerEnd[] = ['done', 'deadline', 'exited']

/** Why a run.log is not clean evidence; problems come in line order, `truncated` last. */
export type RunLogProblem =
  | { readonly kind: 'malformed'; readonly line: number; readonly text: string }
  | { readonly kind: 'duplicate-expect' | 'duplicate-script'; readonly file: string }
  | { readonly kind: 'duplicate-filter' | 'duplicate-runner' | 'duplicate-verdict' | 'truncated' }

/** What one shard's run.log says. */
export interface RunLog {
  /** AD-GATE-EXPECT files, in log order, each once. */
  readonly expected: readonly string[]
  /** AD-GATE-SCRIPT lines, in log order, the first line per file only. */
  readonly scripts: readonly ScriptLine[]
  /** The AD-GATE-FILTER line's word. */
  readonly filter: FilterOutcome | null
  /** The AD-GATE-RUNNER line's word. */
  readonly runner: RunnerEnd | null
  /** The verdict line: `AD-GATE PASS:`, `AD-GATE FAIL:`, `AD-GATE FAIL: setup:`. */
  readonly verdict: 'pass' | 'fail' | 'setup-failed' | null
  readonly problems: readonly RunLogProblem[]
}

const EXPECT_KEYWORD = 'AD-GATE-EXPECT'
const SCRIPT_KEYWORD = 'AD-GATE-SCRIPT'
const FILTER_KEYWORD = 'AD-GATE-FILTER'
const RUNNER_KEYWORD = 'AD-GATE-RUNNER'
const GATE_LINE_PREFIX = 'AD-GATE-'
const VERDICT_LINE_PREFIX = 'AD-GATE '
const PASS_VERDICT_PREFIX = 'AD-GATE PASS:'
const FAIL_VERDICT_PREFIX = 'AD-GATE FAIL:'
const SETUP_VERDICT_PREFIX = 'AD-GATE FAIL: setup:'
const NO_SECONDS = '-'
const SECONDS_PATTERN = /^[0-9]+(\.[0-9]+)?$/

/** A verdict line's word, or null for an unknown one. */
function verdictWord(line: string): RunLog['verdict'] {
  if (line.startsWith(PASS_VERDICT_PREFIX)) return 'pass'
  if (line.startsWith(SETUP_VERDICT_PREFIX)) return 'setup-failed'
  if (line.startsWith(FAIL_VERDICT_PREFIX)) return 'fail'
  return null
}

/**
 * An `AD-GATE-SCRIPT` line's fields, or null when malformed: a script file
 * name, a known outcome, seconds (`-` for notrun and unfinished) and a reason
 * exactly when the outcome is notrun.
 */
function scriptLineOf(words: readonly string[]): ScriptLine | null {
  const [, file, outcome, seconds, reason, ...rest] = words
  if (rest.length > 0 || file === undefined || !SCRIPT_FILE_NAME_PATTERN.test(file)) return null
  if (!SCRIPT_OUTCOMES.includes(outcome as ScriptOutcome) || seconds === undefined) return null
  const timed = outcome === 'pass' || outcome === 'fail'
  if (seconds !== NO_SECONDS && !(timed && SECONDS_PATTERN.test(seconds))) return null
  if ((outcome === 'notrun') !== (reason !== undefined && reason !== '')) return null
  return { file, outcome: outcome as ScriptOutcome, seconds: seconds === NO_SECONDS ? null : Number(seconds), reason: reason ?? null }
}

/**
 * Reads a shard's run.log. Only a line beginning `AD-GATE-` or `AD-GATE ` is
 * a gate line; every other line is noise. A gate line of no known form is
 * malformed; a repeated line is a problem and only the first counts; a log
 * with no verdict line is truncated.
 */
export function parseRunLog(text: string): RunLog {
  const expected: string[] = []
  const scripts: ScriptLine[] = []
  let filter: FilterOutcome | null = null
  let runner: RunnerEnd | null = null
  let verdict: RunLog['verdict'] = null
  const problems: RunLogProblem[] = []

  text.split('\n').forEach((line, index) => {
    if (!line.startsWith(GATE_LINE_PREFIX) && !line.startsWith(VERDICT_LINE_PREFIX)) return
    const malformed = (): void => {
      problems.push({ kind: 'malformed', line: index + 1, text: line })
    }
    if (line.startsWith(VERDICT_LINE_PREFIX)) {
      const word = verdictWord(line)
      if (word === null) return malformed()
      if (verdict !== null) return void problems.push({ kind: 'duplicate-verdict' })
      verdict = word
      return
    }
    const words = line.split(' ')
    switch (words[0]) {
      case EXPECT_KEYWORD: {
        const file = words[1]
        if (words.length !== 2 || !SCRIPT_FILE_NAME_PATTERN.test(file)) return malformed()
        if (expected.includes(file)) return void problems.push({ kind: 'duplicate-expect', file })
        expected.push(file)
        return
      }
      case SCRIPT_KEYWORD: {
        const parsed = scriptLineOf(words)
        if (parsed === null) return malformed()
        if (scripts.some((seen) => seen.file === parsed.file)) return void problems.push({ kind: 'duplicate-script', file: parsed.file })
        scripts.push(parsed)
        return
      }
      case FILTER_KEYWORD: {
        if (words.length !== 2 || !FILTER_OUTCOMES.includes(words[1] as FilterOutcome)) return malformed()
        if (filter !== null) return void problems.push({ kind: 'duplicate-filter' })
        filter = words[1] as FilterOutcome
        return
      }
      case RUNNER_KEYWORD: {
        if (words.length !== 2 || !RUNNER_ENDS.includes(words[1] as RunnerEnd)) return malformed()
        if (runner !== null) return void problems.push({ kind: 'duplicate-runner' })
        runner = words[1] as RunnerEnd
        return
      }
      default:
        return malformed()
    }
  })
  if (verdict === null) problems.push({ kind: 'truncated' })
  return { expected, scripts, filter, runner, verdict, problems }
}

// --- The verdict ---

/** One shard job's end, as the scheduler reports it. */
export interface ShardResult {
  readonly shard: number
  readonly jobId: string
  /** The scheduler state: `succeeded`, `failed`, `timed-out`, … */
  readonly state: string
  readonly exitCode: number | null
  /** The job's run.log text; null when the scheduler kept none. */
  readonly runLog: string | null
  /**
   * The scheduler's `oom_killed` (result.json): true when it observed an OOM
   * kill in the container, whatever the state; null when result.json could
   * not be read, so one cannot be ruled out. Both fail the shard. Omitted by
   * a caller that does not report it.
   */
  readonly oomKilled?: boolean | null
}

/** One role's run: its plan and the results of its shard jobs. */
export interface RoleRun {
  readonly plan: ShardPlan
  readonly shards: readonly ShardResult[]
}

export type GateReasonKind =
  | 'manifest-mismatch'
  | 'plan-coverage'
  | 'scheduler-state'
  | 'setup-failed'
  | 'no-run-log'
  | 'log-problem'
  | 'missing-script'
  | 'extra-script'
  | 'duplicate-script'
  | 'unfinished'
  | 'notrun'
  | 'filter'
  | 'candidate-failure'
  | 'reference-incomplete'

/** One reason the gate fails. */
export interface GateReason {
  readonly kind: GateReasonKind
  readonly role: GateRole | null
  readonly shard: number | null
  readonly script: string | null
  readonly detail: string
}

/** The gate's judgement of the evidence so far. */
export interface GateVerdict {
  readonly outcome: 'pass' | 'fail' | 'reference-needed'
  /** With 'reference-needed': the candidate's failed scripts, canonical, each once; else []. */
  readonly referenceScripts: readonly string[]
  /** Candidate fail and notrun scripts the reference excused, canonical. */
  readonly excused: readonly string[]
  /** [] on a pass. */
  readonly reasons: readonly GateReason[]
}

/** The scheduler states whose run.log is evidence: entry.sh exited 0 or 1. */
const EVIDENCE_STATES: ReadonlyMap<string, number> = new Map([
  ['succeeded', 0],
  ['failed', 1],
])

/** entry.sh's exit status when its job could not start. */
const SETUP_EXIT_CODE = 2

const DEPENDENCY_REASON_PREFIX = 'dependency:'

/** Each AD-GATE-RUNNER word but `done`, as a reason states it; null is a log with no such line. */
const RUNNER_END_TEXT: Readonly<Record<Exclude<RunnerEnd, 'done'> | 'none', string>> = {
  deadline: 'the runner was stopped at GATE_DEADLINE_S before its done marker',
  exited: 'the runner ended without its done marker, so its final cleanup was not verified',
  none: 'run.log has no AD-GATE-RUNNER line, so how the runner ended is unknown',
}

/** What one role's shards show. */
interface RoleEvidence {
  /** Reasons the evidence itself fails, whatever the scripts' outcomes. */
  readonly reasons: GateReason[]
  /** Each failed script and the first shard it failed in. */
  readonly failed: Map<string, number>
  /** Each notrun script skipped for a prerequisite other than test-1 that failed in its shard, with that prerequisite. */
  readonly skipped: Map<string, string>
  /** Every outcome each script had, across its shards. */
  readonly outcomes: Map<string, ScriptOutcome[]>
}

/** Whether a file name is test-1's. */
function isTest1File(file: string): boolean {
  return fileNameNumber(file) === 1
}

/**
 * A notrun line's excusing prerequisite: X for `dependency:<X>` when X is not
 * test-1 and X failed in the same shard; else null, and the notrun is never
 * excused (a test-1 failure, fail-fast, unsafe cleanup, or a prerequisite
 * that did not fail).
 */
function excusingPrerequisite(line: ScriptLine, log: RunLog): string | null {
  const prerequisite = line.reason?.startsWith(DEPENDENCY_REASON_PREFIX) ? line.reason.slice(DEPENDENCY_REASON_PREFIX.length) : null
  if (prerequisite === null || isTest1File(prerequisite)) return null
  return log.scripts.some((other) => other.file === prerequisite && other.outcome === 'fail') ? prerequisite : null
}

/** Why a notrun is never excused. */
function notrunDetail(reason: string | null): string {
  const prerequisite = reason?.startsWith(DEPENDENCY_REASON_PREFIX) ? reason.slice(DEPENDENCY_REASON_PREFIX.length) : null
  if (prerequisite !== null && isTest1File(prerequisite)) return 'skipped because test-1 failed; a test-1 failure is never excused'
  return `not run (${reason ?? 'no reason'}); only a skip for a failed prerequisite other than test-1 can be excused`
}

/** The manifest reasons: one per problem. */
export function manifestReasons(problems: readonly string[]): GateReason[] {
  return problems.map((detail) => ({ kind: 'manifest-mismatch', role: null, shard: null, script: null, detail }))
}

/** One planned shard's evidence, added to `evidence`. */
function examineShard(role: GateRole, planned: PlannedShard, result: ShardResult, evidence: RoleEvidence): void {
  const k = planned.shard
  const reason = (kind: GateReasonKind, script: string | null, detail: string): void => {
    evidence.reasons.push({ kind, role, shard: k, script, detail })
  }
  if (result.oomKilled === true) reason('scheduler-state', null, `the scheduler observed an OOM kill in job ${result.jobId}`)
  if (result.oomKilled === null) reason('scheduler-state', null, `job ${result.jobId}'s result.json could not be read, so an OOM kill cannot be ruled out`)
  const expectedExit = EVIDENCE_STATES.get(result.state)
  if (expectedExit === undefined) return reason('scheduler-state', null, `job ${result.jobId} ended ${result.state}`)
  if (result.exitCode === SETUP_EXIT_CODE) return reason('setup-failed', null, `job ${result.jobId} could not start its run (exit 2)`)
  if (result.runLog === null) return reason('no-run-log', null, `job ${result.jobId} left no run.log`)
  const log = parseRunLog(result.runLog)
  if (log.verdict === 'setup-failed') return reason('setup-failed', null, `job ${result.jobId} reports a setup failure`)

  for (const problem of log.problems) {
    if (problem.kind === 'duplicate-script') reason('duplicate-script', problem.file, 'its outcome line appears twice')
    else if (problem.kind === 'malformed') reason('log-problem', null, `run.log line ${problem.line} is malformed: ${problem.text}`)
    else if (problem.kind === 'duplicate-expect') reason('log-problem', problem.file, 'its expect line appears twice')
    else reason('log-problem', null, problem.kind === 'truncated' ? 'run.log has no verdict line (truncated)' : `run.log has a second ${problem.kind.slice('duplicate-'.length)} line`)
  }
  const verdictExit = log.verdict === 'pass' ? 0 : log.verdict === 'fail' ? 1 : null
  if (verdictExit !== null && (verdictExit !== expectedExit || result.exitCode !== expectedExit)) {
    reason('scheduler-state', null, `the scheduler says ${result.state} (exit ${result.exitCode ?? 'none'}) but run.log's verdict is ${log.verdict}: the evidence disagrees`)
  }
  if (log.runner !== 'done') reason('unfinished', null, RUNNER_END_TEXT[log.runner ?? 'none'])

  // Whether an outcome line (or the filter) shows what a FAIL verdict reports, and whether any planned line is missing.
  let notPassing = log.filter === 'fail'
  let missing = false
  for (const file of planned.scripts) {
    const line = log.scripts.find((candidate) => candidate.file === file)
    if (!log.expected.includes(file) || line === undefined) {
      reason('missing-script', file, line === undefined ? 'no outcome line' : 'no expect line')
      missing = true
      continue
    }
    evidence.outcomes.set(file, [...(evidence.outcomes.get(file) ?? []), line.outcome])
    if (line.outcome !== 'pass') notPassing = true
    if (line.outcome === 'unfinished') reason('unfinished', file, 'it did not finish before the shard stopped')
    if (line.outcome === 'fail' && !evidence.failed.has(file)) evidence.failed.set(file, k)
    if (line.outcome === 'notrun') {
      const prerequisite = excusingPrerequisite(line, log)
      if (prerequisite !== null) evidence.skipped.set(file, prerequisite)
      else reason('notrun', file, notrunDetail(line.reason))
    }
  }
  for (const file of new Set([...log.expected, ...log.scripts.map((line) => line.file)])) {
    if (!planned.scripts.includes(file)) reason('extra-script', file, 'a line for a script this shard was not given')
  }

  const wanted: FilterOutcome = planned.filterRegression ? 'pass' : 'skipped'
  if (log.filter !== wanted) reason('filter', null, `filter regression ${log.filter ?? 'has no line'} where the plan wants ${wanted}`)

  if (log.verdict === 'fail' && log.runner === 'done' && !notPassing && !missing) {
    reason('log-problem', null, "the shard's verdict is FAIL though every line passed and the runner finished")
  }
  if (log.verdict === 'pass' && notPassing) reason('log-problem', null, "the shard's verdict is PASS though an outcome line or the filter is not")
}

/**
 * A role's evidence over its planned shards. A plan that does not cover its
 * script list, a planned shard with no result or with two, and a result for
 * no planned shard each fail it.
 */
function examineRole(role: GateRole, run: RoleRun): RoleEvidence {
  const evidence: RoleEvidence = { reasons: [], failed: new Map(), skipped: new Map(), outcomes: new Map() }
  for (const detail of planProblems(run.plan)) evidence.reasons.push({ kind: 'plan-coverage', role, shard: null, script: null, detail })
  const planned = new Set(run.plan.shards.map((shard) => shard.shard))
  for (const result of run.shards) {
    if (!planned.has(result.shard)) evidence.reasons.push({ kind: 'scheduler-state', role, shard: result.shard, script: null, detail: `job ${result.jobId} is for no planned shard` })
  }
  for (const shard of run.plan.shards) {
    const results = run.shards.filter((result) => result.shard === shard.shard)
    if (results.length !== 1) {
      const detail = results.length === 0 ? 'no scheduler result for this planned shard' : `${results.length} scheduler results for this shard`
      evidence.reasons.push({ kind: 'scheduler-state', role, shard: shard.shard, script: null, detail })
      continue
    }
    examineShard(role, shard, results[0], evidence)
  }
  if (role === 'candidate' && run.plan.shards.filter((shard) => shard.filterRegression).length !== 1) {
    evidence.reasons.push({ kind: 'filter', role, shard: null, script: null, detail: 'the candidate plan must run the filter regression in exactly one shard' })
  }
  return evidence
}

/** The reference's judgement of one candidate failure: null when it fails there too. */
function referenceJudgement(file: string, candidateShard: number, reference: RoleEvidence): GateReason | null {
  const outcomes = reference.outcomes.get(file) ?? []
  if (outcomes.length === 0) return { kind: 'reference-incomplete', role: 'reference', shard: null, script: file, detail: 'the reference run has no outcome for it' }
  const unsettled = outcomes.find((outcome) => outcome === 'notrun' || outcome === 'unfinished')
  if (unsettled !== undefined) return { kind: 'reference-incomplete', role: 'reference', shard: null, script: file, detail: `it is ${unsettled} on the reference` }
  if (outcomes.includes('pass')) return { kind: 'candidate-failure', role: 'candidate', shard: candidateShard, script: file, detail: 'it fails on the candidate and passes on the reference' }
  return null
}

/**
 * Judges the gate. Any manifest problem, and any problem in the candidate's
 * evidence (plan coverage, scheduler state or OOM kill, setup, run.log, a
 * runner that did not end `done`, missing, extra or repeated script,
 * unfinished, an unexcusable notrun, the filter regression), fails at once,
 * as does a test-1 failure: it is never excused, nor is a notrun for it.
 * Otherwise candidate failures need the reference run, and each must run and
 * fail there too; a `dependency:<X>` notrun (X not test-1, failed in its
 * shard) is excused with its X. Any problem in the reference run, its own
 * test-1 failure included, is 'reference-incomplete'.
 */
export function gateVerdict(input: { readonly manifestProblems: readonly string[]; readonly candidate: RoleRun; readonly reference: RoleRun | null }): GateVerdict {
  const fail = (reasons: readonly GateReason[]): GateVerdict => ({ outcome: 'fail', referenceScripts: [], excused: [], reasons })
  const candidate = examineRole('candidate', input.candidate)
  const reasons = [...manifestReasons(input.manifestProblems), ...candidate.reasons]
  for (const [file, shard] of candidate.failed) {
    if (isTest1File(file)) reasons.push({ kind: 'candidate-failure', role: 'candidate', shard, script: file, detail: 'test-1 fails on the candidate; a test-1 failure is never excused' })
  }
  if (reasons.length > 0) return fail(reasons)
  if (candidate.failed.size === 0) return { outcome: 'pass', referenceScripts: [], excused: [], reasons: [] }

  const failed = sortCanonical([...candidate.failed.keys()])
  if (input.reference === null) return { outcome: 'reference-needed', referenceScripts: failed, excused: [], reasons: [] }

  const reference = examineRole('reference', input.reference)
  const referenceReasons: GateReason[] = reference.reasons.map((reason) => ({
    ...reason,
    kind: 'reference-incomplete',
    role: 'reference',
    detail: `${reason.kind}: ${reason.detail}`,
  }))
  for (const [file, shard] of reference.failed) {
    if (isTest1File(file)) referenceReasons.push({ kind: 'reference-incomplete', role: 'reference', shard, script: file, detail: 'test-1 fails on the reference, so its run excuses nothing' })
  }
  for (const file of failed) {
    const judged = referenceJudgement(file, candidate.failed.get(file) ?? 0, reference)
    if (judged !== null) referenceReasons.push(judged)
  }
  if (referenceReasons.length > 0) return fail(referenceReasons)
  return { outcome: 'pass', referenceScripts: [], excused: sortCanonical([...failed, ...candidate.skipped.keys()]), reasons: [] }
}

// --- Submission ---

/** What a role's `jobsched submit` commands share. */
export interface SubmitSettings {
  readonly jobsched: string
  readonly context: string
  readonly cscbVersion: string
  readonly role: GateRole
  readonly channel: string
  /** Scripts the runner records failed without running them (verification only). */
  readonly injectFail?: readonly string[]
}

/** Each shard job's resources: the serial run peaked at 440 MiB. */
const SHARD_CPUS = '2'
const SHARD_MEMORY_GIB = 4
const SHARD_MEMORY = `${SHARD_MEMORY_GIB}g`
const SHARD_DISK = '20g'

/** A shard's scheduler timeout is twice its expected total plus this. */
const TIMEOUT_ADDEND_SECONDS = 30 * 60

/**
 * How far below its scheduler timeout a shard's GATE_DEADLINE_S ends: entry.sh
 * counts its deadline from the runner's start, so this leaves room for the
 * filter regression (at most about 5 min) and the summary.
 */
export const DEADLINE_MARGIN_SECONDS = 600

/** The `--name` role word. */
const ROLE_NAME: Readonly<Record<GateRole, string>> = { candidate: 'cand', reference: 'ref' }

/** A shard's scheduler timeout in whole minutes. */
export function shardTimeoutMinutes(expectedSeconds: number): number {
  return Math.ceil((2 * expectedSeconds + TIMEOUT_ADDEND_SECONDS) / 60)
}

/** One `jobsched submit` argv per shard, the longest expected total first, the lowest k on a tie. */
export function submitCommands(settings: SubmitSettings, plan: ShardPlan): string[][] {
  const ordered = [...plan.shards].sort((a, b) => b.expectedSeconds - a.expectedSeconds || a.shard - b.shard)
  return ordered.map((shard) => {
    const timeoutMinutes = shardTimeoutMinutes(shard.expectedSeconds)
    const injected = shard.scripts.filter((file) => settings.injectFail?.includes(file) ?? false)
    return [
      settings.jobsched, 'submit',
      '--context', settings.context,
      '--name', shardJobName(settings.cscbVersion, settings.role, shard.shard),
      '--channel', settings.channel,
      '--network', 'off',
      '--cpus', SHARD_CPUS,
      '--memory', SHARD_MEMORY,
      '--disk', SHARD_DISK,
      '--timeout', `${timeoutMinutes}m`,
      '--env', `GATE_FILTER=${shard.filterRegression ? 1 : 0}`,
      '--env', `GATE_DEADLINE_S=${timeoutMinutes * 60 - DEADLINE_MARGIN_SECONDS}`,
      ...(injected.length > 0 ? ['--env', `GATE_INJECT_FAIL=${injected.join(' ')}`] : []),
      '--', ...shard.scripts,
    ]
  })
}

// ---------------------------------------------------------------------------
// The command line. Everything below runs only from the entry block.
// ---------------------------------------------------------------------------

const PROG = 'ad-gate'
const USAGE_EXIT = 64
const FAIL_EXIT = 1
const ERROR_EXIT = 2
/** A subset or fault-injected run that passed: never 0, since it is no release verdict. */
const NON_RELEASE_PASS_EXIT = 3

const KIT_DIR = import.meta.dir
const TEMPLATE_DIR = join(KIT_DIR, 'template')
const TEMPLATE_FILES: readonly string[] = ['Dockerfile', 'entry.sh', 'filter-regression.ts', 'perm-stub-claude.sh', 'patch-client-check.py']
const EXECUTABLE_TEMPLATE_FILES: readonly string[] = ['entry.sh', 'perm-stub-claude.sh']
const PREPARE_SCRIPT = join(KIT_DIR, 'prepare.sh')

const DEFAULT_JOBSCHED = join(process.env.HOME ?? '', 'projects/sysadmin-project/box_admin_dev/box_admin_horde/job-scheduler/bin/jobsched')
const DEFAULT_AD_REPO = join(process.env.HOME ?? '', 'projects/agent-director-project/agent-director-main')

/** jobsched's own cap on `--timeout`. */
const JOBSCHED_MAX_TIMEOUT_MINUTES = 12 * 60
/** One `jobsched wait` call's limit, and the process limit around it. */
const WAIT_TIMEOUT = '20m'
const WAIT_CALL_LIMIT_MS = 25 * 60 * 1000
const JOB_ID_PATTERN = /^j[0-9]{14}-[0-9a-f]{6}$/
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/
const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+$/
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/
const CHANNEL_PATTERN = /^[A-Z0-9]+$/
const MANIFEST_LINE_PREFIX = 'ad-gate: manifest: '
/** Where a release tag keeps its integration scripts and duration table, and the AD checkout its installer. */
const TAG_INTEGRATION_DIR = 'tests/integration'
const AD_INSTALL_SH_PATH = 'skills/install-agent-director/install.sh'
const MIB = 1024 * 1024

const USAGE = `usage: bun scripts/ad-gate/ad-gate.ts --candidate-dist DIR --candidate-version X.Y.Z --channel ID --out DIR [options]

  --candidate-dist DIR       the candidate AD build: agent-director[-linux-amd64], agent-director-admin[-linux-amd64],
                             optional agent-director-<version>.tgz, install.sh and SHA256SUMS
  --candidate-version X.Y.Z  the version the candidate binary must report
  --candidate-install-sh F   the candidate's install.sh (default: DIR/install.sh, else the AD checkout at --candidate-commit)
  --candidate-commit SHA     the candidate's commit (recorded; install.sh source when DIR has none)
  --reference-tag vX.Y.Z     the reference AD release (default: the host's \`agent-director version\`)
  --cscb-version X.Y.Z       a shipped CSCB release to gate; repeatable (default: npm latest)
  --channel ID               the scheduler notice channel (required)
  --shards N                 each release's candidate shards, 1 to 6 (default: 4 to 6, whichever finishes soonest
                             on the scheduler's free slots at submit time, shared by the releases)
  --out DIR                  where contexts, evidence, verdict.json and report.md go
  --durations FILE           measured times, script<TAB>seconds, overriding the tag's table
  --only SCRIPT              run a subset (test-<n> or file name) with its prerequisites; repeatable;
                             no release verdict: a pass is NON-RELEASE PASS, exit 3
  --inject-fail SCRIPT       verification only: the candidate's runner records SCRIPT failed; repeatable;
                             no release verdict, as --only
  --ad-repo DIR              AD checkout, read only (default: ${DEFAULT_AD_REPO})
  --jobsched PATH            the scheduler CLI (default: ${DEFAULT_JOBSCHED})
  --dry-run                  prepare and plan, print the submit commands, submit nothing
  --resume                   continue the run recorded in DIR/state.json`

/** The gate's options, as recorded in state.json. */
interface GateOptions {
  readonly candidateDist: string
  readonly candidateVersion: string
  readonly candidateInstallSh: string | null
  readonly candidateCommit: string | null
  readonly referenceTag: string | null
  readonly cscbVersions: readonly string[]
  readonly channel: string
  /** Each release's candidate shard count; null to choose it from the free scheduler slots. */
  readonly shards: number | null
  readonly out: string
  readonly durations: string | null
  readonly only: readonly string[] | null
  readonly injectFail: readonly string[]
  readonly adRepo: string
  readonly jobsched: string
}

interface Invocation {
  readonly options: GateOptions
  readonly dryRun: boolean
  readonly resume: boolean
}

const VALUE_OPTIONS = new Set([
  '--candidate-dist', '--candidate-version', '--candidate-install-sh', '--candidate-commit', '--reference-tag', '--cscb-version',
  '--channel', '--shards', '--out', '--durations', '--only', '--inject-fail', '--ad-repo', '--jobsched',
])
const REPEATABLE_OPTIONS = new Set(['--cscb-version', '--only', '--inject-fail'])

/** The command line's values by option; a problem for anything else. */
function readOptionValues(argv: readonly string[]): { values: Map<string, string[]>; flags: Set<string> } | string {
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run' || arg === '--resume' || arg === '--help') {
      flags.add(arg)
      continue
    }
    if (!VALUE_OPTIONS.has(arg)) return `unknown argument ${JSON.stringify(arg)}`
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) return `${arg} needs a value`
    if (values.has(arg) && !REPEATABLE_OPTIONS.has(arg)) return `${arg} is given twice`
    values.set(arg, [...(values.get(arg) ?? []), value])
    index += 1
  }
  return { values, flags }
}

/** The invocation, or the first problem with the command line. */
function parseGateArguments(argv: readonly string[]): { ok: true; invocation: Invocation } | { ok: false; problem: string } | { ok: 'help' } {
  const read = readOptionValues(argv)
  if (typeof read === 'string') return { ok: false, problem: read }
  if (read.flags.has('--help')) return { ok: 'help' }
  const one = (flag: string): string | null => read.values.get(flag)?.[0] ?? null
  const many = (flag: string): string[] => read.values.get(flag) ?? []
  const required: readonly string[] = ['--candidate-dist', '--candidate-version', '--channel', '--out']
  const absent = required.find((flag) => one(flag) === null)
  if (absent !== undefined) return { ok: false, problem: `${absent} is required` }
  const checks: readonly (readonly [boolean, string])[] = [
    [VERSION_PATTERN.test(one('--candidate-version') ?? ''), '--candidate-version must be X.Y.Z'],
    [one('--candidate-commit') === null || COMMIT_PATTERN.test(one('--candidate-commit') ?? ''), '--candidate-commit must be a commit hash'],
    [one('--reference-tag') === null || TAG_PATTERN.test(one('--reference-tag') ?? ''), '--reference-tag must be vX.Y.Z'],
    [many('--cscb-version').every((version) => VERSION_PATTERN.test(version)), '--cscb-version must be X.Y.Z'],
    [CHANNEL_PATTERN.test(one('--channel') ?? ''), '--channel must be a Slack channel ID'],
    [one('--shards') === null || /^[1-6]$/.test(one('--shards') ?? ''), `--shards must be 1 to ${MAX_GATE_SHARDS}`],
  ]
  const failed = checks.find(([ok]) => !ok)
  if (failed !== undefined) return { ok: false, problem: failed[1] }
  const absolute = (value: string | null): string | null => (value === null ? null : resolve(value))
  return {
    ok: true,
    invocation: {
      dryRun: read.flags.has('--dry-run'),
      resume: read.flags.has('--resume'),
      options: {
        candidateDist: resolve(one('--candidate-dist') ?? ''),
        candidateVersion: one('--candidate-version') ?? '',
        candidateInstallSh: absolute(one('--candidate-install-sh')),
        candidateCommit: one('--candidate-commit'),
        referenceTag: one('--reference-tag'),
        cscbVersions: many('--cscb-version'),
        channel: one('--channel') ?? '',
        shards: one('--shards') === null ? null : Number(one('--shards')),
        out: resolve(one('--out') ?? ''),
        durations: absolute(one('--durations')),
        only: read.values.has('--only') ? many('--only') : null,
        injectFail: many('--inject-fail'),
        adRepo: resolve(one('--ad-repo') ?? DEFAULT_AD_REPO),
        jobsched: resolve(one('--jobsched') ?? DEFAULT_JOBSCHED),
      },
    },
  }
}

// --- Effects ---

/** A failure that stops the gate before it can judge: exit 2. Any other throw is a kit bug. */
class GateError extends Error {}

/** An error's reason without the path Node repeats: `no such file or directory (ENOENT)`, else its message. */
function errorReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown } | null)?.code
  const reason = /^[A-Z]+: ([^,]+)/.exec(message)?.[1]
  return typeof code === 'string' && reason !== undefined ? `${reason} (${code})` : message
}

/** A file's text, or a GateError: `<what> <path> cannot be read: <reason>`. */
function readText(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    throw new GateError(`${what} ${path} cannot be read: ${errorReason(err)}`)
  }
}

/** JSON text as an object, or a GateError: `<what> is not a JSON object`. */
function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new GateError(`${what} is not JSON: ${errorReason(err)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GateError(`${what} is not a JSON object`)
  return value as Record<string, unknown>
}

function say(line: string): void {
  process.stdout.write(`${PROG}: ${line}\n`)
}

/** The environment every child gets: this process's, without any ANTHROPIC_* or CI_ANTHROPIC_* variable. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(CI_)?ANTHROPIC_/.test(name)) env[name] = value
  }
  return env
}

interface ChildRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs a command to its end, no shell, its output captured. */
function runChild(argv: readonly string[], timeoutMs?: number): ChildRun {
  const result = spawnSync(argv[0], argv.slice(1), { env: childEnv(), encoding: 'utf8', maxBuffer: 256 * MIB, timeout: timeoutMs })
  if (result.error !== undefined) throw new GateError(`${argv[0]} could not run: ${result.error.message}`)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A command's stdout, or a GateError naming its stderr when it fails. */
function runOk(argv: readonly string[], what: string, timeoutMs?: number): string {
  const result = runChild(argv, timeoutMs)
  if (result.status !== 0) throw new GateError(`${what} failed (exit ${result.status ?? 'signal'}): ${lastLine(result.stderr) || lastLine(result.stdout)}`)
  return result.stdout
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop() ?? ''
}

/** A word safe to paste into a shell, quoted when it must be. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Writes a file whole: a temporary file renamed into place. */
function writeWhole(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

function writeJson(path: string, value: unknown): void {
  writeWhole(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** A JSON value with every object's keys sorted, for comparing manifests. */
function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, sorted((v as Record<string, unknown>)[key])]))
        : v
  return JSON.stringify(sorted(value))
}

// --- The scheduler ---

/** The `jobsched status --json` fields the gate reads. */
interface JobStatus {
  readonly id: string
  readonly state: string
  readonly terminal: boolean
  readonly exitCode: number | null
  readonly queuedS: number | null
  readonly buildS: number | null
  readonly runS: number | null
  readonly peakMemory: number | null
  readonly host: string | null
  readonly reason: string | null
  readonly submittedAt: string | null
  readonly endedAt: string | null
  readonly queuePosition: number | null
  readonly dispatcherRunning: boolean
  /** The job's `--name`, context directory and the SHA-256 the scheduler took of that context. */
  readonly name: string | null
  readonly contextDir: string | null
  readonly contextSha256: string | null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function jobStatus(jobsched: string, id: string): JobStatus {
  const doc = parseJsonObject(runOk([jobsched, 'status', '--json', id], `jobsched status ${id}`), `jobsched status ${id}'s output`)
  if (doc.id !== id || typeof doc.state !== 'string') throw new GateError(`jobsched status ${id} gave no state`)
  return {
    id,
    state: doc.state,
    terminal: doc.terminal === true,
    exitCode: numberOrNull(doc.exit_code),
    queuedS: numberOrNull(doc.queued_s),
    buildS: numberOrNull(doc.build_s),
    runS: numberOrNull(doc.run_s),
    peakMemory: numberOrNull(doc.peak_memory),
    host: stringOrNull(doc.remote_host),
    reason: stringOrNull(doc.reason),
    submittedAt: stringOrNull(doc.submitted_at),
    endedAt: stringOrNull(doc.ended_at),
    queuePosition: numberOrNull(doc.queue_position),
    dispatcherRunning: doc.dispatcher_running === true,
    name: stringOrNull(doc.name),
    contextDir: stringOrNull(doc.context_dir),
    contextSha256: stringOrNull(doc.context_sha256),
  }
}

/** What `jobsched results` holds for an ended job: its run.log text and result.json's OOM facts. */
interface JobResults {
  /** null when the scheduler kept no run.log. */
  readonly runLog: string | null
  /** result.json's `oom_killed`; null when result.json is missing or unreadable. */
  readonly oomKilled: boolean | null
  readonly oomNotes: readonly string[]
}

/** A results file's path when `jobsched results` lists it as present. */
function presentPath(doc: Record<string, unknown>, key: string): string | null {
  const paths = doc.paths as Record<string, unknown> | null | undefined
  const present = doc.present as Record<string, unknown> | null | undefined
  const path = typeof paths === 'object' ? paths?.[key] : undefined
  return typeof present === 'object' && present?.[key] === true && typeof path === 'string' && existsSync(path) ? path : null
}

function jobResults(jobsched: string, id: string): JobResults {
  const doc = parseJsonObject(runOk([jobsched, 'results', '--json', id], `jobsched results ${id}`), `jobsched results ${id}'s output`)
  const runLogPath = presentPath(doc, 'run_log')
  const resultPath = presentPath(doc, 'result')
  let result: Record<string, unknown> | null = null
  try {
    result = resultPath === null ? null : (JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>)
  } catch {
    result = null
  }
  const notes = result?.oom_notes
  return {
    runLog: runLogPath === null ? null : readText(runLogPath, `job ${id}'s run.log`),
    oomKilled: typeof result?.oom_killed === 'boolean' ? result.oom_killed : null,
    oomNotes: Array.isArray(notes) ? notes.filter((note): note is string => typeof note === 'string') : [],
  }
}

/** Submits one shard; its job ID from the first line of submit's output. */
function submitShard(argv: readonly string[]): string {
  const result = runChild(argv)
  for (const line of result.stderr.split('\n').filter((text) => text.trim() !== '')) say(`jobsched: ${line}`)
  const id = result.stdout.split('\n')[0]?.trim() ?? ''
  if (result.status !== 0 || !JOB_ID_PATTERN.test(id)) {
    throw new GateError(`jobsched submit refused ${argv[argv.indexOf('--name') + 1]} (exit ${result.status ?? 'signal'}): ${lastLine(result.stderr) || lastLine(result.stdout)}`)
  }
  return id
}

/** One `jobsched wait --timeout 20m` on `pending`: the IDs that have ended (none at its timeout, when it says who still waits). */
function waitOnce(jobsched: string, pending: readonly string[]): string[] {
  const doc = parseJsonObject(runOk([jobsched, 'wait', '--json', '--timeout', WAIT_TIMEOUT, ...pending], 'jobsched wait', WAIT_CALL_LIMIT_MS), "jobsched wait's output")
  if (!Array.isArray(doc.jobs)) throw new GateError("jobsched wait's output lists no jobs")
  const ended: string[] = []
  for (const job of doc.jobs as { id?: unknown; state?: unknown }[]) {
    if (typeof job?.id !== 'string') continue
    ended.push(job.id)
    say(`job ${job.id} ended ${String(job.state)}`)
  }
  if (ended.length === 0) {
    const states = pending.map((id) => jobStatus(jobsched, id))
    const queue = states.map((status) => `${status.id} ${status.state}${status.queuePosition === null ? '' : ` (queue position ${status.queuePosition})`}`)
    say(`still waiting on ${pending.length} job(s): ${queue.join(', ')}`)
    if (states.some((status) => !status.dispatcherRunning)) say('warning: the scheduler dispatcher is not running; queued jobs wait until it starts')
  }
  return ended
}

// --- The shard count ---

/** The scheduler's slots at one reading: `jobsched list --json`'s summary. */
export interface SlotReading {
  /** When it was read, ISO 8601. */
  readonly readAt: string
  /** `active_slots_limit`: every host's `admission.max_active`, summed. */
  readonly limit: number
  /** `active_slots_used`: building and running jobs. */
  readonly active: number
  /** `queued`: the queue is FIFO, so each queued job takes a slot before any of the gate's. */
  readonly queued: number
  /** limit − active − queued, at least 0. */
  readonly free: number
}

/** The wall-time estimate a shard count is chosen by. */
export interface ShardEstimate {
  /** Each release's candidate shard count. */
  readonly perRelease: number
  /** releases × perRelease. */
  readonly jobs: number
  /** ceil(jobs / max(free, 1)): how many shards each slot runs in turn. */
  readonly rounds: number
  /** rounds × workSeconds / perRelease. */
  readonly seconds: number
}

/**
 * How each release's candidate shard count was chosen. Recorded in
 * state.json when the candidates are first planned for submission, so
 * `--resume` reuses it and never reads the slots again.
 */
export interface ShardChoice {
  /** `option`: `--shards`; `slots`: the free scheduler slots. */
  readonly source: 'option' | 'slots'
  readonly reading: SlotReading | null
  /** The CSCB releases sharing the free slots. */
  readonly releases: number
  /** Each release's candidate shard count. */
  readonly perRelease: number
  /** With `slots`: the estimate the count was chosen by, and the longest release's planned script time it used. */
  readonly estimate: (ShardEstimate & { readonly workSeconds: number }) | null
}

/** The fewest candidate shards a slot reading chooses: below it a release outlasts the ~45 min target. */
export const MIN_SLOT_SHARDS = 4

/**
 * The candidate shard count, 4 to 6 per release, that finishes soonest on
 * `free` slots shared by `releases`: the least rounds × workSeconds / N with
 * rounds = ceil(releases × N / max(free, 1)), the fewer jobs on a tie. The
 * work scales every N alike, so it sizes the estimate but never changes the
 * choice; the costs are compared exactly, as rounds / N.
 */
export function fastestShardCount(free: number, releases: number, workSeconds: number): ShardEstimate {
  const slots = Math.max(1, free)
  const estimate = (perRelease: number): ShardEstimate => {
    const jobs = Math.max(1, releases) * perRelease
    const rounds = Math.ceil(jobs / slots)
    return { perRelease, jobs, rounds, seconds: (rounds * workSeconds) / perRelease }
  }
  let best = estimate(MIN_SLOT_SHARDS)
  for (let perRelease = MIN_SLOT_SHARDS + 1; perRelease <= MAX_GATE_SHARDS; perRelease += 1) {
    const next = estimate(perRelease)
    if (next.rounds * best.perRelease < best.rounds * next.perRelease) best = next
  }
  return best
}

/** The scheduler's slots now, from `jobsched list --json`; a GateError naming `--shards` when it gives none. */
function readSlots(jobsched: string): SlotReading {
  const doc = parseJsonObject(runOk([jobsched, 'list', '--json', '--limit', '1'], 'jobsched list'), "jobsched list's output")
  const summary = doc.summary as Record<string, unknown> | null | undefined
  const counts = [summary?.active_slots_limit, summary?.active_slots_used, summary?.queued]
  if (!counts.every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) {
    throw new GateError("jobsched list's output has no summary with active_slots_limit, active_slots_used and queued: give --shards N")
  }
  const [limit, active, queued] = counts as number[]
  return { readAt: new Date().toISOString(), limit, active, queued, free: Math.max(0, limit - active - queued) }
}

/**
 * The shard choice: `--shards` when given, else the fastest count for one
 * fresh reading of the free slots and the longest release's planned script
 * time (`workSeconds`, called only then).
 */
function chooseShards(options: GateOptions, releases: number, workSeconds: () => number): ShardChoice {
  if (options.shards !== null) return { source: 'option', reading: null, releases, perRelease: options.shards, estimate: null }
  const reading = readSlots(options.jobsched)
  const work = workSeconds()
  const estimate = fastestShardCount(reading.free, releases, work)
  return { source: 'slots', reading, releases, perRelease: estimate.perRelease, estimate: { ...estimate, workSeconds: work } }
}

function minutesText(seconds: number): string {
  return `${(seconds / 60).toFixed(1)} min`
}

/** The shard choice as the log and report.md state it. */
function describeShardChoice(choice: ShardChoice): string {
  if (choice.reading === null || choice.estimate === null) return `${choice.perRelease} candidate shards per release, from --shards`
  const { reading, estimate } = choice
  return (
    `${choice.perRelease} candidate shards per release, from ${reading.free} free scheduler slots ` +
    `(${reading.limit} slots, ${reading.active} active, ${reading.queued} queued at ${reading.readAt}) ` +
    `shared by ${choice.releases} release(s): an estimated ${minutesText(estimate.seconds)} ` +
    `(${estimate.jobs} jobs in ${estimate.rounds} round(s) of ${minutesText(estimate.workSeconds / estimate.perRelease)}; ` +
    `the longest release plans ${minutesText(estimate.workSeconds)} of scripts), the fastest of ${MIN_SLOT_SHARDS}-${MAX_GATE_SHARDS}`
  )
}

/** A release's planned candidate script time: its whole plan in one shard, test-1 counted once. */
function plannedWorkSeconds(run: RunContext, gate: ReleaseGate): number {
  const input = { ...planInputOf(gate.version.candidate.context, 1, run.measured), only: run.options.only ?? undefined, filterRegression: true }
  const plan = plannedOrGateError(() => planShards(input), `planning the candidate for claude-slack-channel-bots ${gate.cscbVersion}`)
  return plan.shards[0]?.expectedSeconds ?? 0
}

// --- Contexts and inputs ---

/** One role's record in state.json. */
interface RoleState {
  readonly context: string
  prepared: boolean
  plan: ShardPlan | null
  /** Job IDs by shard number, recorded as each is submitted. */
  jobs: Record<string, string>
}

interface VersionState {
  candidate: RoleState
  reference: RoleState | null
  firstSubmitAt: string | null
}

/**
 * state.json: the options, what they resolved to on the first run (so a
 * resumed run gates the same releases with the same shard counts), and each
 * release's roles.
 */
interface GateState {
  readonly options: GateOptions
  cscbVersions: string[] | null
  referenceTag: string | null
  /** Null until a real run first plans its candidates for submission; a dry run records none. */
  shardChoice: ShardChoice | null
  readonly versions: Record<string, VersionState>
}

/** The manifest prepare.sh writes. */
interface Manifest {
  readonly cscb: { readonly version: string; readonly tests_commit: string; readonly tarball_sha256: string; readonly ad_client_pin: string }
  readonly candidate: {
    readonly source: string
    readonly expected_version: string
    readonly commit?: string
    readonly binary_sha256: string
    readonly admin_sha256: string
    readonly installer_sha256: string
    readonly client_tgz_sha256: string
  }
  readonly ad_role?: string
}

/** What one role's context is built from. */
interface RoleSource {
  readonly role: GateRole
  readonly adVersion: string
  /** prepare.sh's AD arguments. */
  readonly prepareArgs: readonly string[]
}

/** Whether a path is an existing regular file (following links). */
function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

/**
 * The candidate's prepare.sh arguments, its user input checked first: the
 * dist directory, an `--candidate-install-sh` file, and the install.sh at
 * `--candidate-commit` when the dist holds none.
 */
function candidateSource(options: GateOptions): RoleSource {
  const dist = options.candidateDist
  if (!existsSync(dist) || !statSync(dist).isDirectory()) throw new GateError(`--candidate-dist ${dist} is no directory`)
  if (options.candidateInstallSh !== null && !isFile(options.candidateInstallSh)) {
    throw new GateError(`--candidate-install-sh ${options.candidateInstallSh} is no file`)
  }
  const installSh = options.candidateInstallSh ?? (isFile(join(dist, 'install.sh')) ? join(dist, 'install.sh') : null)
  if (installSh === null && options.candidateCommit === null) {
    throw new GateError(`${dist} holds no install.sh: give --candidate-install-sh FILE or --candidate-commit SHA`)
  }
  if (installSh === null && options.candidateCommit !== null) {
    const source = `${options.candidateCommit}:${AD_INSTALL_SH_PATH}`
    if (runChild(['git', '-C', options.adRepo, 'cat-file', '-e', source]).status !== 0) {
      throw new GateError(`--candidate-commit ${options.candidateCommit}: the AD checkout ${options.adRepo} has no ${source}`)
    }
  }
  const clientTgz = join(dist, `agent-director-${options.candidateVersion}.tgz`)
  return {
    role: 'candidate',
    adVersion: options.candidateVersion,
    prepareArgs: [
      '--ad-dist', dist,
      ...(installSh === null ? [] : ['--ad-install-sh', installSh]),
      ...(options.candidateCommit === null ? [] : ['--ad-commit', options.candidateCommit]),
      ...(existsSync(clientTgz) ? ['--ad-client-tgz', clientTgz] : []),
      '--ad-expected-version', options.candidateVersion,
    ],
  }
}

function referenceSource(tag: string): RoleSource {
  return { role: 'reference', adVersion: tag.slice(1), prepareArgs: ['--ad-tag', tag] }
}

/** Copies template files into a context, with their modes. */
function copyTemplate(context: string, files: readonly string[]): void {
  for (const file of files) {
    copyFileSync(join(TEMPLATE_DIR, file), join(context, file))
    chmodSync(join(context, file), EXECUTABLE_TEMPLATE_FILES.includes(file) ? 0o755 : 0o644)
  }
}

/** Copies the template into the context and runs prepare.sh into its inputs; its output goes to prepare.log beside it. */
function buildContext(options: GateOptions, cscbVersion: string, source: RoleSource, role: RoleState): void {
  mkdirSync(role.context, { recursive: true })
  copyTemplate(role.context, TEMPLATE_FILES)
  const argv = [
    'bash', PREPARE_SCRIPT,
    '--inputs', join(role.context, 'inputs'),
    '--cscb-version', cscbVersion,
    ...source.prepareArgs,
    '--ad-role', ROLE_NAME[source.role],
    '--ad-repo', options.adRepo,
  ]
  say(`${roleLabel(cscbVersion, source.role)}: preparing ${role.context} (prepare.sh ${source.prepareArgs.join(' ')})`)
  const result = runChild(argv)
  const log = join(role.context, '..', 'prepare.log')
  writeWhole(log, `$ ${argv.map(shellWord).join(' ')}\n${result.stdout}${result.stderr}`)
  if (result.status !== 0) throw new GateError(`prepare.sh failed for the ${source.role} (exit ${result.status ?? 'signal'}): ${lastLine(result.stderr)}; see ${log}`)
  say(`${roleLabel(cscbVersion, source.role)}: ${lastLine(result.stdout)}`)
}

/** A role's name in the log, with its release: the releases' work interleaves. */
function roleLabel(cscbVersion: string, role: GateRole): string {
  return `CSCB ${cscbVersion} ${role}`
}

/** A context's manifest, or a GateError when prepare.sh left none of its shape. */
function readManifest(context: string): Manifest {
  const path = join(context, 'inputs', 'manifest.json')
  const manifest = parseJsonObject(readText(path, 'the manifest'), `the manifest ${path}`)
  for (const block of ['cscb', 'candidate']) {
    const value = manifest[block]
    if (typeof value !== 'object' || value === null) throw new GateError(`the manifest ${path} has no ${block} block`)
  }
  return manifest as unknown as Manifest
}

/** Every way a context's inputs differ from its manifest, the release tag or the role's expectations. */
function inputProblems(context: string, manifest: Manifest, cscbVersion: string, cscbTagCommit: string, source: RoleSource): string[] {
  const problems: string[] = []
  const who = `${source.role} inputs`
  const expect = (ok: boolean, problem: string): void => {
    if (!ok) problems.push(`${who}: ${problem}`)
  }
  expect(manifest.cscb.version === cscbVersion, `manifest names CSCB ${manifest.cscb.version}, not ${cscbVersion}`)
  expect(manifest.cscb.tests_commit === cscbTagCommit, `tests come from ${manifest.cscb.tests_commit}, not tag v${cscbVersion} (${cscbTagCommit})`)
  expect(manifest.candidate.expected_version === source.adVersion, `manifest expects AD ${manifest.candidate.expected_version}, not ${source.adVersion}`)
  expect(manifest.ad_role === ROLE_NAME[source.role], `manifest's ad_role is ${manifest.ad_role ?? 'missing'}, not ${ROLE_NAME[source.role]}`)
  const files: readonly (readonly [string, string])[] = [
    ['cscb/package.tgz', manifest.cscb.tarball_sha256],
    ['ad/agent-director', manifest.candidate.binary_sha256],
    ['ad/agent-director-admin', manifest.candidate.admin_sha256],
    ['ad/install.sh', manifest.candidate.installer_sha256],
  ]
  for (const [file, want] of files) {
    const path = join(context, 'inputs', file)
    expect(existsSync(path) && sha256File(path) === want, `${file} does not match the manifest's sha256 ${want}`)
  }
  const client = join(context, 'inputs', 'ad', 'client.tgz')
  if (manifest.candidate.client_tgz_sha256 === '') expect(!existsSync(client), 'ad/client.tgz is present but the manifest records none')
  else expect(existsSync(client) && sha256File(client) === manifest.candidate.client_tgz_sha256, 'ad/client.tgz does not match the manifest')
  return problems
}

/** Every shard whose run.log shows a manifest other than its context's: proof each job ran these inputs. */
function runManifestProblems(role: GateRole, manifest: Manifest, results: readonly ShardResult[]): string[] {
  const want = canonicalJson(manifest)
  const problems: string[] = []
  for (const result of results) {
    if (result.runLog === null) continue
    const line = result.runLog.split('\n').find((text) => text.startsWith(MANIFEST_LINE_PREFIX))
    if (line === undefined) {
      problems.push(`${role} shard ${result.shard} (job ${result.jobId}): its run.log shows no manifest`)
      continue
    }
    let ran: string
    try {
      ran = canonicalJson(JSON.parse(line.slice(MANIFEST_LINE_PREFIX.length)))
    } catch {
      ran = ''
    }
    if (ran !== want) problems.push(`${role} shard ${result.shard} (job ${result.jobId}): it ran with a manifest other than its context's`)
  }
  return problems
}

/** The plan input from a prepared context: the tag's own scripts and duration table, for `shards` shards. */
function planInputOf(context: string, shards: number, measured: string | null): Omit<PlanInput, 'only' | 'filterRegression'> {
  const tests = join(context, 'inputs', 'cscb-src', 'tests')
  const integration = join(tests, 'integration')
  if (!existsSync(integration)) throw new GateError(`${context} holds no inputs/cscb-src/tests/integration: prepare.sh extracted no tests from the tag`)
  const scripts = readdirSync(integration)
    .filter((name) => SCRIPT_FILE_NAME_PATTERN.test(name))
    .map((fileName) => ({ fileName, text: readText(join(integration, fileName), 'the tag script') }))
  const table = join(tests, 'ci-durations.tsv')
  return { scripts, durations: existsSync(table) ? readText(table, 'the tag duration table') : null, measured, shards }
}

/** The planner's answer, or a GateError naming what was planned and why the planner refused it. */
function plannedOrGateError<T>(plan: () => T, what: string): T {
  try {
    return plan()
  } catch (err) {
    throw new GateError(`${what}: ${errorReason(err).replace(/^ad-gate: /, '')}`)
  }
}

// --- One gate ---

/** A collected shard: its result, the scheduler's figures and result.json's OOM notes. */
interface CollectedShard {
  readonly planned: PlannedShard
  readonly result: ShardResult
  readonly status: JobStatus | null
  readonly oomNotes: readonly string[]
}

/** A shard job's `--name`. */
function shardJobName(cscbVersion: string, role: GateRole, shard: number): string {
  return `adg-${cscbVersion}-${ROLE_NAME[role]}-s${shard}`
}

/** Reads every submitted shard's status, run.log and result.json, and keeps them as evidence beside the context. */
function collectRole(options: GateOptions, role: RoleState): CollectedShard[] {
  const collected: CollectedShard[] = []
  for (const planned of role.plan?.shards ?? []) {
    const jobId = role.jobs[String(planned.shard)]
    if (jobId === undefined) continue
    const status = jobStatus(options.jobsched, jobId)
    const results: JobResults = status.terminal ? jobResults(options.jobsched, jobId) : { runLog: null, oomKilled: null, oomNotes: [] }
    const shardDir = join(role.context, '..', `shard-${planned.shard}`)
    mkdirSync(shardDir, { recursive: true })
    writeJson(join(shardDir, 'status.json'), { ...status, oomKilled: results.oomKilled, oomNotes: results.oomNotes })
    if (results.runLog !== null) writeWhole(join(shardDir, 'run.log'), results.runLog)
    collected.push({
      planned,
      status,
      oomNotes: results.oomNotes,
      result: { shard: planned.shard, jobId, state: status.state, exitCode: status.exitCode, runLog: results.runLog, oomKilled: results.oomKilled },
    })
  }
  return collected
}

/**
 * Every way a role's recorded jobs are not this gate's: a job whose name is
 * not its shard's, whose context is not the role's, or whose context hash
 * differs from its siblings' (or is missing), so no recorded job ID is trusted
 * on its own.
 */
function jobProvenanceProblems(cscbVersion: string, roleName: GateRole, role: RoleState, shards: readonly CollectedShard[]): string[] {
  const problems: string[] = []
  for (const { planned, result, status } of shards) {
    const want = shardJobName(cscbVersion, roleName, planned.shard)
    if (status?.name !== want) problems.push(`${roleName} shard ${planned.shard}: job ${result.jobId} is named ${status?.name ?? 'nothing'}, not ${want}`)
    if (status?.contextDir !== role.context) problems.push(`${roleName} shard ${planned.shard}: job ${result.jobId} ran context ${status?.contextDir ?? 'unknown'}, not ${role.context}`)
  }
  const hashes = new Set(shards.map(({ status }) => status?.contextSha256 ?? null))
  if (hashes.has(null)) problems.push(`${roleName}: a job has no context_sha256`)
  else if (hashes.size > 1) problems.push(`${roleName}: its jobs ran ${hashes.size} different contexts (context_sha256 differs)`)
  return problems
}

/** One shard's submission: its command, its planned total and where its job ID is recorded. */
interface Submission {
  readonly argv: readonly string[]
  readonly shard: number
  readonly expectedSeconds: number
  /** The release's position in the gate's release order, for ties. */
  readonly release: number
  readonly role: RoleState
  readonly version: VersionState
}

/** A role's submissions, one per command, each with its plan shard's expected total. */
function submissionsOf(commands: readonly string[][], role: RoleState, version: VersionState, release: number): Submission[] {
  return commands.map((argv) => {
    const shard = Number(/-s([0-9]+)$/.exec(argv[argv.indexOf('--name') + 1])?.[1])
    const planned = role.plan?.shards.find((entry) => entry.shard === shard)
    return { argv, shard, expectedSeconds: planned?.expectedSeconds ?? 0, release, role, version }
  })
}

/** Submissions in submit order: the longest expected total first across releases, then release order, then the lowest k. */
function submitOrder(submissions: readonly Submission[]): Submission[] {
  return [...submissions].sort((a, b) => b.expectedSeconds - a.expectedSeconds || a.release - b.release || a.shard - b.shard)
}

/** Submits every shard not yet submitted, in submit order, recording each job ID at once. */
function submitAll(submissions: readonly Submission[], save: () => void): void {
  for (const { argv, shard, role, version } of submitOrder(submissions)) {
    if (role.jobs[String(shard)] !== undefined) continue
    version.firstSubmitAt ??= new Date().toISOString()
    const id = submitShard(argv)
    role.jobs[String(shard)] = id
    save()
    say(`submitted ${argv[argv.indexOf('--name') + 1]}: ${id} (${argv.slice(argv.indexOf('--') + 1).length} scripts)`)
  }
}

/** Refuses a plan whose timeouts jobsched would refuse. */
function checkTimeouts(plan: ShardPlan): void {
  const over = plan.shards.filter((shard) => shardTimeoutMinutes(shard.expectedSeconds) > JOBSCHED_MAX_TIMEOUT_MINUTES)
  if (over.length > 0) {
    throw new GateError(`shard(s) ${over.map((shard) => shard.shard).join(', ')} would need a timeout above jobsched's 12 h: use more shards or --durations`)
  }
}

/** The subset's names as file names, each a planned script; a GateError otherwise. */
function plannedFileNames(names: readonly string[], plan: ShardPlan, what: string): string[] {
  const scripts = plan.scripts.map(toScript)
  return names.map((name) => {
    const script = matchScript(name, scripts)
    if (script === null) throw new GateError(`${what} ${name} is not a planned script`)
    return script.fileName
  })
}

/** What a finished gate leaves for the report. */
interface GateOutcome {
  readonly cscbVersion: string
  readonly verdict: GateVerdict
  readonly candidateVerdict: GateVerdict
  readonly referenceTag: string
  readonly candidate: { readonly plan: ShardPlan; readonly shards: readonly CollectedShard[]; readonly manifest: Manifest }
  readonly reference: { readonly plan: ShardPlan; readonly shards: readonly CollectedShard[]; readonly manifest: Manifest } | null
  readonly manifestProblems: readonly string[]
  readonly firstSubmitAt: string | null
  readonly verdictAt: string
}

interface RunContext {
  readonly options: GateOptions
  readonly state: GateState
  readonly save: () => void
  readonly dryRun: boolean
  readonly referenceTag: string
  readonly measured: string | null
  readonly kit: KitProvenance
}

/** The template files whose copy in a context differs from the kit's. */
function staleTemplateFiles(context: string): string[] {
  return TEMPLATE_FILES.filter((file) => !existsSync(join(context, file)) || sha256File(join(context, file)) !== sha256File(join(TEMPLATE_DIR, file)))
}

/**
 * Prepares a role's context once; a resumed run keeps a prepared one's
 * inputs. A prepared context whose template copies differ from the kit's
 * (an earlier kit built it) gets the kit's copies while nothing was submitted
 * from it, and is refused once something was, so no job runs a template the
 * driver does not judge by.
 */
function prepareRole(run: RunContext, cscbVersion: string, source: RoleSource, role: RoleState): Manifest {
  if (!role.prepared || !existsSync(join(role.context, 'inputs', 'manifest.json'))) {
    buildContext(run.options, cscbVersion, source, role)
    role.prepared = true
    run.save()
  }
  const stale = staleTemplateFiles(role.context)
  if (stale.length > 0 && Object.keys(role.jobs).length > 0) {
    throw new GateError(`the ${source.role} context's ${stale.join(', ')} differ from the kit's, and jobs were submitted from it: start a new --out`)
  }
  if (stale.length > 0) {
    say(`${roleLabel(cscbVersion, source.role)}: refreshing ${stale.join(', ')} from the kit; nothing was submitted from this context`)
    copyTemplate(role.context, stale)
  }
  return readManifest(role.context)
}

/**
 * Plans a role from its context into `shards` shards (fewer when it has
 * fewer units), printing the duration tables' notes, and checks the plan's
 * coverage. A recorded plan (`--resume`) must equal the one the context gives
 * now once any of its jobs is submitted; before that, it is replaced. Writes
 * plan.json and the submit commands beside the context and returns the
 * commands.
 */
function planRole(run: RunContext, cscbVersion: string, source: RoleSource, role: RoleState, only: readonly string[] | null, shards: number): string[][] {
  const label = roleLabel(cscbVersion, source.role)
  const input = { ...planInputOf(role.context, shards, run.measured), only: only ?? undefined, filterRegression: source.role === 'candidate' }
  const fresh = plannedOrGateError(() => planShardsWithNotes(input), `planning the ${source.role} for claude-slack-channel-bots ${cscbVersion}`)
  for (const note of fresh.notes) say(`${label}: ${note}`)
  if (role.plan === null || (Object.keys(role.jobs).length === 0 && canonicalJson(role.plan) !== canonicalJson(fresh.plan))) {
    if (role.plan !== null) say(`${label}: the recorded plan differs from the context's; nothing was submitted from it, so it is replanned`)
    role.plan = fresh.plan
    run.save()
  } else if (canonicalJson(role.plan) !== canonicalJson(fresh.plan)) {
    throw new GateError(`the ${source.role} plan recorded in state.json differs from the one its context gives now, and jobs were submitted from it: start a new --out`)
  }
  const problems = planProblems(role.plan)
  if (problems.length > 0) throw new GateError(`the ${source.role} plan does not cover its scripts: ${problems.join('; ')}`)
  checkTimeouts(role.plan)
  const injectFail = source.role === 'candidate' ? plannedFileNames(run.options.injectFail, role.plan, '--inject-fail') : []
  const commands = submitCommands(
    { jobsched: run.options.jobsched, context: role.context, cscbVersion, role: source.role, channel: run.options.channel, injectFail },
    role.plan,
  )
  const roleDir = join(role.context, '..')
  writeJson(join(roleDir, 'plan.json'), role.plan)
  writeWhole(join(roleDir, 'submit-commands.txt'), commands.map((argv) => argv.map(shellWord).join(' ')).join('\n') + '\n')
  say(`${label}: ${role.plan.scripts.length} scripts in ${role.plan.shards.length} shard(s)`)
  for (const shard of role.plan.shards) {
    say(`  s${shard.shard}: ~${shard.expectedSeconds} s${shard.filterRegression ? ', filter regression' : ''}: ${shard.scripts.join(' ')}`)
  }
  return commands
}

/** Collects one role's ended jobs; adds its run.logs' manifest and its jobs' provenance problems. */
function collectChecked(run: RunContext, cscbVersion: string, roleName: GateRole, role: RoleState, manifest: Manifest, problems: string[]): CollectedShard[] {
  const shards = collectRole(run.options, role)
  problems.push(
    ...runManifestProblems(roleName, manifest, shards.map((shard) => shard.result)),
    ...jobProvenanceProblems(cscbVersion, roleName, role, shards),
  )
  return shards
}

// --- The releases together ---

/**
 * One CSCB release's gate through the combined run: its candidate is
 * prepared, planned and submitted with every other release's, judged as soon
 * as its own jobs end, and its reference (when needed) runs at once after.
 */
interface ReleaseGate {
  readonly cscbVersion: string
  /** Its position in the release order: ties in the submit order go to the earlier release. */
  readonly index: number
  readonly version: VersionState
  readonly tagCommit: string
  readonly candSource: RoleSource
  readonly candManifest: Manifest
  readonly manifestProblems: string[]
  candCommands: string[][]
  /** Set once its candidate jobs are collected and judged. */
  candidate: GateOutcome['candidate'] | null
  candidateVerdict: GateVerdict | null
  refManifest: Manifest | null
  /** Set once its verdict is final. */
  outcome: GateOutcome | null
}

/** Prepares one release's candidate context and checks its inputs. */
function prepareRelease(run: RunContext, cscbVersion: string, index: number): ReleaseGate {
  const versionDir = join(run.options.out, `cscb-${cscbVersion}`)
  const version = (run.state.versions[cscbVersion] ??= {
    candidate: { context: join(versionDir, 'candidate', 'context'), prepared: false, plan: null, jobs: {} },
    reference: null,
    firstSubmitAt: null,
  })
  const tagCommit = cscbTagCommit(cscbVersion)
  const candSource = candidateSource(run.options)
  const candManifest = prepareRole(run, cscbVersion, candSource, version.candidate)
  const manifestProblems = inputProblems(version.candidate.context, candManifest, cscbVersion, tagCommit, candSource)
  return {
    cscbVersion, index, version, tagCommit, candSource, candManifest, manifestProblems,
    candCommands: [], candidate: null, candidateVerdict: null, refManifest: null, outcome: null,
  }
}

/** The job IDs a gate still waits on: its candidate's, then its reference's, those not yet ended. */
function pendingJobs(gate: ReleaseGate, ended: ReadonlySet<string>): string[] {
  if (gate.outcome !== null) return []
  const role = gate.candidate === null ? gate.version.candidate : gate.version.reference
  return Object.values(role?.jobs ?? {}).filter((id) => !ended.has(id))
}

/**
 * Prepares, checks, plans and submits a release's reference for its
 * candidate's failures, or finishes the release when its inputs fail.
 * Reference subsets keep their sizing: `--shards`, else up to 6.
 */
function startReference(run: RunContext, gate: ReleaseGate): void {
  const { cscbVersion, version } = gate
  const candidateVerdict = gate.candidateVerdict!
  say(`CSCB ${cscbVersion}: the candidate failed ${candidateVerdict.referenceScripts.join(' ')}; running them on the reference ${run.referenceTag}`)
  const refSource = referenceSource(run.referenceTag)
  version.reference ??= { context: join(run.options.out, `cscb-${cscbVersion}`, 'reference', 'context'), prepared: false, plan: null, jobs: {} }
  const refManifest = prepareRole(run, cscbVersion, refSource, version.reference)
  gate.refManifest = refManifest
  gate.manifestProblems.push(...inputProblems(version.reference.context, refManifest, cscbVersion, gate.tagCommit, refSource))
  if (canonicalJson(refManifest.cscb) !== canonicalJson(gate.candManifest.cscb)) gate.manifestProblems.push('the reference context tests another CSCB package or tag than the candidate')
  const refCommands = planRole(run, cscbVersion, refSource, version.reference, candidateVerdict.referenceScripts, run.options.shards ?? MAX_GATE_SHARDS)
  if (gate.manifestProblems.length > 0) {
    gate.outcome = finish(run, cscbVersion, version, gate.manifestProblems, gate.candidate!, { plan: version.reference.plan!, shards: [], manifest: refManifest }, candidateVerdict)
    return
  }
  submitAll(submissionsOf(refCommands, version.reference, version, gate.index), run.save)
}

/**
 * Moves a gate on once its current jobs have all ended: judges its
 * candidate, then starts or finishes its reference.
 */
function advance(run: RunContext, gate: ReleaseGate, ended: ReadonlySet<string>): void {
  if (gate.outcome !== null || pendingJobs(gate, ended).length > 0) return
  const { cscbVersion, version } = gate
  if (gate.candidate === null) {
    const shards = collectChecked(run, cscbVersion, 'candidate', version.candidate, gate.candManifest, gate.manifestProblems)
    gate.candidate = { plan: version.candidate.plan!, shards, manifest: gate.candManifest }
    gate.candidateVerdict = gateVerdict({ manifestProblems: gate.manifestProblems, candidate: { plan: gate.candidate.plan, shards: shards.map((shard) => shard.result) }, reference: null })
    if (gate.candidateVerdict.outcome === 'reference-needed') startReference(run, gate)
    else gate.outcome = finish(run, cscbVersion, version, gate.manifestProblems, gate.candidate, null, gate.candidateVerdict)
    return
  }
  const reference = version.reference!
  const shards = collectChecked(run, cscbVersion, 'reference', reference, gate.refManifest!, gate.manifestProblems)
  gate.outcome = finish(run, cscbVersion, version, gate.manifestProblems, gate.candidate, { plan: reference.plan!, shards, manifest: gate.refManifest! }, gate.candidateVerdict)
}

/** Waits on every release's jobs together, one `jobsched wait --timeout 20m` at a time, moving each release on as its jobs end. */
function runReleases(run: RunContext, gates: readonly ReleaseGate[]): void {
  const ended = new Set<string>()
  for (;;) {
    for (const gate of gates) advance(run, gate, ended)
    const pending = gates.flatMap((gate) => pendingJobs(gate, ended))
    if (pending.length === 0) {
      if (gates.every((gate) => gate.outcome !== null)) return
      throw new Error('ad-gate: a release is unjudged with no job to wait on')
    }
    for (const id of waitOnce(run.options.jobsched, pending)) ended.add(id)
  }
}

/** The dry run's output: the shard choice and every release's candidate submit commands in submit order. */
function printDryRun(run: RunContext, gates: readonly ReleaseGate[]): void {
  const submissions = submitOrder(gates.flatMap((gate) => submissionsOf(gate.candCommands, gate.version.candidate, gate.version, gate.index)))
  say(`dry run: ${submissions.length} candidate submit command(s) across ${gates.length} release(s), longest first; nothing is submitted:`)
  for (const { argv } of submissions) process.stdout.write(`${argv.map(shellWord).join(' ')}\n`)
  say(`the reference ${run.referenceTag} runs only for candidate failures: just those scripts and their prerequisites, sharded the same way`)
}

/** Judges the collected evidence and writes verdict.json, report.md and measured-durations.tsv for one release. */
function finish(
  run: RunContext,
  cscbVersion: string,
  version: VersionState,
  manifestProblems: readonly string[],
  candidate: GateOutcome['candidate'],
  reference: GateOutcome['reference'],
  candidateVerdict: GateVerdict | null,
): GateOutcome {
  const verdict =
    candidate.shards.length === 0 && manifestProblems.length > 0
      ? { outcome: 'fail' as const, referenceScripts: [], excused: [], reasons: manifestReasons(manifestProblems) }
      : gateVerdict({
          manifestProblems,
          candidate: { plan: candidate.plan, shards: candidate.shards.map((shard) => shard.result) },
          reference: reference === null ? null : { plan: reference.plan, shards: reference.shards.map((shard) => shard.result) },
        })
  const outcome: GateOutcome = {
    cscbVersion,
    verdict,
    candidateVerdict: candidateVerdict ?? verdict,
    referenceTag: run.referenceTag,
    candidate,
    reference,
    manifestProblems,
    firstSubmitAt: version.firstSubmitAt,
    verdictAt: new Date().toISOString(),
  }
  const versionDir = join(run.options.out, `cscb-${cscbVersion}`)
  writeJson(join(versionDir, 'verdict.json'), verdictDocument(run, outcome))
  writeWhole(join(versionDir, 'report.md'), renderReport(run, outcome))
  writeWhole(join(versionDir, 'measured-durations.tsv'), measuredDurations(candidate.shards))
  const label = outcomeLabel(runOutcome(verdict.outcome, nonReleaseReasons(run.options)), nonReleaseReasons(run.options))
  say(`verdict for CSCB ${cscbVersion}: ${label}${verdict.reasons.length > 0 ? ` (${verdict.reasons.length} reason(s))` : ''}; ${join(versionDir, 'report.md')}`)
  for (const reason of verdict.reasons) say(`  ${describeReason(reason)}`)
  return outcome
}

// --- Release and non-release runs ---

/** A run's outcome: a gate pass of a subset or fault-injected run is no release pass. */
type RunOutcome = 'pass' | 'fail' | 'non-release-pass'

/** Why a run is no release verdict: it ran a subset, or injected failures. [] for a release run. */
function nonReleaseReasons(options: GateOptions): string[] {
  return [
    ...(options.only === null ? [] : [`--only ${options.only.join(' ')} ran a subset of the scripts`]),
    ...(options.injectFail.length === 0 ? [] : [`--inject-fail ${options.injectFail.join(' ')} injected failures`]),
  ]
}

function runOutcome(gate: GateVerdict['outcome'], nonRelease: readonly string[]): RunOutcome {
  if (gate !== 'pass') return 'fail'
  return nonRelease.length > 0 ? 'non-release-pass' : 'pass'
}

/** The outcome as the verdict lines and report.md state it, naming why a run is no release verdict. */
function outcomeLabel(outcome: RunOutcome, nonRelease: readonly string[]): string {
  const word = outcome === 'non-release-pass' ? 'NON-RELEASE PASS' : outcome.toUpperCase()
  return nonRelease.length === 0 ? word : `${word} (not a release verdict: ${nonRelease.join('; ')})`
}

// --- Kit provenance ---

/** The kit's revision and the hashes of every file it builds a job from or judges with, recorded in verdict.json. */
interface KitProvenance {
  readonly revision: string
  /** Whether the kit's files differ from that revision (changed or untracked). */
  readonly dirty: boolean
  /** SHA-256 by path under the repository root. */
  readonly files: Readonly<Record<string, string>>
}

/** The kit's own files: the template, prepare.sh, this driver and the ci-run planner it imports. */
const KIT_FILES: readonly string[] = [
  ...TEMPLATE_FILES.map((file) => `scripts/ad-gate/template/${file}`),
  'scripts/ad-gate/prepare.sh',
  'scripts/ad-gate/ad-gate.ts',
  'scripts/ci-run.ts',
]

function kitProvenance(): KitProvenance {
  const root = runOk(['git', '-C', KIT_DIR, 'rev-parse', '--show-toplevel'], 'the kit checkout').trim()
  const revision = runOk(['git', '-C', root, 'rev-parse', 'HEAD'], 'the kit revision').trim()
  const status = runOk(['git', '-C', root, 'status', '--porcelain', '--untracked-files=all', '--', ...KIT_FILES], 'the kit status')
  return { revision, dirty: status.trim() !== '', files: Object.fromEntries(KIT_FILES.map((file) => [file, sha256File(join(root, file))])) }
}

// --- verdict.json, report.md and measured times ---

/** Each script's lines across a role's shards, in plan order. */
function scriptLines(shards: readonly CollectedShard[]): Map<string, { shard: number; line: ScriptLine }[]> {
  const lines = new Map<string, { shard: number; line: ScriptLine }[]>()
  for (const shard of shards) {
    if (shard.result.runLog === null) continue
    for (const line of parseRunLog(shard.result.runLog).scripts) lines.set(line.file, [...(lines.get(line.file) ?? []), { shard: shard.planned.shard, line }])
  }
  return lines
}

function shardFigures(shards: readonly CollectedShard[]): unknown[] {
  return shards.map(({ planned, result, status, oomNotes }) => ({
    shard: planned.shard,
    jobId: result.jobId,
    name: status?.name ?? null,
    state: result.state,
    exitCode: result.exitCode,
    expectedSeconds: planned.expectedSeconds,
    filterRegression: planned.filterRegression,
    scripts: planned.scripts,
    queuedSeconds: status?.queuedS ?? null,
    buildSeconds: status?.buildS ?? null,
    runSeconds: status?.runS ?? null,
    peakMemoryBytes: status?.peakMemory ?? null,
    oomKilled: result.oomKilled ?? null,
    oomNotes,
    contextSha256: status?.contextSha256 ?? null,
    host: status?.host ?? null,
    reason: status?.reason ?? null,
  }))
}

function wallSeconds(outcome: GateOutcome): number | null {
  return outcome.firstSubmitAt === null ? null : Math.round((Date.parse(outcome.verdictAt) - Date.parse(outcome.firstSubmitAt)) / 1000)
}

function verdictDocument(run: RunContext, outcome: GateOutcome): unknown {
  const options = run.options
  const candidateLines = scriptLines(outcome.candidate.shards)
  const referenceLines = scriptLines(outcome.reference?.shards ?? [])
  const nonRelease = nonReleaseReasons(options)
  return {
    outcome: runOutcome(outcome.verdict.outcome, nonRelease),
    release: nonRelease.length === 0,
    nonRelease,
    kit: run.kit,
    cscbVersion: outcome.cscbVersion,
    candidate: { version: options.candidateVersion, dist: options.candidateDist, commit: options.candidateCommit, manifest: outcome.candidate.manifest },
    reference: { tag: outcome.referenceTag, ran: outcome.reference !== null && outcome.reference.shards.length > 0, manifest: outcome.reference?.manifest ?? null },
    verdict: outcome.verdict,
    candidateVerdict: outcome.candidateVerdict,
    manifestProblems: outcome.manifestProblems,
    scripts: outcome.candidate.plan.scripts.map((file) => ({
      file,
      candidate: candidateLines.get(file) ?? [],
      reference: referenceLines.get(file) ?? null,
    })),
    jobs: { candidate: shardFigures(outcome.candidate.shards), reference: shardFigures(outcome.reference?.shards ?? []) },
    firstSubmitAt: outcome.firstSubmitAt,
    verdictAt: outcome.verdictAt,
    wallSeconds: wallSeconds(outcome),
    options,
  }
}

function describeReason(reason: GateReason): string {
  const where = [reason.role, reason.shard === null ? null : `s${reason.shard}`, reason.script].filter((part) => part !== null).join(' ')
  return `${reason.kind}${where === '' ? '' : ` (${where})`}: ${reason.detail}`
}

/** A duration as the report shows it: seconds under two minutes, else minutes. */
function duration(seconds: number | null): string {
  if (seconds === null) return '-'
  return seconds < 120 ? `${seconds.toFixed(1)} s` : `${(seconds / 60).toFixed(1)} min`
}

function outcomeCell(lines: readonly { shard: number; line: ScriptLine }[] | undefined): string {
  if (lines === undefined || lines.length === 0) return '-'
  return lines
    .map(({ shard, line }) => `${line.outcome}${line.seconds === null ? '' : ` ${line.seconds.toFixed(1)} s`}${line.reason === null ? '' : ` (${line.reason})`} s${shard}`)
    .join('; ')
}

/** An OOM cell: what result.json says, null meaning it could not be read. */
function oomCell(oomKilled: boolean | null | undefined): string {
  if (oomKilled === true) return 'OOM kill'
  return oomKilled === false ? 'none' : 'unknown'
}

function shardTable(shards: readonly CollectedShard[]): string[] {
  return [
    '| shard | job | state | exit | queued | build | run | peak memory | OOM | expected | scripts | context sha256 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...shards.map(({ planned, result, status }) => {
      const cells = [
        `s${planned.shard}${planned.filterRegression ? ' (filter)' : ''}`,
        result.jobId,
        result.state,
        result.exitCode ?? '-',
        duration(status?.queuedS ?? null),
        duration(status?.buildS ?? null),
        duration(status?.runS ?? null),
        status === null || status.peakMemory === null ? '-' : `${(status.peakMemory / MIB).toFixed(1)} MiB of ${SHARD_MEMORY_GIB} GiB`,
        oomCell(result.oomKilled),
        duration(planned.expectedSeconds),
        planned.scripts.length,
        status?.contextSha256 ?? '-',
      ]
      return `| ${cells.join(' | ')} |`
    }),
  ]
}

function renderReport(run: RunContext, outcome: GateOutcome): string {
  const options = run.options
  const candidateLines = scriptLines(outcome.candidate.shards)
  const referenceLines = scriptLines(outcome.reference?.shards ?? [])
  const manifest = outcome.candidate.manifest
  const nonRelease = nonReleaseReasons(options)
  return [
    `# AD release gate: claude-slack-channel-bots ${outcome.cscbVersion} vs agent-director ${options.candidateVersion}`,
    '',
    `**Verdict: ${outcomeLabel(runOutcome(outcome.verdict.outcome, nonRelease), nonRelease)}**`,
    '',
    ...(nonRelease.length === 0 ? [] : ['**Not a release verdict.** This run cannot gate a release: ' + nonRelease.join('; ') + '.', '']),
    `- Candidate: ${options.candidateDist} (expected ${options.candidateVersion}${manifest.candidate.commit === undefined ? '' : `, commit ${manifest.candidate.commit}`}); binary sha256 ${manifest.candidate.binary_sha256}`,
    `- CSCB ${manifest.cscb.version}: tests ${manifest.cscb.tests_commit}, tarball sha256 ${manifest.cscb.tarball_sha256}, AD client pin ${manifest.cscb.ad_client_pin}`,
    `- Kit: ${run.kit.revision}${run.kit.dirty ? ' with uncommitted changes' : ''} (file hashes in verdict.json)`,
    ...(run.state.shardChoice === null ? [] : [`- Shards: ${describeShardChoice(run.state.shardChoice)}`]),
    `- Reference: ${outcome.referenceTag}, ${outcome.reference === null ? 'not run (no candidate failure needed it)' : `run for ${outcome.candidateVerdict.referenceScripts.join(' ')}`}`,
    `- Wall time, first submit to verdict: ${duration(wallSeconds(outcome))} (${outcome.firstSubmitAt ?? 'nothing submitted'} to ${outcome.verdictAt})`,
    ...(outcome.verdict.excused.length > 0 ? [`- Excused (fail on the reference too): ${outcome.verdict.excused.join(' ')}`] : []),
    '',
    '## Reasons',
    '',
    ...(outcome.verdict.reasons.length === 0 ? ['None.'] : outcome.verdict.reasons.map((reason) => `- ${describeReason(reason)}`)),
    '',
    '## Candidate shards',
    '',
    ...shardTable(outcome.candidate.shards),
    ...(outcome.reference === null ? [] : ['', '## Reference shards', '', ...shardTable(outcome.reference.shards)]),
    '',
    '## Scripts',
    '',
    '| script | candidate | reference |',
    '|---|---|---|',
    ...outcome.candidate.plan.scripts.map((file) => `| ${file} | ${outcomeCell(candidateLines.get(file))} | ${outcomeCell(referenceLines.get(file))} |`),
    '',
    '## Manifest',
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
    ...(outcome.reference === null ? [] : ['', 'Reference manifest:', '', '```json', JSON.stringify(outcome.reference.manifest, null, 2), '```']),
    '',
  ].join('\n')
}

/** The candidate's timed scripts as a duration table, whole seconds rounded up, for the next gate's --durations. */
function measuredDurations(shards: readonly CollectedShard[]): string {
  const seconds = new Map<string, number>()
  for (const [file, lines] of scriptLines(shards)) {
    const longest = Math.max(...lines.map(({ line }) => line.seconds ?? 0))
    if (longest > 0) seconds.set(file, Math.max(1, Math.ceil(longest)))
  }
  return [DURATION_TABLE_HEADER, ...sortCanonical([...seconds.keys()]).map((file) => `${fileNameNumberForm(file)}\t${seconds.get(file)}`), ''].join('\n')
}

// --- The run ---

/** The CSCB releases to gate: those given, else npm's latest. */
function cscbVersionsOf(options: GateOptions): string[] {
  if (options.cscbVersions.length > 0) return [...new Set(options.cscbVersions)]
  const latest = runOk(['npm', 'view', 'claude-slack-channel-bots@latest', 'version'], 'npm view claude-slack-channel-bots@latest').trim()
  if (!VERSION_PATTERN.test(latest)) throw new GateError(`npm's latest claude-slack-channel-bots is ${JSON.stringify(latest)}`)
  return [latest]
}

/** The reference tag: the one given, else the host's agent-director release; it must be tagged in the AD checkout. */
function referenceTagOf(options: GateOptions): string {
  let tag = options.referenceTag
  if (tag === null) {
    const version = parseJsonObject(runOk(['agent-director', 'version'], 'agent-director version'), "agent-director version's output").version
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new GateError(`the host's agent-director reports version ${JSON.stringify(version)}`)
    tag = `v${version}`
  }
  runOk(['git', '-C', options.adRepo, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], `the reference tag ${tag} in ${options.adRepo}`)
  return tag
}

/** The commit of CSCB's release tag v<version> in the kit's own checkout, or a GateError. */
function cscbTagCommit(version: string): string {
  const result = runChild(['git', '-C', KIT_DIR, 'rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`])
  if (result.status !== 0) throw new GateError(`claude-slack-channel-bots ${version} has no tag v${version} in the kit's checkout: fetch its tags`)
  return result.stdout.trim()
}

/**
 * Checks `--only` and `--inject-fail` against a release tag before prepare.sh
 * fetches anything: each names a script of the tag the gate can run, the
 * tag's headers plan, and each injected script is planned. Reads the tag's
 * scripts from the kit's checkout; a tag that keeps none there is left to the
 * plan from the prepared context, which gives the same errors.
 */
function preflightTag(options: GateOptions, cscbVersion: string, measured: string | null): void {
  const tag = `v${cscbVersion}`
  const listing = runOk(['git', '-C', KIT_DIR, 'ls-tree', '--full-tree', '--name-only', tag, `${TAG_INTEGRATION_DIR}/`], `listing ${tag}'s ${TAG_INTEGRATION_DIR}`)
  const names = listing.split('\n').map((path) => path.slice(path.lastIndexOf('/') + 1)).filter((name) => SCRIPT_FILE_NAME_PATTERN.test(name))
  if (names.length === 0) return
  const scripts = names.map(toScript)
  const given: readonly (readonly [string, readonly string[]])[] = [['--only', options.only ?? []], ['--inject-fail', options.injectFail]]
  for (const [flag, list] of given) {
    for (const name of list) {
      const script = matchScript(name, scripts)
      if (script === null) throw new GateError(`${flag} ${name} names no integration script of claude-slack-channel-bots ${cscbVersion}`)
      if (!inDefaultSet(script.fileName)) throw new GateError(`${flag} ${name} names ${script.fileName}, which ${NOT_RUNNABLE_TEXT}`)
    }
  }
  const texts = names.map((fileName) => ({ fileName, text: runOk(['git', '-C', KIT_DIR, 'show', `${tag}:${TAG_INTEGRATION_DIR}/${fileName}`], `reading ${tag}:${TAG_INTEGRATION_DIR}/${fileName}`) }))
  const table = runChild(['git', '-C', KIT_DIR, 'show', `${tag}:tests/ci-durations.tsv`])
  const input: PlanInput = {
    scripts: texts,
    durations: table.status === 0 ? table.stdout : null,
    measured,
    shards: options.shards ?? MAX_GATE_SHARDS,
    only: options.only ?? undefined,
    filterRegression: true,
  }
  const plan = plannedOrGateError(() => planShards(input), `planning claude-slack-channel-bots ${cscbVersion}`)
  plannedFileNames(options.injectFail, plan, '--inject-fail')
}

/** Whether a value has state.json's shape, so a resumed run reads only fields it holds. */
function isGateState(value: Record<string, unknown>): boolean {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const isRole = (v: unknown): boolean =>
    isRecord(v) && typeof v.context === 'string' && typeof v.prepared === 'boolean' && (v.plan === null || isRecord(v.plan)) && isRecord(v.jobs) && Object.values(v.jobs).every((id) => typeof id === 'string')
  const isVersion = (v: unknown): boolean =>
    isRecord(v) && isRole(v.candidate) && (v.reference === null || isRole(v.reference)) && (v.firstSubmitAt === null || typeof v.firstSubmitAt === 'string')
  const isCount = (v: unknown, least: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= least
  const isReading = (v: unknown): boolean =>
    isRecord(v) && typeof v.readAt === 'string' && isCount(v.limit, 0) && isCount(v.active, 0) && isCount(v.queued, 0) && isCount(v.free, 0)
  const isEstimate = (v: unknown): boolean =>
    isRecord(v) && isCount(v.perRelease, 1) && isCount(v.jobs, 1) && isCount(v.rounds, 1) && typeof v.seconds === 'number' && typeof v.workSeconds === 'number'
  const isChoice = (v: unknown): boolean =>
    isRecord(v) &&
    (v.source === 'option' || v.source === 'slots') &&
    (v.source === 'option' ? v.reading === null && v.estimate === null : isReading(v.reading) && isEstimate(v.estimate)) &&
    isCount(v.releases, 1) &&
    isCount(v.perRelease, 1) &&
    (v.perRelease as number) <= MAX_GATE_SHARDS
  return (
    isRecord(value.options) &&
    (value.cscbVersions === null || (Array.isArray(value.cscbVersions) && value.cscbVersions.every((v) => typeof v === 'string'))) &&
    (value.referenceTag === null || typeof value.referenceTag === 'string') &&
    (value.shardChoice === undefined || value.shardChoice === null || isChoice(value.shardChoice)) &&
    isRecord(value.versions) &&
    Object.values(value.versions).every(isVersion)
  )
}

/** The state to run with: a new one, or the recorded one with --resume when its options match. */
function loadState(invocation: Invocation): GateState {
  const out = invocation.options.out
  const path = join(out, 'state.json')
  if (existsSync(out) && !statSync(out).isDirectory()) throw new GateError(`--out ${out} is not a directory`)
  if (!invocation.resume) {
    let entries: string[] = []
    try {
      entries = existsSync(out) ? readdirSync(out) : []
    } catch (err) {
      throw new GateError(`--out ${out} cannot be read: ${errorReason(err)}`)
    }
    if (entries.length > 0) {
      throw new GateError(`--out ${out} is not empty: choose a new --out, or pass --resume to continue its run`)
    }
    return { options: invocation.options, cscbVersions: null, referenceTag: null, shardChoice: null, versions: {} }
  }
  if (!existsSync(path)) throw new GateError(`--resume: ${path} does not exist`)
  const state = parseJsonObject(readText(path, '--resume:'), `--resume: ${path}`)
  if (!isGateState(state)) throw new GateError(`--resume: ${path} is not an ad-gate state file`)
  if (canonicalJson(state.options) !== canonicalJson(invocation.options)) throw new GateError('--resume: the options differ from the recorded run\'s; give the same options')
  return { ...(state as unknown as GateState), shardChoice: (state.shardChoice as ShardChoice | null | undefined) ?? null }
}

/** The measured times from `--durations`, or null; a GateError when the file cannot be read or is no duration table. */
function readDurations(options: GateOptions): string | null {
  if (options.durations === null) return null
  const text = readText(options.durations, '--durations')
  if (text.split('\n')[0] !== DURATION_TABLE_HEADER) throw new GateError(`--durations ${options.durations}: its first line is not ${JSON.stringify(DURATION_TABLE_HEADER)}`)
  return text
}

/**
 * The whole gate; the exit status. The user's input is checked before
 * anything is written or fetched: the scheduler path, the candidate,
 * `--durations`, `--out` and state.json, the reference tag, each release tag
 * and the `--only` / `--inject-fail` names. Then every release's candidate is
 * prepared, the shard count chosen, and all candidates submitted and waited
 * on together; each release's reference runs as soon as its candidate is
 * judged.
 */
function runGate(invocation: Invocation): number {
  const options = invocation.options
  if (!existsSync(options.jobsched)) throw new GateError(`no jobsched at ${options.jobsched}`)
  candidateSource(options)
  const measured = readDurations(options)
  const state = loadState(invocation)
  const save = (): void => writeJson(join(options.out, 'state.json'), state)
  try {
    mkdirSync(options.out, { recursive: true })
    save()
  } catch (err) {
    throw new GateError(`--out ${options.out} cannot be written: ${errorReason(err)}`)
  }
  state.referenceTag ??= referenceTagOf(options)
  if (state.referenceTag === `v${options.candidateVersion}`) {
    throw new GateError(`the reference ${state.referenceTag} is the candidate's own version: give --reference-tag with the release before it`)
  }
  state.cscbVersions ??= cscbVersionsOf(options)
  save()
  const versions = state.cscbVersions
  for (const cscbVersion of versions) {
    cscbTagCommit(cscbVersion)
    preflightTag(options, cscbVersion, measured)
  }
  const kit = kitProvenance()
  const run: RunContext = { options, state, save, dryRun: invocation.dryRun, referenceTag: state.referenceTag, measured, kit }
  const nonRelease = nonReleaseReasons(options)
  say(`gating agent-director ${options.candidateVersion} against claude-slack-channel-bots ${versions.join(', ')}; reference ${run.referenceTag}`)
  say(`kit ${kit.revision}${kit.dirty ? ' with uncommitted changes' : ''}`)
  if (nonRelease.length > 0) say(`not a release run: ${nonRelease.join('; ')}`)

  // Every release's candidate is prepared first, so the slots are read just before submission.
  const gates = versions.map((cscbVersion, index) => prepareRelease(run, cscbVersion, index))
  const choice = state.shardChoice ?? chooseShards(options, versions.length, () => Math.max(...gates.map((gate) => plannedWorkSeconds(run, gate))))
  say(`shards: ${describeShardChoice(choice)}${state.shardChoice === null ? '' : ' (recorded; --resume reuses it)'}`)
  if (!invocation.dryRun && state.shardChoice === null) {
    state.shardChoice = choice
    save()
  }
  for (const gate of gates) {
    gate.candCommands = planRole(run, gate.cscbVersion, gate.candSource, gate.version.candidate, options.only, choice.perRelease)
    for (const problem of gate.manifestProblems) say(`CSCB ${gate.cscbVersion} manifest problem: ${problem}`)
  }
  if (invocation.dryRun) {
    printDryRun(run, gates)
    const problems = gates.reduce((count, gate) => count + gate.manifestProblems.length, 0)
    say(`dry run complete, nothing submitted; plans and commands are under ${options.out}${problems > 0 ? `; ${problems} manifest problem(s)` : ''}`)
    return problems > 0 ? FAIL_EXIT : 0
  }
  for (const gate of gates) {
    if (gate.manifestProblems.length > 0) {
      gate.outcome = finish(run, gate.cscbVersion, gate.version, gate.manifestProblems, { plan: gate.version.candidate.plan!, shards: [], manifest: gate.candManifest }, null, null)
    }
  }
  const live = gates.filter((gate) => gate.outcome === null)
  submitAll(live.flatMap((gate) => submissionsOf(gate.candCommands, gate.version.candidate, gate.version, gate.index)), save)
  say(`waiting on ${live.length} release(s)' candidate jobs together`)
  runReleases(run, gates)
  const outcomes = gates.map((gate) => gate.outcome!)
  const outcome = runOutcome(outcomes.every((each) => each.verdict.outcome === 'pass') ? 'pass' : 'fail', nonRelease)
  writeJson(join(options.out, 'verdict.json'), {
    outcome,
    release: nonRelease.length === 0,
    nonRelease,
    kit,
    candidateVersion: options.candidateVersion,
    versions: outcomes.map((each) => ({
      cscbVersion: each.cscbVersion,
      outcome: runOutcome(each.verdict.outcome, nonRelease),
      verdict: join(options.out, `cscb-${each.cscbVersion}`, 'verdict.json'),
    })),
  })
  writeWhole(join(options.out, 'report.md'), outcomes.map((each) => renderReport(run, each)).join('\n'))
  say(`verdict: ${outcomeLabel(outcome, nonRelease)}: agent-director ${options.candidateVersion} against claude-slack-channel-bots ${versions.join(', ')}; ${join(options.out, 'report.md')}`)
  return outcome === 'pass' ? 0 : outcome === 'fail' ? FAIL_EXIT : NON_RELEASE_PASS_EXIT
}

/** The command line's run: its exit status; never exits the process. */
export function runAdGate(argv: readonly string[]): number {
  const parsed = parseGateArguments(argv)
  if (parsed.ok === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!parsed.ok) {
    process.stderr.write(`${PROG}: ${parsed.problem}\n${USAGE}\n`)
    return USAGE_EXIT
  }
  try {
    return runGate(parsed.invocation)
  } catch (err) {
    process.stderr.write(`${PROG}: ${err instanceof Error ? err.message : String(err)}\n`)
    if (!(err instanceof GateError)) process.stderr.write(`${PROG}: (unexpected error)\n`)
    return ERROR_EXIT
  }
}

// The entry block: nothing here runs on import.
if (import.meta.main) {
  process.exit(runAdGate(process.argv.slice(2)))
}
