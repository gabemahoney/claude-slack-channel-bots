/**
 * tests/ad-gate.test.ts — the agent-director release gate kit
 * (`scripts/ad-gate/ad-gate.ts`, Bug b.fr9): shard planning, run.log parsing,
 * the gate verdict, the dry-run `jobsched submit` commands, entry.sh's gate
 * line formats and the command line's flow.
 *
 * The exports these tests hold the module to (import-safe: its CLI runs only
 * under `if (import.meta.main)`):
 *
 *   type GateRole = 'candidate' | 'reference'
 *   type ScriptOutcome = 'pass' | 'fail' | 'notrun' | 'unfinished'
 *   type FilterOutcome = 'pass' | 'fail' | 'skipped'
 *   type RunnerEnd = 'done' | 'deadline' | 'exited'
 *
 *   // --- Planning (ci-run.ts's planner) ---
 *   interface ScriptText { fileName: string; text: string }   // one tests/integration/test-*.sh at the shipped tag
 *   interface PlanInput {
 *     scripts: readonly ScriptText[]  // every test-*.sh at the tag; the default set drops `-fmk-real-` scripts and test-13
 *     durations: string | null        // the tag's tests/ci-durations.tsv text; null when the tag has none
 *     measured?: string | null        // the gate's own measured times, same `script<TAB>seconds` form; its entries win
 *     shards: number                  // requested N; throws outside 1 to 6
 *     only?: readonly string[]        // a subset (test-<n> or file names): plans these, their prerequisites and test-1
 *     filterRegression: boolean       // whether one shard runs the permission filter regression
 *   }
 *   interface PlannedShard { shard: number; scripts: readonly string[]; expectedSeconds: number; filterRegression: boolean }
 *   interface ShardPlan { scripts: readonly string[]; shards: readonly PlannedShard[] }
 *   function planShardsWithNotes(input: PlanInput): { plan: ShardPlan; notes: string[] }
 *     - `scripts`: every planned file name, in canonical order; `shards`: k = 1 .. min(N, scheduling
 *       units), each assignShards' list (test-1 first, then canonical order) and total
 *     - with `filterRegression`, exactly one shard has it: the smallest total, the lowest k on a tie
 *     - throws on a prerequisite header ci-run refuses, and on an `only` name matching no script
 *     - `notes`: ci-run's duration-table notes, the measured table's named `--durations`
 *   function planShards(input: PlanInput): ShardPlan     // planShardsWithNotes' plan
 *   function planProblems(plan: ShardPlan): string[]     // [] when every listed script but test-1 is in
 *     exactly one shard, every shard runs test-1 first and only listed scripts, once each, shards are
 *     numbered 1..n, and at most one shard runs the filter regression
 *
 *   // --- run.log (the only evidence the scheduler returns) ---
 *   interface ScriptLine { file: string; outcome: ScriptOutcome; seconds: number | null; reason: string | null }
 *   type RunLogProblem =
 *     | { kind: 'malformed'; line: number; text: string }  // 1-based line number and the line as written
 *     | { kind: 'duplicate-expect' | 'duplicate-script'; file: string }
 *     | { kind: 'duplicate-filter' | 'duplicate-runner' | 'duplicate-verdict' | 'truncated' }
 *     // problems come in line order, `truncated` (no verdict line) last
 *   interface RunLog {
 *     expected: readonly string[]; scripts: readonly ScriptLine[]; filter: FilterOutcome | null
 *     runner: RunnerEnd | null; verdict: 'pass' | 'fail' | 'setup-failed' | null; problems: readonly RunLogProblem[]
 *   }
 *   function parseRunLog(text: string): RunLog
 *     - only a line beginning `AD-GATE-` or `AD-GATE ` is a gate line; every other line is noise
 *     - `AD-GATE-EXPECT <file>`; `AD-GATE-SCRIPT <file> <outcome> <seconds|-> [<reason>]` (seconds only
 *       for pass and fail, a reason exactly for notrun); `AD-GATE-FILTER <outcome>`; `AD-GATE-RUNNER
 *       <end>`; any other gate line (or an extra field) is malformed
 *
 *   // --- The verdict ---
 *   interface ShardResult { shard: number; jobId: string; state: string; exitCode: number | null; runLog: string | null; oomKilled?: boolean | null }
 *   interface RoleRun { plan: ShardPlan; shards: readonly ShardResult[] }
 *   interface GateReason { kind: GateReasonKind; role: GateRole | null; shard: number | null; script: string | null; detail: string }
 *     GateReasonKind: 'manifest-mismatch' | 'plan-coverage' | 'scheduler-state' | 'setup-failed' | 'no-run-log'
 *       | 'log-problem' | 'missing-script' | 'extra-script' | 'duplicate-script' | 'unfinished' | 'notrun'
 *       | 'filter' | 'candidate-failure' | 'reference-incomplete'
 *   interface GateVerdict { outcome: 'pass' | 'fail' | 'reference-needed'; referenceScripts: readonly string[]; excused: readonly string[]; reasons: readonly GateReason[] }
 *   function gateVerdict(input: { manifestProblems: readonly string[]; candidate: RoleRun; reference: RoleRun | null }): GateVerdict
 *     - fails at once, with no reference run: a manifest problem; a plan planProblems refuses
 *       ('plan-coverage'); a candidate plan without exactly one filter shard ('filter'); a planned shard
 *       with no result or two, a result for no planned shard, a state other than succeeded/failed, an
 *       exit or verdict line disagreeing with the state, an observed or unknowable OOM kill
 *       ('scheduler-state'); exit 2 or a setup verdict ('setup-failed'); no run.log ('no-run-log');
 *       parser problems, a FAIL verdict with nothing failing, a PASS verdict with something not passing
 *       ('log-problem', repeated script lines 'duplicate-script'); a runner line other than `done`, or
 *       an unfinished script ('unfinished'); planned scripts without both lines ('missing-script'),
 *       lines for others ('extra-script'); the filter not passing in the planned shard or not
 *       `skipped` elsewhere ('filter'); a notrun not excusable ('notrun'); a test-1 failure
 *       ('candidate-failure')
 *     - only `dependency:<X>` notruns, X not test-1 and failed in that shard, are excusable; candidate
 *       failures then need the reference ('reference-needed' while `reference` is null). Each must
 *       fail there: a reference pass is 'candidate-failure'; any other reference outcome, any
 *       problem in the reference run and a reference test-1 failure are 'reference-incomplete'
 *
 *   // --- The shard count ---
 *   interface ShardEstimate { perRelease: number; jobs: number; rounds: number; seconds: number }
 *   function fastestShardCount(free: number, releases: number, workSeconds: number): ShardEstimate
 *     - N from 4 to 6 with the least rounds × workSeconds / N, rounds = ceil(releases × N / max(free, 1));
 *       the fewer jobs on a tie; the work sizes `seconds` but never the choice
 *   ShardChoice (state.json `shardChoice`): { source: 'slots' | 'option'; reading: SlotReading | null;
 *     releases; perRelease; estimate: ShardEstimate & { workSeconds } | null }
 *
 *   // --- Submission ---
 *   interface SubmitSettings { jobsched: string; context: string; cscbVersion: string; role: GateRole; channel: string; injectFail?: readonly string[] }
 *   function submitCommands(settings: SubmitSettings, plan: ShardPlan): string[][]
 *     - one argv per shard, the longest `expectedSeconds` first, the lowest k on a tie:
 *       <jobsched> submit --context <ctx> --name adg-<cscbVersion>-<cand|ref>-s<k> --channel <id>
 *       --network off --cpus 2 --memory 4g --disk 20g --timeout <ceil((2 × expectedSeconds + 1800) / 60)>m
 *       --env GATE_FILTER=<1 for the filter shard, else 0> --env GATE_DEADLINE_S=<whole seconds below the timeout>
 *       [--env GATE_INJECT_FAIL=<the injected scripts in this shard, run order, space-separated>] -- <the shard's scripts>
 *
 * The pure parts run in process on inline fixtures. The command-line cases
 * run the driver in child processes over a scratch git repository holding a
 * copy of the kit, with prepare.sh replaced by tests/fixtures/ad-gate/
 * fake-prepare.ts (no fetch) and `--jobsched` pointing at the recording
 * tests/fixtures/ad-gate/fake-jobsched.ts: no scheduler, Docker or network,
 * and no agent-director binary.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  fastestShardCount,
  gateVerdict,
  parseRunLog,
  planProblems,
  planShards,
  planShardsWithNotes,
  submitCommands,
  type FilterOutcome,
  type GateReason,
  type GateVerdict,
  type PlanInput,
  type PlannedShard,
  type RoleRun,
  type RunLog,
  type RunnerEnd,
  type ScriptLine,
  type ScriptOutcome,
  type ShardChoice,
  type ShardPlan,
  type ShardResult,
  type SubmitSettings,
} from '../scripts/ad-gate/ad-gate.ts'
import { DURATION_TABLE_HEADER, DURATION_TABLE_PATH, durationLineIgnoredNote, durationTableMissingNote, sortCanonical } from '../scripts/ci-run.ts'
import { hostSafeChildEnv, resolveToolDir } from './test-helpers/host-safe-env.ts'

// --- Fixtures ---

/** The shipped tag's integration scripts: the 33 the gate runs, test-13 and three `-fmk-real-` scripts. */
const LISTING = [
  'test-0-fmk-harness-self-check.sh', 'test-1-install-startup.sh', 'test-2-dryrun-spawn-skip.sh',
  'test-3-cozempic-restart.sh', 'test-4-resume-dialog.sh', 'test-5-two-personas.sh',
  'test-6-missing-working-dir.sh', 'test-7-dm-settings.sh', 'test-8-reload-confirm.sh',
  'test-9-reload-destructive-and-server-wide.sh', 'test-10-credentials-change.sh',
  'test-12-bot-hook-absoluteness.sh', 'test-13-fmk-switch-over.sh', 'test-14-fmk-kill-fails.sh',
  'test-15-fmk-prefix-neighbour.sh', 'test-16-fmk-conflict.sh', 'test-17-fmk-launch-pending.sh',
  'test-18-fmk-wedged.sh', 'test-19-fmk-reuse.sh', 'test-20-fmk-old-binary.sh', 'test-21-fmk-teardown.sh',
  'test-22-fmk-wrong-server.sh', 'test-23-fmk-latch-recheck.sh', 'test-24-fmk-stuck-launch.sh',
  'test-25-fmk-pre-trust.sh', 'test-26-fmk-timing-settings.sh', 'test-27-fmk-unusable-name.sh',
  'test-28-fmk-provenance.sh', 'test-29-invited-channels.sh', 'test-30-state-dir-upgrade.sh',
  'test-31-fmk-ack-burst.sh', 'test-32-fmk-real-order.sh', 'test-33-fmk-real-keys.sh',
  'test-41-fmk-real-codex.sh', 'test-42-fmk-displayed-current.sh', 'test-43-fmk-displayed-legacy.sh',
  'test-49-fmk-model-effort.sh',
]

/** The file name of test-<n> in LISTING. */
function f(n: number): string {
  const found = LISTING.find((name) => name.startsWith(`test-${n}-`))
  if (found === undefined) throw new Error(`no fixture script test-${n}`)
  return found
}

/** The default set: LISTING without test-13 and the `-fmk-real-` scripts. */
const DEFAULT_SET = LISTING.filter((name) => !name.startsWith('test-13-') && !name.includes('-fmk-real-'))

/** The prerequisite lines the tag's headers declare. */
const REQUIRES: Readonly<Record<string, string>> = { [f(3)]: 'test-2', [f(42)]: 'test-1', [f(43)]: 'test-1' }

/** A script's text: shebang, header comment block (with its `# ci-requires:` line, if any), body. */
function scriptText(requires: string | undefined): string {
  return ['#!/usr/bin/env bash', '# fixture integration script', ...(requires ? [`# ci-requires: ${requires}`] : []), 'set -euo pipefail', ''].join('\n')
}

function scriptsOf(names: readonly string[], requires: Readonly<Record<string, string>> = REQUIRES): PlanInput['scripts'] {
  return names.map((fileName) => ({ fileName, text: scriptText(requires[fileName]) }))
}

/** A duration table's text in the tag's `script<TAB>seconds` form; `extra` lines are appended as written. */
function durationsText(entries: readonly (readonly [number, number])[], extra: readonly string[] = []): string {
  return [DURATION_TABLE_HEADER, ...entries.map(([n, seconds]) => `test-${n}\t${seconds}`), ...extra, ''].join('\n')
}

/** The tag's duration table (figures from tests/ci-durations.tsv). */
const DURATIONS = durationsText([
  [1, 22], [2, 1], [3, 22], [4, 7], [0, 171], [5, 1], [6, 16], [7, 3], [8, 36], [9, 22], [10, 112], [12, 31],
  [13, 248], [14, 277], [15, 70], [16, 845], [17, 447], [18, 418], [19, 509], [20, 1061], [21, 388], [22, 524],
  [23, 740], [24, 1213], [25, 13], [26, 818], [27, 373], [28, 1187], [29, 101], [30, 2], [31, 5], [42, 180],
  [43, 180], [49, 55],
])

function plan(overrides: Partial<PlanInput> = {}): ShardPlan {
  return planShards({ scripts: scriptsOf(LISTING), durations: DURATIONS, shards: 6, filterRegression: true, ...overrides })
}

// --- planShards, planShardsWithNotes ---

describe('planShards', () => {
  const full = plan()

  test('the default set is every script but test-13 and the -fmk-real- scripts, in canonical order', () => {
    expect(full.scripts).toEqual(sortCanonical(DEFAULT_SET))
  })

  test('six shards, numbered from 1, each running test-1 first', () => {
    expect(full.shards.map((shard) => shard.shard)).toEqual([1, 2, 3, 4, 5, 6])
    expect(full.shards.map((shard) => shard.scripts[0])).toEqual(Array(6).fill(f(1)))
  })

  test('every other planned script runs in exactly one shard, after test-1 in canonical order', () => {
    const placed = full.shards.flatMap((shard) => shard.scripts.slice(1))

    expect(sortCanonical(placed)).toEqual(full.scripts.filter((name) => name !== f(1)))
    for (const shard of full.shards) expect(shard.scripts.slice(1)).toEqual(sortCanonical(shard.scripts.slice(1)))
  })

  test('test-3 runs in the shard of its prerequisite test-2, after it', () => {
    const shard = full.shards.find((candidate) => candidate.scripts.includes(f(3)))!

    expect(shard.scripts).toContain(f(2))
    expect(shard.scripts.indexOf(f(2))).toBeLessThan(shard.scripts.indexOf(f(3)))
  })

  test('test-42 and test-43 need only test-1, so they can run in separate shards', () => {
    const p = plan({ only: ['test-42', 'test-43'], shards: 2, durations: null })

    expect(p.shards.map((shard) => shard.scripts)).toEqual([[f(1), f(42)], [f(1), f(43)]])
  })

  test.each([
    ['the tag duration table', {}],
    ['default estimates, so totals tie', { durations: null }],
    ['one shard', { shards: 1 }],
  ] as const)('exactly one shard runs the filter regression, the smallest total, lowest k on a tie (%s)', (_label, overrides) => {
    const p = plan(overrides)
    const smallest = Math.min(...p.shards.map((shard) => shard.expectedSeconds))

    expect(p.shards.filter((shard) => shard.filterRegression).map((shard) => shard.shard)).toEqual([
      p.shards.find((shard) => shard.expectedSeconds === smallest)!.shard,
    ])
  })

  test('no shard runs the filter regression when the plan asks for none', () => {
    expect(plan({ filterRegression: false }).shards.some((shard) => shard.filterRegression)).toBe(false)
  })

  test('the measured times override the duration table entry by entry', () => {
    const small = { scripts: scriptsOf([f(1), f(5), f(6), f(7)]), shards: 2, durations: durationsText([[1, 22], [5, 100], [6, 100], [7, 100]]) }

    const tableOnly = plan(small)
    const measured = plan({ ...small, measured: durationsText([[7, 500]]) })

    expect(tableOnly.shards.map((shard) => [shard.scripts, shard.expectedSeconds])).toEqual([
      [[f(1), f(5), f(7)], 222],
      [[f(1), f(6)], 122],
    ])
    expect(measured.shards.map((shard) => [shard.scripts, shard.expectedSeconds])).toEqual([
      [[f(1), f(7)], 522],
      [[f(1), f(5), f(6)], 222],
    ])
  })

  test('the plan is deterministic: the same input, and the listing in another order, plan the same', () => {
    expect(plan()).toEqual(full)
    expect(plan({ scripts: scriptsOf([...LISTING].reverse()) })).toEqual(full)
  })

  test.each([
    ['test-3 brings its prerequisite test-2', ['test-3'], [[f(1), f(2), f(3)]]],
    ['file names and number forms, one shard per unit', [f(24), 'test-26'], [[f(1), f(24)], [f(1), f(26)]]],
    ['test-1 alone', ['test-1'], [[f(1)]]],
  ] as const)('a subset plan covers the named scripts, their prerequisites and test-1: %s', (_label, only, shards) => {
    const p = plan({ only })

    expect(p.scripts).toEqual(sortCanonical(shards.flat().filter((name, index, all) => all.indexOf(name) === index)))
    expect(p.shards.map((shard) => shard.scripts)).toEqual(shards.map((scripts) => [...scripts]))
  })

  test.each([0, 7])('refuses %d requested shards', (shards) => {
    expect(() => plan({ shards })).toThrow(RangeError)
  })

  test.each([
    ['a name that matches no script', ['test-99']],
    ['a -fmk-real- script', ['test-32']],
    ['test-13', ['test-13']],
  ] as const)('refuses a subset naming %s', (_label, only) => {
    expect(() => plan({ only })).toThrow(/ad-gate: /)
  })

  test('refuses a prerequisite header that names no script', () => {
    expect(() => plan({ scripts: scriptsOf(LISTING, { ...REQUIRES, [f(3)]: 'test-99' }) })).toThrow(/prerequisite headers are refused/)
  })

  test('every plan it makes is one planProblems accepts', () => {
    for (const p of [full, plan({ durations: null }), plan({ shards: 1 }), plan({ only: ['test-3', 'test-42'] }), plan({ filterRegression: false })]) {
      expect(planProblems(p)).toEqual([])
    }
  })
})

describe('planShardsWithNotes', () => {
  const tableNote = `duration table ${DURATION_TABLE_PATH}`

  test('gives planShards plan and, for a clean table, no note', () => {
    const input: PlanInput = { scripts: scriptsOf(LISTING), durations: DURATIONS, shards: 6, filterRegression: true }

    expect(planShardsWithNotes(input)).toEqual({ plan: planShards(input), notes: [] })
  })

  test.each([
    ['a tag with no table', { durations: null }, [durationTableMissingNote()]],
    ['an ignored line in the tag table', { durations: durationsText([[1, 22]], ['test-5\tabc']) }, [durationLineIgnoredNote(3, { kind: 'bad-seconds', seconds: 'abc' })]],
    [
      'an ignored line in the measured times, named --durations',
      { measured: durationsText([[5, 9]], ['test-6\tabc']) },
      [`--durations${durationLineIgnoredNote(3, { kind: 'bad-seconds', seconds: 'abc' }).slice(tableNote.length)}`],
    ],
  ] as const)('notes %s', (_label, overrides, notes) => {
    expect(planShardsWithNotes({ scripts: scriptsOf(LISTING), durations: DURATIONS, shards: 6, filterRegression: true, ...overrides }).notes).toEqual([...notes])
  })
})

// --- planProblems ---

/** The candidate plan of the verdict cases: test-24 alone beside test-1, the rest with the filter regression. */
const CAND: ShardPlan = {
  scripts: [f(1), f(2), f(3), f(5), f(24)],
  shards: [
    { shard: 1, scripts: [f(1), f(24)], expectedSeconds: 1235, filterRegression: false },
    { shard: 2, scripts: [f(1), f(2), f(3), f(5)], expectedSeconds: 46, filterRegression: true },
  ],
}

/** CAND with its shards changed by `edit`, or its script list replaced. */
function candWith(edit: (shards: PlannedShard[]) => PlannedShard[], scripts: readonly string[] = CAND.scripts): ShardPlan {
  return { scripts, shards: edit(CAND.shards.map((shard) => ({ ...shard }))) }
}

/** Plans planProblems refuses, each with the words its problem must hold. */
const UNSOUND_PLANS: readonly (readonly [string, ShardPlan, RegExp])[] = [
  ['a listed script no shard runs', candWith((s) => s, [...CAND.scripts, f(6)]), new RegExp(`${f(6)} is in 0 shards`)],
  ['a script in two shards', candWith(([a, b]) => [{ ...a, scripts: [...a.scripts, f(5)] }, b]), new RegExp(`${f(5)} is in 2 shards`)],
  ['a shard running an unlisted script', candWith(([a, b]) => [{ ...a, scripts: [...a.scripts, f(6)] }, b]), new RegExp(`runs ${f(6)}, which the plan does not list`)],
  ['a shard not starting with test-1', candWith(([a, b]) => [{ ...a, scripts: [f(24), f(1)] }, b]), /shard 1 does not run test-1 first/],
  ['a script twice in one shard', candWith(([a, b]) => [{ ...a, scripts: [f(1), f(24), f(24)] }, b]), /shard 1 names a script twice/],
  ['shards numbered out of order', candWith(([a, b]) => [b, a]), /numbered out of order/],
  ['two filter shards', candWith(([a, b]) => [{ ...a, filterRegression: true }, b]), /more than one shard runs the filter regression/],
  ['no shard', candWith(() => []), /the plan has no shard/],
  ['no test-1', { scripts: [f(24)], shards: [{ shard: 1, scripts: [f(24)], expectedSeconds: 1, filterRegression: true }] }, /the plan lists no test-1/],
]

describe('planProblems', () => {
  test('a sound plan has none', () => {
    expect(planProblems(CAND)).toEqual([])
  })

  test.each(UNSOUND_PLANS)('refuses %s', (_label, p, words) => {
    expect(planProblems(p).some((problem) => words.test(problem))).toBe(true)
  })
})

// --- fastestShardCount ---

/** A 170 min release's planned script time, the work the choice table assumes. */
const TABLE_WORK_SECONDS = 170 * 60

/**
 * The choice table (engineer fix round 3): per free slot count, the
 * [shards per release, rounds] chosen for one release and for two. Ties go
 * to the fewer jobs: free 0-2 tie all of 4-6, free 4 with two releases ties
 * 4 and 6.
 */
const SHARD_TABLE: readonly (readonly [number, readonly [number, number], readonly [number, number]])[] = [
  [0, [4, 4], [4, 8]],
  [1, [4, 4], [4, 8]],
  [2, [4, 2], [4, 4]],
  [3, [6, 2], [6, 4]],
  [4, [4, 1], [4, 2]],
  [5, [5, 1], [5, 2]],
  [6, [6, 1], [6, 2]],
  [7, [6, 1], [6, 2]],
  [8, [6, 1], [4, 1]],
  [9, [6, 1], [4, 1]],
  [10, [6, 1], [5, 1]],
  [11, [6, 1], [5, 1]],
  [12, [6, 1], [6, 1]],
]

describe('fastestShardCount', () => {
  test.each(SHARD_TABLE.flatMap(([free, one, two]) => [[free, 1, ...one] as const, [free, 2, ...two] as const]))(
    '%d free slots, %d release(s): %d shards per release in %d round(s)',
    (free, releases, perRelease, rounds) => {
      expect(fastestShardCount(free, releases, TABLE_WORK_SECONDS)).toEqual({
        perRelease,
        jobs: releases * perRelease,
        rounds,
        seconds: (rounds * TABLE_WORK_SECONDS) / perRelease,
      })
    },
  )

  test('the planned work sizes the estimate but never changes the choice', () => {
    for (let free = 0; free <= 12; free += 1) {
      for (let releases = 1; releases <= 3; releases += 1) {
        expect(fastestShardCount(free, releases, 1).perRelease).toBe(fastestShardCount(free, releases, TABLE_WORK_SECONDS).perRelease)
      }
    }
  })
})

// --- parseRunLog ---

/** A shard's run.log: entry.sh's own lines, a failed script's log dump and the machine-readable lines. */
const NOISY_LOG = [
  'ad-gate: subject: claude-slack-channel-bots 9.8.7 vs agent-director candidate (000000000000)',
  `AD-GATE-EXPECT ${f(1)}`,
  `AD-GATE-EXPECT ${f(2)}`,
  `AD-GATE-EXPECT ${f(3)}`,
  'ad-gate: filter regression: FILTER-REGRESSION PASS: found the held row at all 30 reads',
  `ad-gate: [   12 s] end ${f(1)} pass 11.038`,
  `ad-gate: ----- BEGIN full ${f(2)}.log (3 lines, 120 bytes) -----`,
  `FAIL: ${f(2)}: injected failure`,
  ` AD-GATE-SCRIPT ${f(4)} pass 1.000`,
  `ad-gate: AD-GATE-SCRIPT ${f(4)} pass 1.000`,
  `ad-gate: ----- END full ${f(2)}.log -----`,
  `AD-GATE-SCRIPT ${f(1)} pass 11.038`,
  `AD-GATE-SCRIPT ${f(2)} fail 0.017`,
  `AD-GATE-SCRIPT ${f(3)} notrun - dependency:${f(2)}`,
  'AD-GATE-RUNNER done',
  'AD-GATE-FILTER pass',
  `AD-GATE FAIL: claude-slack-channel-bots 9.8.7 vs agent-director candidate (000000000000): 1/3 scripts passed; failed: ${f(2)}`,
  '',
].join('\n')

/** A minimal valid log; `insertAt` puts lines in after its line `insertAt`. */
function baseLog(extra: readonly string[] = [], insertAt = 1): string {
  const lines = [`AD-GATE-EXPECT ${f(1)}`, `AD-GATE-SCRIPT ${f(1)} pass 1.000`, 'AD-GATE-RUNNER done', 'AD-GATE-FILTER skipped', 'AD-GATE PASS: fixture']
  return [...lines.slice(0, insertAt), ...extra, ...lines.slice(insertAt), ''].join('\n')
}

describe('parseRunLog', () => {
  test('reads the gate lines among noise; indented and prefixed copies are noise', () => {
    expect(parseRunLog(NOISY_LOG)).toEqual({
      expected: [f(1), f(2), f(3)],
      scripts: [
        { file: f(1), outcome: 'pass', seconds: 11.038, reason: null },
        { file: f(2), outcome: 'fail', seconds: 0.017, reason: null },
        { file: f(3), outcome: 'notrun', seconds: null, reason: `dependency:${f(2)}` },
      ],
      filter: 'pass',
      runner: 'done',
      verdict: 'fail',
      problems: [],
    })
  })

  test.each([
    [`AD-GATE-SCRIPT ${f(5)} notrun - unsafe-cleanup`, { file: f(5), outcome: 'notrun', seconds: null, reason: 'unsafe-cleanup' }],
    [`AD-GATE-SCRIPT ${f(5)} notrun - fail-fast`, { file: f(5), outcome: 'notrun', seconds: null, reason: 'fail-fast' }],
    [`AD-GATE-SCRIPT ${f(5)} unfinished -`, { file: f(5), outcome: 'unfinished', seconds: null, reason: null }],
  ] as const)('reads %s', (text, line) => {
    expect(parseRunLog(baseLog([text], 2)).scripts).toEqual([{ file: f(1), outcome: 'pass', seconds: 1, reason: null }, line])
  })

  test.each(['done', 'deadline', 'exited'] as const)('reads the runner line AD-GATE-RUNNER %s', (end) => {
    const parsed = parseRunLog(baseLog().replace('AD-GATE-RUNNER done', `AD-GATE-RUNNER ${end}`))

    expect([parsed.runner, parsed.problems]).toEqual([end, []])
  })

  test('a log with no runner line reads none, with no problem: the verdict judges it', () => {
    const parsed = parseRunLog(baseLog().replace('AD-GATE-RUNNER done\n', ''))

    expect([parsed.runner, parsed.problems]).toEqual([null, []])
  })

  test.each([
    ['AD-GATE PASS: claude-slack-channel-bots 9.8.7: 1/1 passed', 'pass'],
    ['AD-GATE FAIL: claude-slack-channel-bots 9.8.7: 0/1 scripts passed', 'fail'],
    ['AD-GATE FAIL: setup: no manifest', 'setup-failed'],
  ] as const)('reads the verdict line %s', (text, verdict) => {
    expect(parseRunLog(`${f(1)} noise\n${text}\n`).verdict).toBe(verdict)
  })

  test('a log with no verdict line is truncated', () => {
    const cut = NOISY_LOG.slice(0, NOISY_LOG.indexOf('AD-GATE FAIL:'))
    const parsed = parseRunLog(cut)

    expect(parsed.verdict).toBeNull()
    expect(parsed.problems).toEqual([{ kind: 'truncated' }])
  })

  test('a log cut inside a gate line is truncated and that line is malformed', () => {
    const partial = `AD-GATE-SCRIPT ${f(2)} fa`
    const cut = NOISY_LOG.slice(0, NOISY_LOG.indexOf(`AD-GATE-SCRIPT ${f(2)}`)) + partial
    const lineNumber = cut.split('\n').length

    expect(parseRunLog(cut).problems).toEqual([{ kind: 'malformed', line: lineNumber, text: partial }, { kind: 'truncated' }])
  })

  test('an empty log has no evidence and is truncated', () => {
    expect(parseRunLog('')).toEqual({ expected: [], scripts: [], filter: null, runner: null, verdict: null, problems: [{ kind: 'truncated' }] })
  })

  test.each([
    ['an expected script', `AD-GATE-EXPECT ${f(1)}`, { kind: 'duplicate-expect', file: f(1) }],
    ['a script outcome', `AD-GATE-SCRIPT ${f(1)} fail 2.000`, { kind: 'duplicate-script', file: f(1) }],
    ['the runner end', 'AD-GATE-RUNNER exited', { kind: 'duplicate-runner' }],
    ['the filter verdict', 'AD-GATE-FILTER pass', { kind: 'duplicate-filter' }],
    ['the shard verdict', 'AD-GATE FAIL: fixture', { kind: 'duplicate-verdict' }],
  ] as const)('a repeated line for %s is a problem, and only the first counts', (_label, repeat, problem) => {
    const parsed = parseRunLog(baseLog([repeat], 5))

    expect(parsed.problems).toEqual([problem])
    expect(parsed.scripts).toEqual([{ file: f(1), outcome: 'pass', seconds: 1, reason: null }])
    expect([parsed.runner, parsed.filter, parsed.verdict]).toEqual(['done', 'skipped', 'pass'])
  })

  test.each([
    ['an unknown outcome', `AD-GATE-SCRIPT ${f(5)} passed 1.000`],
    ['seconds that are no number', `AD-GATE-SCRIPT ${f(5)} pass abc`],
    ['a script line with no outcome', `AD-GATE-SCRIPT ${f(5)}`],
    ['a file that is no script', 'AD-GATE-SCRIPT ../evil.sh pass 1.000'],
    ['a notrun with no reason', `AD-GATE-SCRIPT ${f(5)} notrun -`],
    ['a pass with a reason', `AD-GATE-SCRIPT ${f(5)} pass 1.000 fail-fast`],
    ['an unfinished with a reason', `AD-GATE-SCRIPT ${f(5)} unfinished - fail-fast`],
    ['seconds on an unfinished', `AD-GATE-SCRIPT ${f(5)} unfinished 1.000`],
    ['an extra field after the reason', `AD-GATE-SCRIPT ${f(5)} notrun - dependency:${f(1)} extra`],
    ['an expect line with no file', 'AD-GATE-EXPECT'],
    ['an expect line with an extra field', `AD-GATE-EXPECT ${f(5)} extra`],
    ['an unknown filter word', 'AD-GATE-FILTER maybe'],
    ['a filter line with an extra field', 'AD-GATE-FILTER pass extra'],
    ['an unknown runner word', 'AD-GATE-RUNNER maybe'],
    ['a runner line with no word', 'AD-GATE-RUNNER'],
    ['an unknown keyword', `AD-GATE-RESULT ${f(5)} pass`],
    ['an unknown verdict word', 'AD-GATE MAYBE: fixture'],
  ] as const)('a gate line with %s is malformed, with its line number', (_label, text) => {
    expect(parseRunLog(baseLog([text], 1)).problems).toEqual([{ kind: 'malformed', line: 2, text }])
  })
})

// --- gateVerdict ---

interface Spec {
  readonly outcome: ScriptOutcome
  readonly reason?: string
}
type Specs = Readonly<Record<string, Spec>>

function scriptLine(file: string, spec: Spec = { outcome: 'pass' }): string {
  const seconds = spec.outcome === 'pass' || spec.outcome === 'fail' ? '1.000' : '-'
  return ['AD-GATE-SCRIPT', file, spec.outcome, seconds, ...(spec.reason === undefined ? [] : [spec.reason])].join(' ')
}

interface LogOptions {
  /** The filter word; null leaves the line out. Default: pass in the filter shard, else skipped. */
  readonly filter?: FilterOutcome | null
  /** The runner word; null leaves the line out. Default: done. */
  readonly runner?: RunnerEnd | null
  /** The verdict line's word; default PASS when every line passes, else FAIL. */
  readonly verdict?: 'PASS' | 'FAIL'
}

/** The run.log entry.sh writes for one shard, every script passing unless `specs` says otherwise. */
function shardLog(shard: PlannedShard, specs: Specs = {}, options: LogOptions = {}): string {
  const filter = options.filter === undefined ? (shard.filterRegression ? 'pass' : 'skipped') : options.filter
  const runner = options.runner === undefined ? 'done' : options.runner
  const passed = shard.scripts.every((file) => (specs[file]?.outcome ?? 'pass') === 'pass') && filter !== 'fail' && runner === 'done'
  return [
    'ad-gate: subject: claude-slack-channel-bots 9.8.7 vs agent-director candidate (000000000000)',
    ...shard.scripts.map((file) => `AD-GATE-EXPECT ${file}`),
    'ad-gate: runner pid 7; deadline 3600 s',
    ...shard.scripts.map((file) => scriptLine(file, specs[file])),
    ...(runner === null ? [] : [`AD-GATE-RUNNER ${runner}`]),
    ...(filter === null ? [] : [`AD-GATE-FILTER ${filter}`]),
    `AD-GATE ${options.verdict ?? (passed ? 'PASS' : 'FAIL')}: fixture`,
    '',
  ].join('\n')
}

/** Lines edited in a log's text. */
function editLog(text: string, edit: (lines: string[]) => string[]): string {
  return edit(text.split('\n')).join('\n')
}

/** One shard's result: succeeded (exit 0) when every script passes, else failed (exit 1), with its log; `over` wins. */
function shardResult(shard: PlannedShard, specs: Specs = {}, over: Partial<ShardResult> = {}): ShardResult {
  const passed = shard.scripts.every((file) => (specs[file]?.outcome ?? 'pass') === 'pass')
  return {
    shard: shard.shard,
    jobId: `j-fixture-s${shard.shard}`,
    state: passed ? 'succeeded' : 'failed',
    exitCode: passed ? 0 : 1,
    runLog: shardLog(shard, specs),
    ...over,
  }
}

/** One role's run of `plan`: every shard ended with its log, `specs` and `over` per shard number. */
function roleRun(plan: ShardPlan, specs: Readonly<Record<number, Specs>> = {}, over: Readonly<Record<number, Partial<ShardResult>>> = {}): RoleRun {
  return { plan, shards: plan.shards.map((shard) => shardResult(shard, specs[shard.shard], over[shard.shard])) }
}

/** A reference subset plan: one shard, test-1 then `files`, no filter regression. */
function refPlan(...files: string[]): ShardPlan {
  const scripts = [f(1), ...files]
  return { scripts, shards: [{ shard: 1, scripts, expectedSeconds: 600, filterRegression: false }] }
}

const FAIL: Spec = { outcome: 'fail' }
const SETUP_LOG = 'ad-gate: setup failed: no manifest\nAD-GATE FAIL: setup: no manifest\n'

function verdict(candidate: RoleRun, reference: RoleRun | null = null, manifestProblems: readonly string[] = []): GateVerdict {
  return gateVerdict({ manifestProblems, candidate, reference })
}

/** Asserts `v.reasons` holds a reason with these fields. */
function expectReason(v: GateVerdict, reason: Partial<GateReason>): void {
  expect(v.reasons).toEqual(expect.arrayContaining([expect.objectContaining(reason)]))
}

/** Asserts the gate fails at once, with no reference run, and holds this reason. */
function expectImmediateFail(v: GateVerdict, reason: Partial<GateReason>): void {
  expect(v).toMatchObject({ outcome: 'fail', referenceScripts: [], excused: [] })
  expectReason(v, reason)
}

describe('gateVerdict', () => {
  test('every candidate script and the filter regression pass: PASS, nothing excused', () => {
    expect(verdict(roleRun(CAND))).toEqual({ outcome: 'pass', referenceScripts: [], excused: [], reasons: [] })
  })

  test('candidate failures need the reference run on just the failed scripts, canonical, each once', () => {
    expect(verdict(roleRun(CAND, { 1: { [f(24)]: FAIL } }))).toMatchObject({ outcome: 'reference-needed', referenceScripts: [f(24)], excused: [] })

    const two = roleRun(CAND, { 1: { [f(24)]: FAIL }, 2: { [f(2)]: FAIL, [f(3)]: { outcome: 'notrun', reason: `dependency:${f(2)}` } } })
    expect(verdict(two)).toMatchObject({ outcome: 'reference-needed', referenceScripts: [f(2), f(24)] })
  })

  test('a candidate failure the reference passes fails the gate', () => {
    const v = verdict(roleRun(CAND, { 1: { [f(24)]: FAIL } }), roleRun(refPlan(f(24))))

    expect(v).toMatchObject({ outcome: 'fail', excused: [] })
    expectReason(v, { kind: 'candidate-failure', role: 'candidate', script: f(24) })
  })

  test('a candidate failure the reference shares is excused', () => {
    const v = verdict(roleRun(CAND, { 1: { [f(24)]: FAIL } }), roleRun(refPlan(f(24)), { 1: { [f(24)]: FAIL } }))

    expect(v).toEqual({ outcome: 'pass', referenceScripts: [], excused: [f(24)], reasons: [] })
  })

  test('a notrun for a failed prerequisite other than test-1 is excused only when that prerequisite fails on both', () => {
    const candidate = roleRun(CAND, { 2: { [f(2)]: FAIL, [f(3)]: { outcome: 'notrun', reason: `dependency:${f(2)}` } } })

    expect(verdict(candidate, roleRun(refPlan(f(2)), { 1: { [f(2)]: FAIL } }))).toEqual({ outcome: 'pass', referenceScripts: [], excused: [f(2), f(3)], reasons: [] })

    const passesThere = verdict(candidate, roleRun(refPlan(f(2))))
    expect(passesThere).toMatchObject({ outcome: 'fail', excused: [] })
    expectReason(passesThere, { kind: 'candidate-failure', role: 'candidate', script: f(2) })
  })

  test.each([
    ['test-1 fails, so its shard is skipped', { 1: { [f(1)]: FAIL, [f(24)]: { outcome: 'notrun', reason: `dependency:${f(1)}` } } }, { kind: 'candidate-failure', script: f(1), shard: 1 }],
    [
      'test-1 fails in one shard of two',
      { 2: { [f(1)]: FAIL, [f(2)]: { outcome: 'notrun', reason: `dependency:${f(1)}` }, [f(3)]: { outcome: 'notrun', reason: `dependency:${f(1)}` }, [f(5)]: { outcome: 'notrun', reason: `dependency:${f(1)}` } } },
      { kind: 'candidate-failure', script: f(1), shard: 2 },
    ],
    ['a script is skipped for test-1', { 1: { [f(24)]: { outcome: 'notrun', reason: `dependency:${f(1)}` } } }, { kind: 'notrun', script: f(24), shard: 1 }],
  ] as const)('a candidate test-1 failure or a notrun for test-1 fails at once, whatever the reference says: %s', (_label, specs, reason) => {
    const candidate = roleRun(CAND, specs)

    expectImmediateFail(verdict(candidate), { ...reason, role: 'candidate' })
    expect(verdict(candidate, roleRun(refPlan(), { 1: { [f(1)]: FAIL } }))).toMatchObject({ outcome: 'fail', excused: [] })
  })

  test.each([
    ['unsafe cleanup', { 1: { [f(24)]: { outcome: 'notrun', reason: 'unsafe-cleanup' } }, 2: { [f(5)]: FAIL } }, f(24), f(5)],
    ['fail-fast', { 1: { [f(24)]: { outcome: 'notrun', reason: 'fail-fast' } }, 2: { [f(5)]: FAIL } }, f(24), f(5)],
    ['a prerequisite that passed', { 1: { [f(24)]: FAIL }, 2: { [f(3)]: { outcome: 'notrun', reason: `dependency:${f(2)}` } } }, f(3), f(24)],
  ] as const)('a notrun for %s is never excused, even by a failing reference', (_label, specs, skipped, failed) => {
    const candidate = roleRun(CAND, specs)

    expectImmediateFail(verdict(candidate), { kind: 'notrun', role: 'candidate', script: skipped })
    expect(verdict(candidate, roleRun(refPlan(failed), { 1: { [failed]: FAIL } })).outcome).toBe('fail')
  })

  test('an unfinished script fails the gate with no reference run', () => {
    expectImmediateFail(verdict(roleRun(CAND, { 1: { [f(24)]: { outcome: 'unfinished' } }, 2: { [f(5)]: FAIL } })), {
      kind: 'unfinished',
      role: 'candidate',
      shard: 1,
      script: f(24),
    })
  })

  test.each([
    ['has no runner line', null],
    ['was stopped at its deadline', 'deadline'],
    ['exited without its done marker', 'exited'],
  ] as const)('a shard whose runner %s fails the gate, even when a script there failed and would go to the reference', (_label, runner) => {
    const specs = { [f(24)]: FAIL }
    const v = verdict(roleRun(CAND, { 1: specs }, { 1: { runLog: shardLog(CAND.shards[0], specs, { runner }) } }))

    expectImmediateFail(v, { kind: 'unfinished', role: 'candidate', shard: 1, script: null })
  })

  test('a second runner line fails the gate', () => {
    const log = editLog(shardLog(CAND.shards[0]), (lines) => lines.flatMap((l) => (l === 'AD-GATE-RUNNER done' ? [l, l] : [l])))

    expectImmediateFail(verdict(roleRun(CAND, {}, { 1: { runLog: log } })), { kind: 'log-problem', role: 'candidate', shard: 1 })
  })

  test.each([
    ['no outcome line', 2, (lines: string[]) => lines.filter((l) => !l.startsWith(`AD-GATE-SCRIPT ${f(5)} `)), 'missing-script', f(5)],
    ['no expect line', 2, (lines: string[]) => lines.filter((l) => l !== `AD-GATE-EXPECT ${f(5)}`), 'missing-script', f(5)],
    ['a line for a script of another shard', 1, (lines: string[]) => lines.flatMap((l) => (l === 'AD-GATE-RUNNER done' ? [scriptLine(f(5)), l] : [l])), 'extra-script', f(5)],
    ['two outcome lines', 2, (lines: string[]) => lines.flatMap((l) => (l.startsWith(`AD-GATE-SCRIPT ${f(5)} `) ? [l, l] : [l])), 'duplicate-script', f(5)],
  ] as const)('%s fails the gate', (_label, shard, edit, kind, script) => {
    const log = editLog(shardLog(CAND.shards[shard - 1]), edit)

    expectImmediateFail(verdict(roleRun(CAND, {}, { [shard]: { runLog: log } })), { kind, role: 'candidate', shard, script })
  })

  test.each([
    ['with its setup verdict', SETUP_LOG],
    ['cut before its verdict', 'ad-gate: setup failed: no manifest\n'],
  ])('a setup failure (exit 2) fails the gate, %s', (_label, runLog) => {
    const v = verdict(roleRun(CAND, { 1: { [f(24)]: FAIL } }, { 2: { state: 'failed', exitCode: 2, runLog } }))

    expectImmediateFail(v, { kind: 'setup-failed', role: 'candidate', shard: 2 })
  })

  test.each(['timed-out', 'out-of-memory', 'disk-exceeded', 'build-failed', 'cancelled', 'rejected', 'infrastructure-error', 'running', 'queued'])(
    'a shard ending %s fails the gate, whatever its log says',
    (state) => {
      expectImmediateFail(verdict(roleRun(CAND, {}, { 1: { state, exitCode: null } })), { kind: 'scheduler-state', role: 'candidate', shard: 1 })
    },
  )

  test.each([
    ['succeeded (exit 0) beside a FAIL verdict', { [f(24)]: FAIL }, { state: 'succeeded', exitCode: 0 }],
    ['failed (exit 1) beside a PASS verdict', {}, { state: 'failed', exitCode: 1 }],
    ['failed with exit 0', { [f(24)]: FAIL }, { exitCode: 0 }],
    ['succeeded with exit 1', {}, { exitCode: 1 }],
  ] as const)('a scheduler state %s fails the gate with no reference run', (_label, specs, over) => {
    expectImmediateFail(verdict(roleRun(CAND, { 1: specs }, { 1: over })), { kind: 'scheduler-state', role: 'candidate', shard: 1 })
  })

  test("a FAIL verdict line when every line passes and the runner finished fails the gate", () => {
    const run = roleRun(CAND, {}, { 1: { state: 'failed', exitCode: 1, runLog: shardLog(CAND.shards[0], {}, { verdict: 'FAIL' }) } })

    expectImmediateFail(verdict(run), { kind: 'log-problem', role: 'candidate', shard: 1 })
  })

  test('a PASS verdict line beside a failed script fails the gate with no reference run', () => {
    const specs = { [f(24)]: FAIL }
    const run = roleRun(CAND, { 1: specs }, { 1: { state: 'succeeded', exitCode: 0, runLog: shardLog(CAND.shards[0], specs, { verdict: 'PASS' }) } })

    expectImmediateFail(verdict(run), { kind: 'log-problem', role: 'candidate', shard: 1 })
  })

  test.each([
    ['an OOM kill observed', true],
    ['result.json unreadable, so an OOM kill cannot be ruled out', null],
  ] as const)('a shard with %s fails the gate', (_label, oomKilled) => {
    expectImmediateFail(verdict(roleRun(CAND, {}, { 1: { oomKilled } })), { kind: 'scheduler-state', role: 'candidate', shard: 1 })
  })

  test('a shard with no OOM kill passes', () => {
    expect(verdict(roleRun(CAND, {}, { 1: { oomKilled: false }, 2: { oomKilled: false } })).outcome).toBe('pass')
  })

  test.each([
    ['no result for a planned shard', (shards: ShardResult[]) => shards.filter((s) => s.shard !== 2), 2],
    ['two results for one shard', (shards: ShardResult[]) => [...shards, shards[1]], 2],
    ['a result for no planned shard', (shards: ShardResult[]) => [...shards, { ...shards[1], shard: 3, jobId: 'j-fixture-s3' }], 3],
  ] as const)('%s fails the gate', (_label, edit, shard) => {
    const run = roleRun(CAND)

    expectImmediateFail(verdict({ plan: CAND, shards: edit([...run.shards]) }), { kind: 'scheduler-state', role: 'candidate', shard })
  })

  test.each(UNSOUND_PLANS)('a candidate plan with %s fails the gate', (_label, p) => {
    const run = roleRun(CAND)

    expectImmediateFail(verdict({ plan: p, shards: run.shards }), { kind: 'plan-coverage', role: 'candidate' })
  })

  test('a candidate plan with no filter shard fails the gate', () => {
    const p = candWith((shards) => shards.map((shard) => ({ ...shard, filterRegression: false })))

    expectImmediateFail(verdict(roleRun(p)), { kind: 'filter', role: 'candidate', shard: null })
  })

  test('a manifest or checksum mismatch fails the gate, with no reference run', () => {
    const problems = ['candidate binary sha256 differs from the manifest']

    expectImmediateFail(verdict(roleRun(CAND), null, problems), { kind: 'manifest-mismatch', role: null })
    expect(verdict(roleRun(CAND, { 1: { [f(24)]: FAIL } }), null, problems)).toMatchObject({ outcome: 'fail', referenceScripts: [] })
  })

  test.each([
    ['no run.log', { runLog: null }, 'no-run-log'],
    ['a run.log with no verdict line', { runLog: editLog(shardLog(CAND.shards[0]), (lines) => lines.filter((l) => !l.startsWith('AD-GATE PASS'))) }, 'log-problem'],
    ['a malformed gate line', { runLog: editLog(shardLog(CAND.shards[0]), (lines) => ['AD-GATE-SCRIPT ../evil.sh pass 1', ...lines]) }, 'log-problem'],
  ] as const)('%s fails the gate', (_label, over, kind) => {
    expectImmediateFail(verdict(roleRun(CAND, {}, { 1: over })), { kind, role: 'candidate', shard: 1 })
  })

  test.each([
    ['fails', 2, shardLog(CAND.shards[1], {}, { filter: 'fail' })],
    ['is skipped in its shard', 2, shardLog(CAND.shards[1], {}, { filter: 'skipped' })],
    ['also runs in another shard', 1, shardLog(CAND.shards[0], {}, { filter: 'pass' })],
    ['has no line in a shard', 1, shardLog(CAND.shards[0], {}, { filter: null })],
  ] as const)('the filter regression %s: the gate fails', (_label, shard, runLog) => {
    expectImmediateFail(verdict(roleRun(CAND, {}, { [shard]: { runLog } })), { kind: 'filter', role: 'candidate' })
  })

  const REF = refPlan(f(24))
  test.each([
    ['its shard timed out', roleRun(REF, { 1: { [f(24)]: FAIL } }, { 1: { state: 'timed-out', exitCode: null } })],
    ['its setup failed', roleRun(REF, {}, { 1: { state: 'failed', exitCode: 2, runLog: SETUP_LOG } })],
    ['its log has no verdict line', roleRun(REF, {}, { 1: { runLog: editLog(shardLog(REF.shards[0], { [f(24)]: FAIL }), (lines) => lines.filter((l) => !l.startsWith('AD-GATE FAIL'))) } })],
    ['its runner exited without its done marker', roleRun(REF, { 1: { [f(24)]: FAIL } }, { 1: { runLog: shardLog(REF.shards[0], { [f(24)]: FAIL }, { runner: 'exited' }) } })],
    ['an OOM kill was observed there', roleRun(REF, { 1: { [f(24)]: FAIL } }, { 1: { oomKilled: true } })],
    ['its plan does not cover its scripts', { plan: { ...REF, scripts: [...REF.scripts, f(5)] }, shards: roleRun(REF, { 1: { [f(24)]: FAIL } }).shards }],
    ['it has no outcome for the failed script', roleRun(REF, {}, { 1: { runLog: editLog(shardLog(REF.shards[0]), (lines) => lines.filter((l) => !l.startsWith(`AD-GATE-SCRIPT ${f(24)} `))) } })],
    ['the failed script is unfinished there', roleRun(REF, { 1: { [f(24)]: { outcome: 'unfinished' } } })],
    ['test-1 fails there, so the failed script is skipped', roleRun(REF, { 1: { [f(1)]: FAIL, [f(24)]: { outcome: 'notrun', reason: `dependency:${f(1)}` } } })],
    ['it has no shard result', { plan: REF, shards: [] }],
  ] as const)('an incomplete reference run never passes: %s', (_label, reference) => {
    const v = verdict(roleRun(CAND, { 1: { [f(24)]: FAIL } }), reference)

    expect(v).toMatchObject({ outcome: 'fail', excused: [] })
    expectReason(v, { kind: 'reference-incomplete', role: 'reference' })
  })

  test('a candidate failure the reference only skips, behind its own failed prerequisite, is not excused', () => {
    const candidate = roleRun(CAND, { 2: { [f(3)]: FAIL } })
    const reference = roleRun(refPlan(f(2), f(3)), { 1: { [f(2)]: FAIL, [f(3)]: { outcome: 'notrun', reason: `dependency:${f(2)}` } } })
    const v = verdict(candidate, reference)

    expect(v).toMatchObject({ outcome: 'fail', excused: [] })
    expectReason(v, { kind: 'reference-incomplete', role: 'reference', script: f(3) })
  })

  test('a reference whose test-1 fails excuses nothing, even a candidate failure it runs and fails too', () => {
    const v = verdict(roleRun(CAND, { 1: { [f(24)]: FAIL } }), roleRun(REF, { 1: { [f(1)]: FAIL, [f(24)]: FAIL } }))

    expect(v).toMatchObject({ outcome: 'fail', excused: [] })
    expectReason(v, { kind: 'reference-incomplete', role: 'reference', script: f(1) })
  })
})

// --- submitCommands ---

const SETTINGS: SubmitSettings = {
  jobsched: '/opt/job-scheduler/bin/jobsched',
  context: '/gate-out/context-candidate',
  cscbVersion: '9.8.7',
  role: 'candidate',
  channel: 'C0FAKE00001',
}

/** Each option's values before `--`, by flag. */
function optionsOf(argv: readonly string[]): Map<string, string[]> {
  const options = new Map<string, string[]>()
  const end = argv.indexOf('--')
  for (let index = 2; index < end; index += 1) {
    if (!argv[index].startsWith('--')) continue
    const value = argv[index + 1]
    if (value !== undefined && !value.startsWith('--')) options.set(argv[index], [...(options.get(argv[index]) ?? []), value])
    else options.set(argv[index], [...(options.get(argv[index]) ?? [])])
  }
  return options
}

/** An argv's `--env` values, by key. */
function envOf(argv: readonly string[]): Map<string, string> {
  return new Map((optionsOf(argv).get('--env') ?? []).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
}

/** The shard an argv submits, by its `--name`'s `-s<k>`. */
function shardOf(plan: ShardPlan, argv: readonly string[]): PlannedShard {
  const name = optionsOf(argv).get('--name')![0]
  return plan.shards.find((shard) => name.endsWith(`-s${shard.shard}`))!
}

describe('submitCommands (dry run)', () => {
  test('one submit per shard, the longest expected total first, the lowest k on a tie', () => {
    const p: ShardPlan = {
      scripts: [f(1), f(5), f(24), f(26)],
      shards: [
        { shard: 1, scripts: [f(1), f(5)], expectedSeconds: 100, filterRegression: true },
        { shard: 2, scripts: [f(1), f(24)], expectedSeconds: 900, filterRegression: false },
        { shard: 3, scripts: [f(1), f(26)], expectedSeconds: 900, filterRegression: false },
      ],
    }

    expect(submitCommands(SETTINGS, p).map((argv) => optionsOf(argv).get('--name'))).toEqual([
      ['adg-9.8.7-cand-s2'],
      ['adg-9.8.7-cand-s3'],
      ['adg-9.8.7-cand-s1'],
    ])
  })

  test('each command submits its shard with the planned resources, timeout, filter switch and scripts', () => {
    const commands = submitCommands(SETTINGS, CAND)

    expect(commands).toHaveLength(CAND.shards.length)
    for (const argv of commands) {
      const shard = shardOf(CAND, argv)
      const options = optionsOf(argv)
      const timeoutMinutes = Math.ceil((2 * shard.expectedSeconds + 30 * 60) / 60)
      const env = envOf(argv)

      expect(argv.slice(0, 2)).toEqual([SETTINGS.jobsched, 'submit'])
      expect(Object.fromEntries(['--context', '--name', '--channel', '--network', '--cpus', '--memory', '--disk', '--timeout'].map((flag) => [flag, options.get(flag)]))).toEqual({
        '--context': [SETTINGS.context],
        '--name': [`adg-9.8.7-cand-s${shard.shard}`],
        '--channel': [SETTINGS.channel],
        '--network': ['off'],
        '--cpus': ['2'],
        '--memory': ['4g'],
        '--disk': ['20g'],
        '--timeout': [`${timeoutMinutes}m`],
      })
      expect(options.get('--name')![0]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
      expect(env.get('GATE_FILTER')).toBe(shard.filterRegression ? '1' : '0')
      expect(env.get('GATE_DEADLINE_S')).toMatch(/^[1-9][0-9]*$/)
      expect(Number(env.get('GATE_DEADLINE_S'))).toBeLessThan(timeoutMinutes * 60)
      expect(env.has('GATE_INJECT_FAIL')).toBe(false)
      expect(argv.slice(argv.indexOf('--') + 1)).toEqual([...shard.scripts])
    }
  })

  test('the timeout is twice the expected total plus 30 min, in whole minutes rounded up', () => {
    const p: ShardPlan = {
      scripts: [f(1), f(24), f(26)],
      shards: [
        { shard: 1, scripts: [f(1), f(24)], expectedSeconds: 1501, filterRegression: true },
        { shard: 2, scripts: [f(1), f(26)], expectedSeconds: 1500, filterRegression: false },
      ],
    }

    expect(submitCommands(SETTINGS, p).map((argv) => optionsOf(argv).get('--timeout'))).toEqual([['81m'], ['80m']])
  })

  test('a reference run names its jobs ref', () => {
    const [argv] = submitCommands({ ...SETTINGS, role: 'reference' }, refPlan(f(24)))

    expect(optionsOf(argv).get('--name')).toEqual(['adg-9.8.7-ref-s1'])
  })

  test('an injected failure is passed only to the shard that runs it, in run order', () => {
    const commands = submitCommands({ ...SETTINGS, injectFail: [f(24), f(5), f(2)] }, CAND)
    const injected = Object.fromEntries(commands.map((argv) => [shardOf(CAND, argv).shard, envOf(argv).get('GATE_INJECT_FAIL')]))

    expect(injected).toEqual({ 1: f(24), 2: `${f(2)} ${f(5)}` })
  })
})

// --- entry.sh's gate lines ---

const REPO_ROOT = join(import.meta.dir, '..')
const ENTRY_SH = readFileSync(join(REPO_ROOT, 'scripts', 'ad-gate', 'template', 'entry.sh'), 'utf8')

/** printf as entry.sh uses it: each `%s` or `%d` takes the next argument, `\n` ends the line. */
function printf(format: string, args: readonly string[]): string {
  let next = 0
  return format.replace(/%[sd]/g, () => args[next++]).replace(/\\n$/, '')
}

const SUBJECT = 'claude-slack-channel-bots 9.8.7 vs agent-director 9.9.1 (0123456789ab)'

/** One script line as parseRunLog reads it. */
function lineOf(file: string, outcome: ScriptOutcome, seconds: number | null, reason: string | null): ScriptLine[] {
  return [{ file, outcome, seconds, reason }]
}

/**
 * Each gate-line printf format entry.sh holds, as written; what parseRunLog's
 * reading of its line is taken from; and sample arguments, each with that
 * reading.
 */
const ENTRY_FORMATS: readonly (readonly [string, (log: RunLog) => unknown, readonly (readonly [readonly string[], unknown])[]])[] = [
  ['AD-GATE FAIL: setup: %s\\n', (log) => log.verdict, [[['no manifest'], 'setup-failed']]],
  ['AD-GATE-EXPECT %s\\n', (log) => log.expected, [[[f(1)], [f(1)]]]],
  [
    'AD-GATE-SCRIPT %s notrun - %s\\n',
    (log) => log.scripts,
    [
      [[f(3), `dependency:${f(2)}`], lineOf(f(3), 'notrun', null, `dependency:${f(2)}`)],
      [[f(5), 'unsafe-cleanup'], lineOf(f(5), 'notrun', null, 'unsafe-cleanup')],
      [[f(5), 'fail-fast'], lineOf(f(5), 'notrun', null, 'fail-fast')],
    ],
  ],
  ['AD-GATE-SCRIPT %s unfinished -\\n', (log) => log.scripts, [[[f(4)], lineOf(f(4), 'unfinished', null, null)]]],
  [
    'AD-GATE-SCRIPT %s %s %s\\n',
    (log) => log.scripts,
    [
      [[f(1), 'pass', '11.038'], lineOf(f(1), 'pass', 11.038, null)],
      [[f(2), 'fail', '0.017'], lineOf(f(2), 'fail', 0.017, null)],
      [[f(5), 'pass', '-'], lineOf(f(5), 'pass', null, null)],
    ],
  ],
  ['AD-GATE-RUNNER %s\\n', (log) => log.runner, [[['done'], 'done'], [['deadline'], 'deadline'], [['exited'], 'exited']]],
  ['AD-GATE-FILTER %s\\n', (log) => log.filter, [[['pass'], 'pass'], [['fail'], 'fail'], [['skipped'], 'skipped']]],
  [
    'AD-GATE PASS: %s: %d/%d no-model integration scripts passed; permission filter regression %s\\n',
    (log) => log.verdict,
    [
      [[SUBJECT, '3', '3', 'passed'], 'pass'],
      [[SUBJECT, '3', '3', 'skipped (another shard runs it)'], 'pass'],
    ],
  ],
  ['AD-GATE FAIL: %s: %s\\n', (log) => log.verdict, [[[SUBJECT, `1/3 scripts passed; failed: ${f(2)}`], 'fail']]],
]

describe("entry.sh's gate lines", () => {
  test('entry.sh prints gate lines with exactly these printf formats', () => {
    const found = [...ENTRY_SH.matchAll(/printf '(AD-GATE[^']*)'/g)].map((match) => match[1])

    expect([...new Set(found)].sort()).toEqual(ENTRY_FORMATS.map(([format]) => format).sort())
  })

  test.each(ENTRY_FORMATS.flatMap(([format, read, samples]) => samples.map(([args, reading]) => [printf(format, args), format, read, reading] as const)))(
    'parseRunLog reads %s as written',
    (line, format, read, reading) => {
      const verdictLine = format.startsWith('AD-GATE ')
      const log = parseRunLog(verdictLine ? `${line}\n` : `${line}\nAD-GATE PASS: fixture\n`)

      expect(log.problems).toEqual([])
      expect(read(log)).toEqual(reading)
    },
  )

  test("its manifest line is `ad-gate: manifest: <json>`, which the driver compares with the context's manifest", () => {
    expect(ENTRY_SH).toMatch(/^say\(\) \{ printf 'ad-gate: %s\\n' "\$\*"; \}$/m)
    expect(ENTRY_SH).toMatch(/^say "manifest: \$\(jq -c \. "\$\{MANIFEST\}"\)"$/m)
  })
})

// --- The command line, over a fake scheduler ---

/** What a command-line run's fakes read (tests/fixtures/ad-gate/fake-jobsched.ts and fake-prepare.ts). */
interface FakeScenario {
  readonly tagCommit: string
  /** Each script of the fake tag and its `# ci-requires:` words, or null. */
  readonly scripts: Readonly<Record<string, string | null>>
  readonly durations: string
  /** Scripts (test-<n>) each role's jobs fail. */
  readonly fail: { readonly cand: readonly string[]; readonly ref: readonly string[] }
  /** The CSCB release `fail` and `badInputs` apply to; every release when absent. */
  readonly onlyRelease?: string
  /** `jobsched list`'s slots: 6, none active or queued, when absent. */
  readonly slots?: { readonly limit: number; readonly active: number; readonly queued: number }
  /** `jobsched list`'s output, as written, in place of the slots. */
  readonly listOutput?: string
  /** `jobsched list` fails (exit 4). */
  readonly listFails?: boolean
  /** The role whose prepared manifest gets a wrong binary sha256. */
  readonly badInputs?: 'cand' | 'ref'
  /** The role whose jobs print a manifest other than their context's. */
  readonly badManifestLine?: 'cand' | 'ref'
  /** The first `jobsched wait` fails. */
  readonly failWaitOnce?: boolean
  /** Job names to end on successive successful waits; after these batches, end all requested jobs. */
  readonly waitBatches?: readonly (readonly string[])[]
  /** The role whose jobs' result.json reports an OOM kill. */
  readonly oomKilled?: 'cand' | 'ref'
  /** The role whose jobs keep no result.json. */
  readonly noResult?: 'cand' | 'ref'
  /** The role whose jobs `status` shows under another name. */
  readonly wrongName?: 'cand' | 'ref'
  /** The role whose jobs `status` shows with another context directory. */
  readonly wrongContextDir?: 'cand' | 'ref'
  /** The role whose jobs each have a context hash of their own. */
  readonly contextHashDiffers?: 'cand' | 'ref'
  /** The reference is prepared with another CSCB package than the candidate. */
  readonly refCscbDiffers?: boolean
}

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'ad-gate')
const CSCB_VERSION = '9.8.7'
/** A second CSCB release, tagged on the same commit, for the runs gating two releases together. */
const SECOND_CSCB_VERSION = '9.8.6'
const CANDIDATE_VERSION = '9.9.1'
const REFERENCE_TAG = 'v9.9.0'

/**
 * The fake tag: three units the gate runs (test-2 and test-3, test-5, test-6),
 * so three shards, the filter going to test-2/test-3's; and test-13 and a
 * `-fmk-real-` script, which it never runs.
 */
const CLI_SCRIPTS: Readonly<Record<string, string | null>> = {
  'test-1-install-startup.sh': null,
  'test-2-first.sh': null,
  'test-3-second.sh': 'test-2',
  'test-5-alpha.sh': null,
  'test-6-beta.sh': null,
  'test-13-switch-over.sh': null,
  'test-32-fmk-real-order.sh': null,
}
const CLI_DURATIONS = durationsText([[1, 10], [2, 5], [3, 5], [5, 100], [6, 50]])

/**
 * A context with six units, so the shard count the slots choose shows in the
 * plan; its scripts plan 260 s in all, test-1 counted once.
 */
const SLOT_SCRIPTS: Readonly<Record<string, string | null>> = { ...CLI_SCRIPTS, 'test-7-gamma.sh': null, 'test-8-delta.sh': null, 'test-9-epsilon.sh': null }
const SLOT_DURATIONS = durationsText([[1, 10], [2, 5], [3, 5], [5, 100], [6, 50], [7, 40], [8, 30], [9, 20]])
const SLOT_WORK_SECONDS = 260

/** A fake tag script's text, as fake-prepare.ts writes it into a context: the tag and the context agree. */
function tagScriptText(requires: string | null): string {
  return ['#!/usr/bin/env bash', '# fixture integration script', ...(requires === null ? [] : [`# ci-requires: ${requires}`]), 'exit 0', ''].join('\n')
}

/** What the kit loads at run time, copied into the scratch repository; prepare.sh is the fake's. */
const KIT_COPY = ['scripts/ad-gate/ad-gate.ts', 'scripts/ad-gate/template', 'scripts/ci-run.ts', 'scripts/codex-login.ts', 'scripts/safe-docker-inspect.ts', 'src/codex-config-keys.ts']

/**
 * One command-line run's limit. A run with a reference launches about 25
 * processes (Bun on the driver, git, bash and Bun for each fake call): about
 * 1 s on a host where a launch costs ~30 ms, more with the runs sharing the CPU.
 * The whole shared hook measured 0.3 s on the development host.
 */
const CLI_RUN_LIMIT_MS = 30_000

/**
 * Backstop for the shared hook: it builds the scratch repository and runs
 * every command-line case concurrently, the resumed ones twice in turn.
 * Above twice `CLI_RUN_LIMIT_MS`, so a stuck run is killed and fails its own
 * test's assertions first.
 */
const CLI_SETUP_TIMEOUT_MS = 75_000

interface CliRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly out: string
  /** Every fake `jobsched` call's arguments, in order. */
  readonly calls: readonly (readonly string[])[]
  /** Every fake prepare.sh call's role, in order. */
  readonly prepared: readonly string[]
}

let root = ''
let repo = ''
let home = ''
let jobsched = ''
let dist = ''
/** A candidate dist holding no install.sh. */
let bareDist = ''

/** `git` in the scratch repository's environment; its stdout. */
function git(args: readonly string[]): string {
  const result = Bun.spawnSync([join(resolveToolDir('git') ?? '', 'git'), ...args], {
    env: hostSafeChildEnv(home, { tools: ['git'], extras: { GIT_CONFIG_NOSYSTEM: '1' } }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/** A shell word for the wrappers the setup writes. */
function quoted(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * Builds the scratch repository: the kit copy with a fake prepare.sh and the
 * fake tag's tests/integration and duration table, the CSCB tag and the
 * reference tag; the fake jobsched; and two candidate dists, one without
 * install.sh. Returns the CSCB tag's commit.
 */
function buildScratchKit(): string {
  root = mkdtempSync(join(tmpdir(), 'ad-gate-cli-'))
  home = join(root, 'home')
  repo = join(root, 'repo')
  dist = join(root, 'dist')
  bareDist = join(root, 'bare-dist')
  jobsched = join(root, 'bin', 'jobsched')
  for (const dir of [home, dist, bareDist, join(root, 'bin'), join(repo, 'tests', 'integration')]) mkdirSync(dir, { recursive: true })
  for (const path of KIT_COPY) cpSync(join(REPO_ROOT, path), join(repo, path), { recursive: true })
  for (const [fileName, requires] of Object.entries(CLI_SCRIPTS)) writeFileSync(join(repo, 'tests', 'integration', fileName), tagScriptText(requires))
  writeFileSync(join(repo, 'tests', 'ci-durations.tsv'), CLI_DURATIONS)
  writeFileSync(join(repo, 'scripts', 'ad-gate', 'prepare.sh'), `#!/usr/bin/env bash\nexec ${quoted(process.execPath)} ${quoted(join(FIXTURE_DIR, 'fake-prepare.ts'))} "$@"\n`)
  writeFileSync(jobsched, `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(join(FIXTURE_DIR, 'fake-jobsched.ts'))} "$@"\n`)
  chmodSync(jobsched, 0o755)
  writeFileSync(join(dist, 'install.sh'), 'fixture installer (never run)\n')
  git(['init', '-q', repo])
  git(['-C', repo, 'add', '-A'])
  git(['-C', repo, '-c', 'user.name=ad-gate test', '-c', 'user.email=ad-gate-test@example.invalid', 'commit', '-q', '-m', 'kit'])
  git(['-C', repo, 'tag', `v${CSCB_VERSION}`])
  git(['-C', repo, 'tag', `v${SECOND_CSCB_VERSION}`])
  git(['-C', repo, 'tag', REFERENCE_TAG])
  return git(['-C', repo, 'rev-parse', `v${CSCB_VERSION}^{commit}`])
}

/** The gate's arguments for a run writing to `out` with the candidate in `candidateDist`, then `extra`. */
function gateArgs(out: string, extra: readonly string[], candidateDist: string): string[] {
  return [
    '--candidate-dist', candidateDist, '--candidate-version', CANDIDATE_VERSION, '--reference-tag', REFERENCE_TAG,
    '--cscb-version', CSCB_VERSION, '--channel', 'C0FAKE00001', '--out', out, '--ad-repo', repo, '--jobsched', jobsched,
    ...extra,
  ]
}

function jsonLines<T>(path: string): T[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as T) : []
}

/** After a kill, how long to wait for the run's output: a child it left behind can hold the pipes open. */
const KILLED_OUTPUT_GRACE_MS = 1_000

/**
 * Runs the driver once in `dir` (its scenario beside its `out`). The runs
 * share the scratch repository, so its git commands take no optional lock.
 */
async function runGate(dir: string, extra: readonly string[], candidateDist: string = dist): Promise<CliRun> {
  const out = join(dir, 'out')
  const child = Bun.spawn([process.execPath, join(repo, 'scripts', 'ad-gate', 'ad-gate.ts'), ...gateArgs(out, extra, candidateDist)], {
    env: hostSafeChildEnv(home, {
      tools: ['git', 'bash'],
      extras: { AD_GATE_FAKE_SCENARIO: join(dir, 'scenario.json'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: CLI_RUN_LIMIT_MS,
    killSignal: 'SIGKILL',
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  const [stdout, stderr] =
    child.signalCode === null ? await output : await Promise.race([output, Bun.sleep(KILLED_OUTPUT_GRACE_MS).then((): [string, string] => ['', `killed by ${child.signalCode}`])])
  return {
    code,
    stdout,
    stderr,
    out,
    calls: jsonLines<string[]>(join(dir, 'jobsched-calls.jsonl')),
    prepared: jsonLines<{ role: string }>(join(dir, 'prepare-calls.jsonl')).map((call) => call.role),
  }
}

/** A run directory with its scenario: every script passes unless `scenario` says otherwise. */
function scenarioDir(name: string, scenario: Partial<FakeScenario>, tagCommit: string): string {
  const dir = join(root, 'runs', name)
  mkdirSync(dir, { recursive: true })
  const full: FakeScenario = { tagCommit, scripts: CLI_SCRIPTS, durations: CLI_DURATIONS, fail: { cand: [], ref: [] }, ...scenario }
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(full))
  return dir
}

/** The submit calls' `--name`s, in order. */
function submittedNames(run: CliRun): string[] {
  return run.calls.filter((call) => call[0] === 'submit').map((call) => call[call.indexOf('--name') + 1])
}

/** The submit call for a job name. */
function submitCall(run: CliRun, name: string): readonly string[] {
  return run.calls.find((call) => call[0] === 'submit' && call[call.indexOf('--name') + 1] === name)!
}

interface ReleaseVerdict {
  readonly outcome: string
  readonly release: boolean
  readonly kit: { readonly revision: string; readonly dirty: boolean; readonly files: Readonly<Record<string, string>> } | null
  readonly reference: { readonly ran: boolean }
  readonly verdict: GateVerdict
}

function releaseVerdict(run: CliRun, cscbVersion: string = CSCB_VERSION): ReleaseVerdict {
  return JSON.parse(readFileSync(join(run.out, `cscb-${cscbVersion}`, 'verdict.json'), 'utf8')) as ReleaseVerdict
}

/** The fields of a run's state.json these tests read. */
interface RecordedState {
  readonly shardChoice: ShardChoice | null
  readonly versions: Readonly<Record<string, { readonly candidate: { readonly jobs: Readonly<Record<string, string>> }; readonly reference: { readonly jobs: Readonly<Record<string, string>> } | null }>>
}

function stateOf(run: CliRun): RecordedState {
  return JSON.parse(readFileSync(join(run.out, 'state.json'), 'utf8')) as RecordedState
}

/** The driver's one slot reading. */
const LIST_CALL = ['list', '--json', '--limit', '1']

/** How many times a run read the slots. */
function listCalls(run: CliRun): number {
  return run.calls.filter((call) => call[0] === 'list').length
}

/** The job IDs a `wait` call names. */
function waitedIds(call: readonly string[]): string[] {
  return call.filter((arg) => /^j[0-9]{14}-[0-9a-f]{6}$/.test(arg))
}

function kinds(v: GateVerdict): string[] {
  return v.reasons.map((reason) => reason.kind)
}

/** Asserts `v` holds a reason of `kind` whose detail matches `detail`. */
function expectDetail(v: GateVerdict, kind: string, detail: RegExp): void {
  expect(v.reasons.filter((reason) => reason.kind === kind).map((reason) => reason.detail)).toEqual(expect.arrayContaining([expect.stringMatching(detail)]))
}

/**
 * Asserts a run stopped with the line `ad-gate: <message>` (exit 2, no kit-bug
 * line) before preparing anything or calling the scheduler; a message ending
 * in `: ` stands for that text followed by a reason.
 */
function expectRefusedUpFront(run: CliRun, message: string): void {
  const line = `ad-gate: ${message}`
  const lines = run.stderr.split('\n')

  expect([run.code, run.prepared, run.calls]).toEqual([2, [], []])
  expect(message.endsWith(': ') ? lines.filter((each) => each.startsWith(line) && each.length > line.length) : lines.filter((each) => each === line)).toHaveLength(1)
  expect(run.stderr).not.toContain('(unexpected error)')
}

const CAND_NAMES = ['adg-9.8.7-cand-s1', 'adg-9.8.7-cand-s2', 'adg-9.8.7-cand-s3']

/** A run's state.json path, which the resumed-state cases write before the run. */
function statePath(name: string): string {
  return join(root, 'runs', name, 'out', 'state.json')
}

/** A run's candidate context. */
function candidateContext(name: string): string {
  return join(root, 'runs', name, 'out', `cscb-${CSCB_VERSION}`, 'candidate', 'context')
}

/** The not-runnable reason the driver gives for test-13 and `-fmk-real-` scripts. */
const NOT_RUNNABLE = 'cannot run in the gate: -fmk-real- scripts need a model and test-13 needs the npm registry'

describe('the command line over a fake scheduler', () => {
  const runs: Record<string, CliRun> = {}
  let tagCommit = ''

  beforeAll(async () => {
    tagCommit = buildScratchKit()
    const twice = async (name: string, scenario: Partial<FakeScenario>, extra: readonly string[] = []): Promise<void> => {
      const dir = scenarioDir(name, scenario, tagCommit)
      runs[name] = await runGate(dir, extra)
      runs[`${name}-resumed`] = await runGate(dir, [...extra, '--resume'])
    }
    /** A finished run, then `edit` on its candidate context, then the run resumed. */
    const resumedAfter = async (name: string, edit: (context: string) => void): Promise<void> => {
      const dir = scenarioDir(name, {}, tagCommit)
      runs[name] = await runGate(dir, [])
      edit(candidateContext(name))
      runs[`${name}-resumed`] = await runGate(dir, ['--resume'])
    }
    /** One run; `before` gets its `--out` path first. */
    const once = async (
      name: string,
      scenario: Partial<FakeScenario>,
      extra: readonly string[] = [],
      setup: { readonly before?: (out: string) => void; readonly dist?: string } = {},
    ): Promise<void> => {
      const dir = scenarioDir(name, scenario, tagCommit)
      setup.before?.(join(dir, 'out'))
      runs[name] = await runGate(dir, extra, setup.dist)
    }
    /** A `--resume` run over a state.json holding `text`. */
    const resumedState = (name: string, text: string): Promise<void> =>
      once(name, {}, ['--resume'], {
        before: (out) => {
          mkdirSync(out, { recursive: true })
          writeFileSync(join(out, 'state.json'), text)
        },
      })
    /** A run, then the fake's slots changed to `slotsAfter`, then the run resumed. */
    const resumedWithSlots = async (name: string, scenario: Partial<FakeScenario>, slotsAfter: FakeScenario['slots']): Promise<void> => {
      const dir = scenarioDir(name, scenario, tagCommit)
      runs[name] = await runGate(dir, [])
      scenarioDir(name, { ...scenario, slots: slotsAfter }, tagCommit)
      runs[`${name}-resumed`] = await runGate(dir, ['--resume'])
    }
    /** A dry run, then the real run with `--resume`. */
    const dryRunThenResumed = async (name: string): Promise<void> => {
      const dir = scenarioDir(name, {}, tagCommit)
      runs[name] = await runGate(dir, ['--dry-run'])
      runs[`${name}-resumed`] = await runGate(dir, ['--resume'])
    }
    const slotScenario = { scripts: SLOT_SCRIPTS, durations: SLOT_DURATIONS }
    const twoReleases = ['--cscb-version', SECOND_CSCB_VERSION]
    await Promise.all([
      // The shard count from the free slots (engineer fix round 3).
      once('slot-choice', { ...slotScenario, slots: { limit: 6, active: 1, queued: 0 } }),
      once('shards-option', {}, ['--shards', '2']),
      resumedWithSlots('resume-slots', { ...slotScenario, slots: { limit: 6, active: 0, queued: 2 }, failWaitOnce: true }, { limit: 12, active: 0, queued: 0 }),
      dryRunThenResumed('dry-run-then-resume'),
      once('list-bad-count', { listOutput: '{"summary": {"active_slots_limit": 6, "active_slots_used": -1, "queued": 0}, "jobs": []}' }),
      once('list-no-summary', { listOutput: '{"jobs": []}' }),
      once('list-not-json', { listOutput: 'jobs: none' }),
      once('list-not-object', { listOutput: '[]' }),
      once('list-fails', { listFails: true }),
      // Releases submitted together.
      once('two-releases', {}, twoReleases),
      once('two-releases-one-reference', { fail: { cand: ['test-5'], ref: ['test-5'] }, onlyRelease: SECOND_CSCB_VERSION }, twoReleases),
      once('two-releases-staged-reference', {
        fail: { cand: ['test-5'], ref: ['test-5'] },
        onlyRelease: CSCB_VERSION,
        waitBatches: [CAND_NAMES, [`adg-${CSCB_VERSION}-ref-s1`, ...[1, 2, 3].map((k) => `adg-${SECOND_CSCB_VERSION}-cand-s${k}`)]],
      }, twoReleases),
      once('two-releases-bad-inputs', { badInputs: 'cand', onlyRelease: SECOND_CSCB_VERSION }, twoReleases),
      // Wrong evidence (review round 2, finding 3).
      once('oom-killed', { oomKilled: 'cand' }),
      once('no-result', { noResult: 'cand' }),
      once('wrong-name', { wrongName: 'cand' }),
      once('wrong-context-dir', { wrongContextDir: 'cand' }),
      once('context-hash-differs', { contextHashDiffers: 'cand' }),
      once('reference-cscb-differs', { fail: { cand: ['test-5'], ref: ['test-5'] }, refCscbDiffers: true }),
      once('only-fail', { fail: { cand: ['test-5'], ref: [] } }, ['--only', 'test-5']),
      once('duration-notes', { durations: durationsText([[1, 10], [2, 5], [3, 5], [6, 50]], ['test-5\tabc']) }, ['--dry-run']),
      resumedAfter('resume-template-edit', (context) => appendFileSync(join(context, 'Dockerfile'), '# edited after the jobs were submitted\n')),
      resumedAfter('resume-plan-change', (context) =>
        writeFileSync(join(context, 'inputs', 'cscb-src', 'tests', 'ci-durations.tsv'), durationsText([[1, 10], [2, 5], [3, 5], [5, 7], [6, 50]])),
      ),
      // Input checked before prepare (engineer fix round 2, finding 4).
      once('missing-durations', {}, ['--durations', join(root, 'no-such-durations.tsv')]),
      resumedState('state-not-json', '{'),
      resumedState('state-not-object', '[]\n'),
      resumedState('state-wrong-shape', '{"options": 1}\n'),
      once('out-is-file', {}, [], { before: (out) => writeFileSync(out, 'not a directory\n') }),
      once('unknown-cscb-tag', {}, ['--cscb-version', '1.2.3']),
      once('missing-install-sh', {}, ['--candidate-install-sh', join(root, 'no-such-install.sh')]),
      once('commit-without-installer', {}, ['--candidate-commit', tagCommit], { dist: bareDist }),
      once('only-unknown', {}, ['--only', 'test-99']),
      once('only-test-13', {}, ['--only', 'test-13']),
      once('only-real-agent', {}, ['--only', 'test-32']),
      once('inject-unknown', {}, ['--inject-fail', 'test-99']),
      once('inject-unplanned', {}, ['--only', 'test-6', '--inject-fail', 'test-5']),
      // Flow.
      once('dry-run', {}, ['--dry-run']),
      once('dry-run-bad-inputs', { badInputs: 'cand' }, ['--dry-run']),
      once('bad-inputs', { badInputs: 'cand' }),
      twice('pass', {}),
      twice('wait-interrupted', { failWaitOnce: true }),
      once('shared-failure', { fail: { cand: ['test-5'], ref: ['test-5'] } }),
      once('candidate-only-failure', { fail: { cand: ['test-5'], ref: [] } }),
      once('bad-reference-inputs', { fail: { cand: ['test-5'], ref: ['test-5'] }, badInputs: 'ref' }),
      once('bad-manifest-line', { badManifestLine: 'cand' }),
      once('only', {}, ['--only', 'test-6']),
      once('inject-fail', { fail: { cand: [], ref: ['test-5'] } }, ['--inject-fail', 'test-5']),
    ])
  }, CLI_SETUP_TIMEOUT_MS)

  afterAll(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true })
  })

  test('a dry run prepares and plans the candidate, reads the slots once, prints its shard choice and submit commands, and records no choice', () => {
    const run = runs['dry-run']
    const printed = run.stdout.split('\n').filter((line) => line.startsWith(`${jobsched} submit `))

    expect([run.code, run.calls, run.prepared]).toEqual([0, [LIST_CALL], ['cand']])
    expect(run.stdout).toMatch(/^ad-gate: shards: 6 candidate shards per release, from 6 free scheduler slots \(6 slots, 0 active, 0 queued at /m)
    expect(printed.map((line) => /--name (\S+)/.exec(line)?.[1]).sort()).toEqual(CAND_NAMES)
    expect(existsSync(join(run.out, `cscb-${CSCB_VERSION}`, 'candidate', 'submit-commands.txt'))).toBe(true)
    expect(existsSync(join(run.out, `cscb-${CSCB_VERSION}`, 'verdict.json'))).toBe(false)
    expect(stateOf(run).shardChoice).toBeNull()
  })

  test('a dry run whose inputs differ from the manifest exits 1 and submits nothing', () => {
    const run = runs['dry-run-bad-inputs']

    expect([run.code, run.calls]).toEqual([1, [LIST_CALL]])
  })

  test('inputs that differ from the manifest fail the gate before anything is submitted', () => {
    const run = runs['bad-inputs']
    const v = releaseVerdict(run)

    expect([run.code, run.calls, run.prepared]).toEqual([1, [LIST_CALL], ['cand']])
    expect(v.outcome).toBe('fail')
    expect(kinds(v.verdict).length).toBeGreaterThan(0)
    expect(new Set(kinds(v.verdict))).toEqual(new Set(['manifest-mismatch']))
  })

  test('a passing candidate: every shard submitted once, the reference neither prepared nor run', () => {
    const run = runs['pass']
    const v = releaseVerdict(run)

    expect([run.code, run.prepared]).toEqual([0, ['cand']])
    expect([...submittedNames(run)].sort()).toEqual(CAND_NAMES)
    expect([v.outcome, v.release, v.reference.ran, v.verdict.reasons]).toEqual(['pass', true, false, []])
    expect(existsSync(join(run.out, `cscb-${CSCB_VERSION}`, 'reference'))).toBe(false)
    expect((JSON.parse(readFileSync(join(run.out, 'verdict.json'), 'utf8')) as { outcome: string }).outcome).toBe('pass')
  })

  test("verdict.json records the kit's revision, that it is clean, and each kit file's sha256", () => {
    const kitFiles = [
      ...readdirSync(join(repo, 'scripts', 'ad-gate', 'template')).map((file) => `scripts/ad-gate/template/${file}`),
      'scripts/ad-gate/prepare.sh',
      'scripts/ad-gate/ad-gate.ts',
      'scripts/ci-run.ts',
    ]
    const sha256 = (path: string): string => createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')

    expect(releaseVerdict(runs['pass']).kit).toEqual({
      revision: git(['-C', repo, 'rev-parse', 'HEAD']),
      dirty: false,
      files: Object.fromEntries(kitFiles.map((path) => [path, sha256(path)])),
    })
  })

  test('--resume after a finished run submits and prepares nothing again and gives the same verdict', () => {
    const run = runs['pass-resumed']

    expect([run.code, run.prepared]).toEqual([0, ['cand']])
    expect([...submittedNames(run)].sort()).toEqual(CAND_NAMES)
    expect(releaseVerdict(run).outcome).toBe('pass')
  })

  test('--resume after an interrupted wait collects the submitted jobs without submitting any again', () => {
    const first = runs['wait-interrupted']
    const resumed = runs['wait-interrupted-resumed']

    expect(first.code).toBe(2)
    expect([...submittedNames(first)].sort()).toEqual(CAND_NAMES)
    expect([resumed.code, [...submittedNames(resumed)].sort(), resumed.prepared]).toEqual([0, CAND_NAMES, ['cand']])
    expect(releaseVerdict(resumed).outcome).toBe('pass')
  })

  test('a candidate failure the reference shares: the reference is prepared and runs just that script and test-1, and the gate passes', () => {
    const run = runs['shared-failure']
    const v = releaseVerdict(run)
    const refNames = submittedNames(run).filter((name) => name.includes('-ref-'))

    expect([run.code, run.prepared]).toEqual([0, ['cand', 'ref']])
    expect(refNames).toEqual(['adg-9.8.7-ref-s1'])
    const call = submitCall(run, 'adg-9.8.7-ref-s1')
    expect(call.slice(call.indexOf('--') + 1)).toEqual(['test-1-install-startup.sh', 'test-5-alpha.sh'])
    expect([v.outcome, v.reference.ran, v.verdict.excused]).toEqual(['pass', true, ['test-5-alpha.sh']])
  })

  test('a candidate failure the reference passes fails the gate', () => {
    const run = runs['candidate-only-failure']
    const v = releaseVerdict(run)

    expect([run.code, run.prepared, v.outcome, v.reference.ran]).toEqual([1, ['cand', 'ref'], 'fail', true])
    expect(v.verdict.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'candidate-failure', script: 'test-5-alpha.sh' })]))
  })

  test('reference inputs that differ from the manifest fail the gate before the reference is submitted', () => {
    const run = runs['bad-reference-inputs']

    expect([run.code, run.prepared]).toEqual([1, ['cand', 'ref']])
    expect(submittedNames(run).filter((name) => name.includes('-ref-'))).toEqual([])
    expect(kinds(releaseVerdict(run).verdict)).toContain('manifest-mismatch')
  })

  test('a job whose run.log shows another manifest than its context fails the gate', () => {
    const run = runs['bad-manifest-line']

    expect(run.code).toBe(1)
    expect(kinds(releaseVerdict(run).verdict)).toContain('manifest-mismatch')
  })

  test('--only runs the subset and its pass is no release pass: exit 3', () => {
    const run = runs['only']
    const v = releaseVerdict(run)
    const scripts = run.calls.filter((call) => call[0] === 'submit').flatMap((call) => call.slice(call.indexOf('--') + 1))

    expect(run.code).toBe(3)
    expect([...new Set(scripts)].sort()).toEqual(['test-1-install-startup.sh', 'test-6-beta.sh'])
    expect([v.outcome, v.release]).toEqual(['non-release-pass', false])
    expect(run.stdout).toMatch(/verdict: NON-RELEASE PASS/)
  })

  test('--inject-fail reaches only the candidate shard that runs the script, and its pass is no release pass: exit 3', () => {
    const run = runs['inject-fail']
    const v = releaseVerdict(run)
    const injectedEnv = run.calls
      .filter((call) => call[0] === 'submit')
      .map((call) => [call[call.indexOf('--name') + 1], call.filter((arg) => arg.startsWith('GATE_INJECT_FAIL='))] as const)
      .filter(([, env]) => env.length > 0)

    expect(run.code).toBe(3)
    expect(injectedEnv).toEqual([[expect.stringMatching(/-cand-s/), ['GATE_INJECT_FAIL=test-5-alpha.sh']]])
    expect([v.outcome, v.release, v.reference.ran, v.verdict.excused]).toEqual(['non-release-pass', false, true, ['test-5-alpha.sh']])
  })

  test('a FAIL of an --only run is labelled as no release verdict', () => {
    const run = runs['only-fail']
    const v = releaseVerdict(run)

    expect([run.code, v.outcome, v.release]).toEqual([1, 'fail', false])
    expect(run.stdout).toContain('ad-gate: verdict: FAIL (not a release verdict: --only test-5 ran a subset of the scripts)')
  })

  test.each([
    ['an OOM kill in a job (result.json)', 'oom-killed', 'scheduler-state', /observed an OOM kill/],
    ['a job that kept no result.json', 'no-result', 'scheduler-state', /result\.json could not be read/],
    ['a job under another name', 'wrong-name', 'manifest-mismatch', /is named adg-9\.8\.7-cand-s[0-9]+-other, not adg-9\.8\.7-cand-s[0-9]+/],
    ['a job that ran another context directory', 'wrong-context-dir', 'manifest-mismatch', /ran context .*-other, not /],
    ['jobs that ran different contexts', 'context-hash-differs', 'manifest-mismatch', /context_sha256 differs/],
  ] as const)('%s fails the gate though every script passed', (_label, name, kind, detail) => {
    const run = runs[name]
    const v = releaseVerdict(run)

    expect([run.code, v.outcome]).toEqual([1, 'fail'])
    expectDetail(v.verdict, kind, detail)
  })

  test('a reference prepared from another CSCB package than the candidate fails the gate before the reference is submitted', () => {
    const run = runs['reference-cscb-differs']

    expect([run.code, run.prepared]).toEqual([1, ['cand', 'ref']])
    expect(submittedNames(run).filter((name) => name.includes('-ref-'))).toEqual([])
    expectDetail(releaseVerdict(run).verdict, 'manifest-mismatch', /the reference context tests another CSCB package or tag than the candidate/)
  })

  test("the context's duration-table notes are printed", () => {
    const run = runs['duration-notes']

    expect(run.code).toBe(0)
    expect(run.stdout).toContain(`ad-gate: CSCB ${CSCB_VERSION} candidate: ${durationLineIgnoredNote(6, { kind: 'bad-seconds', seconds: 'abc' })}\n`)
  })

  test.each([
    ['a template file changed', 'resume-template-edit', "the candidate context's Dockerfile differ from the kit's, and jobs were submitted from it: start a new --out"],
    ['a plan the context no longer gives', 'resume-plan-change', 'the candidate plan recorded in state.json differs from the one its context gives now, and jobs were submitted from it: start a new --out'],
  ] as const)('--resume refuses a run whose jobs were submitted with %s, submitting nothing again', (_label, name, message) => {
    const first = runs[name]
    const resumed = runs[`${name}-resumed`]

    expect(first.code).toBe(0)
    expect(resumed.code).toBe(2)
    expect(resumed.stderr).toContain(`ad-gate: ${message}\n`)
    expect(resumed.stderr).not.toContain('(unexpected error)')
    expect([...submittedNames(resumed)].sort()).toEqual(CAND_NAMES)
  })

  /** Each refusal before prepare: its case, its run and its message (paths are known only once the hook ran). */
  const UP_FRONT_REFUSALS: readonly (readonly [string, string, () => string])[] = [
    ['a missing --durations file', 'missing-durations', () => `--durations ${join(root, 'no-such-durations.tsv')} cannot be read: no such file or directory (ENOENT)`],
    ['a state.json that is not JSON', 'state-not-json', () => `--resume: ${statePath('state-not-json')} is not JSON: `],
    ['a state.json that is no JSON object', 'state-not-object', () => `--resume: ${statePath('state-not-object')} is not a JSON object`],
    ['a state.json of another shape', 'state-wrong-shape', () => `--resume: ${statePath('state-wrong-shape')} is not an ad-gate state file`],
    ['an --out that is a file', 'out-is-file', () => `--out ${join(root, 'runs', 'out-is-file', 'out')} is not a directory`],
    ['a CSCB release with no tag in the kit checkout', 'unknown-cscb-tag', () => "claude-slack-channel-bots 1.2.3 has no tag v1.2.3 in the kit's checkout: fetch its tags"],
    ['a missing --candidate-install-sh', 'missing-install-sh', () => `--candidate-install-sh ${join(root, 'no-such-install.sh')} is no file`],
    [
      '--candidate-commit with no installer at that commit, the dist holding none',
      'commit-without-installer',
      () => `--candidate-commit ${tagCommit}: the AD checkout ${repo} has no ${tagCommit}:skills/install-agent-director/install.sh`,
    ],
    ['--only naming no script of the tag', 'only-unknown', () => '--only test-99 names no integration script of claude-slack-channel-bots 9.8.7'],
    ['--only naming test-13', 'only-test-13', () => `--only test-13 names test-13-switch-over.sh, which ${NOT_RUNNABLE}`],
    ['--only naming a -fmk-real- script', 'only-real-agent', () => `--only test-32 names test-32-fmk-real-order.sh, which ${NOT_RUNNABLE}`],
    ['--inject-fail naming no script of the tag', 'inject-unknown', () => '--inject-fail test-99 names no integration script of claude-slack-channel-bots 9.8.7'],
    ['--inject-fail naming a script outside the --only plan', 'inject-unplanned', () => '--inject-fail test-5 is not a planned script'],
  ]

  test.each(UP_FRONT_REFUSALS)('%s stops the gate (exit 2) before anything is prepared or submitted', (_label, name, message) => {
    expectRefusedUpFront(runs[name], message())
  })

  test('without --shards, the count is the fastest of 4-6 for the free slots, recorded with its reading and estimate and stated in the log and report.md', () => {
    const run = runs['slot-choice']
    const choice = stateOf(run).shardChoice
    const readAt = choice?.reading?.readAt ?? ''
    const text =
      `5 candidate shards per release, from 5 free scheduler slots (6 slots, 1 active, 0 queued at ${readAt}) shared by 1 release(s): ` +
      'an estimated 0.9 min (5 jobs in 1 round(s) of 0.9 min; the longest release plans 4.3 min of scripts), the fastest of 4-6'

    expect([run.code, listCalls(run)]).toEqual([0, 1])
    expect(choice).toEqual({
      source: 'slots',
      reading: { readAt: expect.any(String), limit: 6, active: 1, queued: 0, free: 5 },
      releases: 1,
      perRelease: 5,
      estimate: { perRelease: 5, jobs: 5, rounds: 1, seconds: SLOT_WORK_SECONDS / 5, workSeconds: SLOT_WORK_SECONDS },
    })
    expect(Number.isNaN(Date.parse(readAt))).toBe(false)
    expect([...submittedNames(run)].sort()).toEqual([1, 2, 3, 4, 5].map((k) => `adg-${CSCB_VERSION}-cand-s${k}`))
    expect(run.stdout).toContain(`ad-gate: shards: ${text}\n`)
    expect(readFileSync(join(run.out, `cscb-${CSCB_VERSION}`, 'report.md'), 'utf8')).toContain(`- Shards: ${text}\n`)
  })

  test('--shards sets the count without reading the slots, recorded with no reading or estimate', () => {
    const run = runs['shards-option']

    expect([run.code, listCalls(run)]).toEqual([0, 0])
    expect(stateOf(run).shardChoice).toEqual({ source: 'option', reading: null, releases: 1, perRelease: 2, estimate: null })
    expect(submittedNames(run).sort()).toEqual([`adg-${CSCB_VERSION}-cand-s1`, `adg-${CSCB_VERSION}-cand-s2`])
    expect(run.stdout).toContain('ad-gate: shards: 2 candidate shards per release, from --shards\n')
  })

  test('--resume reuses the recorded count and never reads the slots again, though they changed', () => {
    const first = runs['resume-slots']
    const resumed = runs['resume-slots-resumed']
    const choice = stateOf(resumed).shardChoice
    const shardsLine = resumed.stdout.split('\n').find((line) => line.startsWith('ad-gate: shards: '))

    expect([first.code, listCalls(first), submittedNames(first).length]).toEqual([2, 1, 4])
    expect([resumed.code, listCalls(resumed), submittedNames(resumed).length]).toEqual([0, 1, 4])
    expect([choice?.perRelease, choice?.reading?.free, choice?.reading?.queued]).toEqual([4, 4, 2])
    expect(shardsLine).toMatch(/^ad-gate: shards: 4 candidate shards per release, from 4 free scheduler slots \(6 slots, 0 active, 2 queued at .* \(recorded; --resume reuses it\)$/)
  })

  test('a dry run records no choice, so the real run after it reads the slots once at submission', () => {
    const dry = runs['dry-run-then-resume']
    const resumed = runs['dry-run-then-resume-resumed']

    expect([dry.code, dry.calls]).toEqual([0, [LIST_CALL]])
    expect([resumed.code, listCalls(resumed), submittedNames(resumed).sort(), resumed.prepared]).toEqual([0, 2, CAND_NAMES, ['cand']])
    expect(resumed.calls.findIndex((call) => call[0] === 'list')).toBe(0)
    expect(resumed.calls.slice(1).findIndex((call) => call[0] === 'list')).toBeLessThan(resumed.calls.slice(1).findIndex((call) => call[0] === 'submit'))
    expect(stateOf(resumed).shardChoice?.source).toBe('slots')
  })

  test.each([
    ['a negative count', 'list-bad-count', "jobsched list's output has no summary with active_slots_limit, active_slots_used and queued: give --shards N"],
    ['no summary', 'list-no-summary', "jobsched list's output has no summary with active_slots_limit, active_slots_used and queued: give --shards N"],
    ['output that is not JSON', 'list-not-json', "jobsched list's output is not JSON: "],
    ['output that is no JSON object', 'list-not-object', "jobsched list's output is not a JSON object"],
    ['a failed call', 'list-fails', 'jobsched list failed (exit 4): fake jobsched: list refused'],
  ] as const)('a slot reading with %s stops the gate (exit 2) before anything is submitted', (_label, name, message) => {
    const run = runs[name]
    const line = `ad-gate: ${message}`
    const lines = run.stderr.split('\n')

    expect([run.code, run.calls, run.prepared]).toEqual([2, [LIST_CALL], ['cand']])
    expect(message.endsWith(': ') ? lines.filter((each) => each.startsWith(line) && each.length > line.length) : lines.filter((each) => each === line)).toHaveLength(1)
    expect(run.stderr).not.toContain('(unexpected error)')
  })

  test("two releases: every candidate shard is submitted, longest first across the releases, before one wait on all their jobs", () => {
    const run = runs['two-releases']
    const state = stateOf(run)
    const firstWait = run.calls.findIndex((call) => call[0] === 'wait')
    const lastSubmit = run.calls.map((call) => call[0]).lastIndexOf('submit')
    const candidateJobs = [CSCB_VERSION, SECOND_CSCB_VERSION].flatMap((version) => Object.values(state.versions[version].candidate.jobs))

    expect([run.code, listCalls(run), state.shardChoice?.releases]).toEqual([0, 1, 2])
    expect(submittedNames(run)).toEqual(
      [1, 2, 3].flatMap((k) => [`adg-${CSCB_VERSION}-cand-s${k}`, `adg-${SECOND_CSCB_VERSION}-cand-s${k}`]),
    )
    expect(lastSubmit).toBeLessThan(firstWait)
    expect(waitedIds(run.calls[firstWait]).sort()).toEqual(candidateJobs.sort())
    expect([releaseVerdict(run).outcome, releaseVerdict(run, SECOND_CSCB_VERSION).outcome]).toEqual(['pass', 'pass'])
    expect((JSON.parse(readFileSync(join(run.out, 'verdict.json'), 'utf8')) as { outcome: string }).outcome).toBe('pass')
  })

  test('two releases completed together: only the release needing its reference submits one', () => {
    const run = runs['two-releases-one-reference']
    const state = stateOf(run)
    const firstWait = run.calls.findIndex((call) => call[0] === 'wait')
    const refSubmit = run.calls.findIndex((call) => call[0] === 'submit' && call.includes(`adg-${SECOND_CSCB_VERSION}-ref-s1`))
    const waits = run.calls.filter((call) => call[0] === 'wait')
    const first = releaseVerdict(run)
    const second = releaseVerdict(run, SECOND_CSCB_VERSION)

    expect([run.code, run.prepared]).toEqual([0, ['cand', 'cand', 'ref']])
    expect(submittedNames(run).filter((name) => name.includes('-ref-'))).toEqual([`adg-${SECOND_CSCB_VERSION}-ref-s1`])
    expect(refSubmit).toBeGreaterThan(firstWait)
    expect(waitedIds(waits[waits.length - 1])).toEqual(Object.values(state.versions[SECOND_CSCB_VERSION].reference?.jobs ?? {}))
    expect([first.outcome, first.reference.ran]).toEqual(['pass', false])
    expect([second.outcome, second.reference.ran, second.verdict.excused]).toEqual(['pass', true, ['test-5-alpha.sh']])
    expect((JSON.parse(readFileSync(join(run.out, 'verdict.json'), 'utf8')) as { outcome: string }).outcome).toBe('pass')
  })

  test("staged completion: release A submits its reference before the next wait, alongside release B's pending candidates", () => {
    const run = runs['two-releases-staged-reference']
    const state = stateOf(run)
    const aCandidates = Object.values(state.versions[CSCB_VERSION].candidate.jobs)
    const bCandidates = Object.values(state.versions[SECOND_CSCB_VERSION].candidate.jobs)
    const aReferences = Object.values(state.versions[CSCB_VERSION].reference?.jobs ?? {})
    const waits = run.calls.flatMap((call, index) => call[0] === 'wait' ? [index] : [])
    const refSubmit = run.calls.findIndex((call) => call[0] === 'submit' && call.includes(`adg-${CSCB_VERSION}-ref-s1`))

    expect([run.code, run.prepared]).toEqual([0, ['cand', 'cand', 'ref']])
    expect([aCandidates.length, bCandidates.length, aReferences.length]).toEqual([3, 3, 1])
    expect(submittedNames(run).filter((name) => name.includes('-ref-'))).toEqual([`adg-${CSCB_VERSION}-ref-s1`])
    expect(waitedIds(run.calls[waits[0]]).sort()).toEqual([...aCandidates, ...bCandidates].sort())
    expect(refSubmit).toBeGreaterThan(waits[0])
    expect(refSubmit).toBeLessThan(waits[1])
    expect(waitedIds(run.calls[waits[1]]).sort()).toEqual([...aReferences, ...bCandidates].sort())
    expect(waits).toHaveLength(2)

    const a = releaseVerdict(run)
    const b = releaseVerdict(run, SECOND_CSCB_VERSION)
    expect([a.outcome, a.release, a.reference.ran, a.verdict.excused, a.verdict.reasons]).toEqual(['pass', true, true, ['test-5-alpha.sh'], []])
    expect([b.outcome, b.release, b.reference.ran, b.verdict.excused, b.verdict.reasons]).toEqual(['pass', true, false, [], []])
    expect((JSON.parse(readFileSync(join(run.out, 'verdict.json'), 'utf8')) as { outcome: string }).outcome).toBe('pass')
  })

  test('two releases, one with inputs that differ from its manifest: it fails without submitting, the other is submitted and judged, and the gate fails', () => {
    const run = runs['two-releases-bad-inputs']
    const second = releaseVerdict(run, SECOND_CSCB_VERSION)

    expect(run.code).toBe(1)
    expect(submittedNames(run).sort()).toEqual(CAND_NAMES)
    expect(releaseVerdict(run).outcome).toBe('pass')
    expect([second.outcome, new Set(kinds(second.verdict))]).toEqual(['fail', new Set(['manifest-mismatch'])])
    expect((JSON.parse(readFileSync(join(run.out, 'verdict.json'), 'utf8')) as { outcome: string }).outcome).toBe('fail')
    expect(run.stdout).toMatch(/^ad-gate: verdict: FAIL: /m)
  })
})

// --- Module properties ---

describe('module properties', () => {
  test('a fresh import adds no SIGINT, SIGTERM, SIGHUP, uncaughtException or unhandledRejection listener', async () => {
    const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection'] as const
    const before = events.map((event) => process.listenerCount(event))

    const fresh = await import(`../scripts/ad-gate/ad-gate.ts?fresh=${crypto.randomUUID()}`)

    expect(events.map((event) => process.listenerCount(event))).toEqual(before)
    const exported = [fresh.planShards, fresh.planShardsWithNotes, fresh.planProblems, fresh.parseRunLog, fresh.gateVerdict, fresh.submitCommands]
    expect(exported.map((value) => typeof value)).toEqual(Array(exported.length).fill('function'))
  })
})
