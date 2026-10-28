/**
 * publish-promote-sr61-poll-window.test.ts — guard + behavioral tests for.
 *
 * `scripts/publish-promote.sh`'s SR-6.1 registry-visibility poll waited
 * only 60 seconds (12 attempts at a 5s cadence). Real npm propagation on the 0.10.0
 * release took ~210s, so promote hit `sr_exit 60` between the publish/tag phase and
 * Phase 7 — leaving the release delivered remotely but the dev box on its old install.
 *
 * The fix widens the window (attempts × interval ≥ 5 minutes), adds periodic progress
 * output so a multi-minute wait is distinguishable from a hang, and keeps the
 * fail-closed behavior (non-zero `sr_exit 60`, manifest preserved) untouched.
 *
 * Two kinds of test live here, matching the established pattern for these bash
 * scripts (see publish-promote-bun-g-cwd.test.ts, sr99-guarded-exit.test.ts):
 *   - Static assertions parsed from the script source (window size, doc surfaces
 *     inside the script, rationale comment). These never execute the script.
 *   - A behavioral test of the REAL poll loop, extracted verbatim from the script at
 *     test time (so it cannot drift from the script) and run in a temp dir against a
 *     stubbed `npm` and a stubbed no-op `sleep`. No network, no registry, no publish.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const SCRIPT_ABS = join(REPO_ROOT, 'scripts/publish-promote.sh')

/** 's floor: the window must cover ordinary npm propagation lag. */
const MIN_WINDOW_SECONDS = 300

function readScript(): string {
  return readFileSync(SCRIPT_ABS, 'utf-8')
}

/** Value of a top-level `NAME=<integer>` assignment, or null if absent. */
function readIntAssignment(script: string, name: string): number | null {
  const m = script.match(new RegExp(`^${name}=(\\d+)\\b`, 'm'))
  return m ? Number(m[1]) : null
}

/**
 * Extract the inclusive source range [startMatch .. endMatch] from the script.
 * `endMatch` is the FIRST match after `startMatch`.
 */
function extractBlock(script: string, startMatch: RegExp, endMatch: RegExp): string {
  const lines = script.split('\n')
  const start = lines.findIndex((l) => startMatch.test(l))
  if (start < 0) throw new Error(`start marker not found: ${startMatch}`)
  const end = lines.findIndex((l, i) => i > start && endMatch.test(l))
  if (end < 0) throw new Error(`end marker not found: ${endMatch}`)
  return lines.slice(start, end + 1).join('\n')
}

// ---------------------------------------------------------------------------
// Static guards
// ---------------------------------------------------------------------------

describe('SR-6.1 poll window is wide enough for npm propagation', () => {
  test('attempts × interval covers at least 5 minutes ()', () => {
    const script = readScript()
    const attempts = readIntAssignment(script, 'SR61_POLL_ATTEMPTS')
    const interval = readIntAssignment(script, 'SR61_POLL_INTERVAL')
    // Named, greppable knobs are themselves part of the fix: the pre-fix loop
    // hard-coded `for _ in 1 2 … 12` + `sleep 5`, which no surface could read.
    expect(attempts).not.toBeNull()
    expect(interval).not.toBeNull()
    expect(attempts! * interval!).toBeGreaterThanOrEqual(MIN_WINDOW_SECONDS)
  })

  // NOTE: the knobs being genuinely WIRED INTO the loop (iterating
  // SR61_POLL_ATTEMPTS times, sleeping SR61_POLL_INTERVAL between attempts) is
  // proven behaviorally below — `npmCalls === attempts` and every recorded sleep
  // equalling `interval` — so no source-regex test for the loop shape lives here.

  test('a rationale comment for the chosen window sits at the poll site ()', () => {
    const script = readScript()
    const lines = script.split('\n')
    const knob = lines.findIndex((l) => /^SR61_POLL_ATTEMPTS=/.test(l))
    expect(knob).toBeGreaterThan(0)
    // Contiguous comment prose immediately preceding the knob (blank lines allowed).
    const preamble: string[] = []
    for (let i = knob - 1; i >= 0; i--) {
      const l = lines[i]!
      if (l.trim() === '') continue
      if (!l.trimStart().startsWith('#')) break
      preamble.unshift(l)
    }
    const rationale = preamble.join('\n')
    // Existence, not length: a non-empty comment block explaining the window
    // must precede the knob. The loose content match keeps it about propagation
    // timing rather than an unrelated stray comment; no character-count floor,
    // which would only be a magic number that fails on a tighter rewording.
    expect(preamble.length).toBeGreaterThan(0)
    expect(rationale.toLowerCase()).toMatch(/propagat|minute/)
  })

  test('the progress cadence knob is a sane, positive value ()', () => {
    // That the knob actually gates a periodic progress line is proven
    // behaviorally below (progress-line count === attempts / every); here we
    // only assert the knob exists and yields at least one line per window.
    const attempts = readIntAssignment(readScript(), 'SR61_POLL_ATTEMPTS')!
    const every = readIntAssignment(readScript(), 'SR61_PROGRESS_EVERY')
    expect(every).not.toBeNull()
    expect(every!).toBeGreaterThan(0)
    expect(every!).toBeLessThanOrEqual(attempts)
  })

  test('fail-closed behavior is unchanged: sr_exit 60 and the manifest is preserved ()', () => {
    const timeout = extractBlock(
      readScript(),
      /^if \[ "\$\{VERIFIED\}" != "1" \]/,
      /^\s*sr_exit 60$/,
    )
    expect(timeout).toContain('sr_exit 60')
    expect(timeout).toContain('${MANIFEST} is preserved')
  })

  test('no surface inside the script still advertises the old 60-second window ()', () => {
    const script = readScript()
    const stale = script
      .split('\n')
      .filter((l) => /60[\s-]?(second|s\b)/i.test(l))
      // The exit CODE 60 rows are legitimate; only duration prose is stale.
      .filter((l) => /60[\s-]?second|within 60s|60s\b/i.test(l))
    expect(stale).toEqual([])
  })

  test("the header exit-code table's SR-6.1 row states the widened window", () => {
    const script = readScript()
    const row = script
      .split('\n')
      .find((l) => /^#\s+60\s+SR-6\.1/.test(l))
    expect(row).toBeDefined()
    const attempts = readIntAssignment(script, 'SR61_POLL_ATTEMPTS')!
    const interval = readIntAssignment(script, 'SR61_POLL_INTERVAL')!
    const minutes = (attempts * interval) / 60
    // The row must name the real window, not a number that has drifted from the knobs.
    expect(row!).toContain(`${minutes} minute`)
  })
})

// ---------------------------------------------------------------------------
// Behavioral test of the real poll loop
// ---------------------------------------------------------------------------
//
// The loop text is lifted verbatim from the script (start `# SR-6.1 — poll` through
// `done`, plus the timeout block) and spliced into a harness run in a temp dir, after
// bash function stubs for `npm` and `sleep` (a function wins over any `npm` or `sleep`
// on PATH). Nothing real is published, installed or fetched; `sleep` is a no-op that
// only records its argument, so no attempt waits on the clock. Each attempt still
// forks a command substitution and a pipeline and launches the real `tr`, so on a
// host where a fork costs ~30 ms the 120-attempt window takes several seconds.
//
// The real `npm` and `sleep` share a directory with bash, `seq` and `tr` on the
// child's PATH, so a guard directory comes first on it: its `npm` and `sleep` say
// on stderr that a PATH lookup reached them, record the hit in the run's directory
// and exit 97. A lookup that bypasses the functions (`command npm`, `env npm`)
// therefore never reaches the real tools, and `runPollIn` throws on any recorded
// hit, since the loop discards npm's stderr and exit status. The functions still
// win, so an attempt never runs a guard.

/** Exit status of a guard `npm` or `sleep`: a PATH lookup bypassed the function stubs. */
const GUARD_EXIT = 97

let POLL_BLOCK: string
let TIMEOUT_BLOCK: string
let guardRoot: string
let guardBin: string

beforeAll(() => {
  const script = readScript()
  POLL_BLOCK = extractBlock(script, /^# SR-6\.1 /, /^done$/)
  TIMEOUT_BLOCK = extractBlock(
    script,
    /^if \[ "\$\{VERIFIED\}" != "1" \]/,
    /^fi$/,
  )
  expect(POLL_BLOCK).toContain('npm view')
  expect(TIMEOUT_BLOCK).toContain('sr_exit 60')

  guardRoot = mkdtempSync(join(tmpdir(), 'sr61-guard-'))
  guardBin = join(guardRoot, 'bin')
  mkdirSync(guardBin)
  for (const name of ['npm', 'sleep']) {
    writeFileSync(
      join(guardBin, name),
      [
        '#!/bin/sh',
        `printf '%s\\n' "sr61 guard: the real ${name} was reached through PATH; the harness must call its ${name} function stub" >&2`,
        `printf '%s\\n' ${name} >> "$SR61_STUB_DIR/guard-hits"`,
        `exit ${GUARD_EXIT}`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
  }
})

afterAll(() => {
  if (guardRoot) rmSync(guardRoot, { recursive: true, force: true })
})

// Stub npm: emits the target version only from the Nth `npm view` onwards, where N
// is $SR61_STUB_SUCCEED_AT (0 = never succeed). Every call is tallied in a file (the
// loop calls npm inside a pipeline subshell, so a shell variable would not survive),
// and its full argv is recorded one line per call so tests can assert the script
// asked the registry the RIGHT question — otherwise the stub would answer any
// `npm <anything>` with the version and a wrong query would still pass.
// Stub sleep: records the requested seconds instead of burning wall clock.
const STUBS = [
  'npm() {',
  '  local n',
  '  read -r n < "$SR61_STUB_DIR/npm-calls"',
  '  n=$(( n + 1 ))',
  '  printf "%s\\n" "$n" > "$SR61_STUB_DIR/npm-calls"',
  '  printf "%s\\n" "$*" >> "$SR61_STUB_DIR/npm-args"',
  '  if [ "$SR61_STUB_SUCCEED_AT" != "0" ] && [ "$n" -ge "$SR61_STUB_SUCCEED_AT" ]; then',
  '    printf "%s\\n" "$SR61_STUB_VERSION"',
  '  fi',
  '  return 0',
  '}',
  'sleep() { printf "%s\\n" "$1" >> "$SR61_STUB_DIR/sleeps"; }',
].join('\n')

/**
 * Time limit passed to every harness child: past it the child is killed with
 * SIGKILL, so its `code` is 137 and its `signal` `'SIGKILL'`. It is the effective
 * bound for the shared hook's runs, about twice their measured cost (~9.5 s on a
 * host where each process costs ~30 ms), and sits below `LONG_RUNS_TIMEOUT_MS` so
 * a stuck run there fails through its own test's assertions rather than as an
 * anonymous hook timeout. The runs inside tests are bounded first by bun's
 * default 5 s test timeout.
 */
const RUN_LIMIT_MS = 19_000

/**
 * After a kill, how long to wait for the child's output: a grandchild it left
 * behind (a pipeline stage) can hold the pipes open past the kill.
 */
const KILLED_OUTPUT_GRACE_MS = 1_000

interface PollRun {
  code: number
  /** The signal that ended the child (`'SIGKILL'` past `RUN_LIMIT_MS`), or null when it exited. */
  signal: string | null
  stdout: string
  stderr: string
  npmCalls: number
  /** Full argv of every stubbed `npm` invocation, one entry per call. */
  npmArgs: string[]
  sleeps: number[]
  verified: string
  manifestExists: boolean
}

/**
 * Run the extracted poll loop (optionally followed by the timeout block).
 * `succeedAt` is the 1-based `npm view` call on which the registry "surfaces"
 * the version; 0 means it never does. Asynchronous, so independent runs can
 * share the wall clock.
 */
async function runPoll(succeedAt: number, opts: { withTimeoutBlock?: boolean } = {}): Promise<PollRun> {
  const runDir = mkdtempSync(join(tmpdir(), 'sr61-run-'))
  try {
    return await runPollIn(runDir, succeedAt, opts)
  } finally {
    // finally, not a trailing call: an assertion/setup throw inside the body
    // must not leak the temp dir (same pattern as publish-promote-bun-g-cwd.test.ts).
    rmSync(runDir, { recursive: true, force: true })
  }
}

async function runPollIn(
  runDir: string,
  succeedAt: number,
  opts: { withTimeoutBlock?: boolean },
): Promise<PollRun> {
  writeFileSync(join(runDir, 'npm-calls'), '0\n')
  writeFileSync(join(runDir, 'npm-args'), '')
  writeFileSync(join(runDir, 'sleeps'), '')
  const manifest = join(runDir, '.publish-state.json')
  writeFileSync(manifest, '{"stub":true}\n')

  const harness = [
    'set -euo pipefail',
    STUBS,
    'NEXT_VERSION=9.9.9',
    `MANIFEST=${JSON.stringify(manifest)}`,
    // Stand-in for the script's sr_exit: same contract (print nothing, exit with code).
    'sr_exit() { exit "$1"; }',
    POLL_BLOCK,
    ...(opts.withTimeoutBlock ? [TIMEOUT_BLOCK] : []),
    'printf "VERIFIED=%s\\n" "${VERIFIED}"',
    'exit 0',
  ].join('\n')

  // The child's HOME: a temp dir inside runDir, so runPoll's finally removes it.
  const home = join(runDir, 'home')
  mkdirSync(home)

  // Named tools: bash (the harness) and seq and tr (the poll loop). `npm` and
  // `sleep` are the harness's functions, with the guard directory first on PATH
  // behind them. Nothing else is inherited from process.env.
  const child = Bun.spawn(['bash', '-c', harness], {
    env: hostSafeChildEnv(home, {
      pathDirs: [guardBin],
      tools: ['bash', 'seq', 'tr'],
      extras: {
        SR61_STUB_DIR: runDir,
        SR61_STUB_VERSION: '9.9.9',
        SR61_STUB_SUCCEED_AT: String(succeedAt),
      },
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: RUN_LIMIT_MS,
    killSignal: 'SIGKILL',
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  const signal = child.signalCode
  const [stdout, stderr] =
    signal === null
      ? await output
      : await Promise.race([output, Bun.sleep(KILLED_OUTPUT_GRACE_MS).then((): [string, string] => ['', ''])])

  const guardHits = join(runDir, 'guard-hits')
  if (existsSync(guardHits)) {
    const names = readFileSync(guardHits, 'utf-8').split('\n').filter(Boolean)
    throw new Error(
      `SR-6.1 harness reached the guard ${[...new Set(names)].join(', ')} on PATH (exit ${GUARD_EXIT}): ` +
        'a lookup bypassed the function stubs and would have run the real tool',
    )
  }

  const npmCalls = Number(readFileSync(join(runDir, 'npm-calls'), 'utf-8').trim())
  const npmArgs = readFileSync(join(runDir, 'npm-args'), 'utf-8')
    .split('\n')
    .filter(Boolean)
  const sleeps = readFileSync(join(runDir, 'sleeps'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(Number)
  const verifiedMatch = stdout.match(/^VERIFIED=(\d+)$/m)
  return {
    code,
    signal,
    stdout,
    stderr,
    npmCalls,
    npmArgs,
    sleeps,
    verified: verifiedMatch ? verifiedMatch[1]! : '',
    manifestExists: (() => {
      try {
        readFileSync(manifest)
        return true
      } catch {
        return false
      }
    })(),
  }
}

/**
 * Backstop for the shared hook below. It runs the three long loops together
 * (two 120-attempt windows and the 43-attempt lag case); each attempt forks and
 * launches processes, and on a host where that costs ~30 ms per process the
 * concurrent runs take about 9.5 s, past bun's 5 s default. `RUN_LIMIT_MS` is the
 * effective bound for these runs, about twice that cost; this timeout only has to
 * exceed `RUN_LIMIT_MS` plus `KILLED_OUTPUT_GRACE_MS`, so a stuck run is killed and
 * reported by its own test before this timeout fires.
 */
const LONG_RUNS_TIMEOUT_MS = 22_000

describe('SR-6.1 poll loop behavior (stubbed npm + sleep)', () => {
  // The three cases that read a never-surfacing window without the timeout
  // block share one run: their input is identical.
  let neverSurfaces: PollRun
  let neverSurfacesWithTimeout: PollRun
  let lag210s: PollRun

  beforeAll(async () => {
    const interval = readIntAssignment(readScript(), 'SR61_POLL_INTERVAL')!
    // 210s of lag → the attempt at which the registry first answers.
    ;[neverSurfaces, neverSurfacesWithTimeout, lag210s] = await Promise.all([
      runPoll(0),
      runPoll(0, { withTimeoutBlock: true }),
      runPoll(Math.ceil(210 / interval) + 1),
    ])
  }, LONG_RUNS_TIMEOUT_MS)

  test('a registry that never surfaces the version is polled for the full window', () => {
    const attempts = readIntAssignment(readScript(), 'SR61_POLL_ATTEMPTS')!
    const interval = readIntAssignment(readScript(), 'SR61_POLL_INTERVAL')!
    const r = neverSurfaces
    expect(r.signal).toBeNull()
    expect(r.code).toBe(0)
    expect(r.verified).toBe('0')
    expect(r.npmCalls).toBe(attempts)
    // The wall-clock the loop WOULD have waited — the regression this bug is about.
    const waited = r.sleeps.reduce((a, b) => a + b, 0)
    expect(waited).toBeGreaterThanOrEqual(MIN_WINDOW_SECONDS)
    expect(r.sleeps.every((s) => s === interval)).toBe(true)
  })

  test('progress lines are emitted during a long wait, with attempt and elapsed markers ()', () => {
    const attempts = readIntAssignment(readScript(), 'SR61_POLL_ATTEMPTS')!
    const every = readIntAssignment(readScript(), 'SR61_PROGRESS_EVERY')!
    const r = neverSurfaces
    expect(r.signal).toBeNull()
    const progress = [...r.stdout.matchAll(/attempt (\d+)\/(\d+).*?(\d+)s/g)]
    expect(progress.length).toBe(Math.floor(attempts / every))
    // First progress line lands on the Nth attempt and reports the real total.
    expect(Number(progress[0]![1])).toBe(every)
    expect(Number(progress[0]![2])).toBe(attempts)
    // Elapsed time is reported, not just a bare counter.
    expect(Number(progress[0]![3])).toBeGreaterThan(0)
  })

  test('a version that surfaces mid-window breaks early with VERIFIED=1', async () => {
    const r = await runPoll(25)
    expect(r.signal).toBeNull()
    expect(r.code).toBe(0)
    expect(r.verified).toBe('1')
    expect(r.npmCalls).toBe(25)
    // Broke out of the loop: one sleep per failed attempt, none after success.
    expect(r.sleeps.length).toBe(24)
  })

  test('a version visible on the first attempt returns immediately, no sleeping', async () => {
    const r = await runPoll(1)
    expect(r.signal).toBeNull()
    expect(r.verified).toBe('1')
    expect(r.npmCalls).toBe(1)
    expect(r.sleeps).toEqual([])
    // The stub answers ANY `npm …` with the version, so pin the actual query:
    // without this, a loop asking the wrong question would still "verify".
    expect(r.npmArgs).toEqual(['view claude-slack-channel-bots@9.9.9 version'])
  })

  test('every poll asks the registry the exact version query for the target package', () => {
    const r = neverSurfaces
    expect(r.signal).toBeNull()
    const distinct = [...new Set(r.npmArgs)]
    expect(distinct).toEqual(['view claude-slack-channel-bots@9.9.9 version'])
    expect(r.npmArgs.length).toBe(r.npmCalls)
  })

  test('propagation lag of ~210s (the 0.10.0 observation) now verifies instead of timing out', () => {
    expect(lag210s.signal).toBeNull()
    expect(lag210s.verified).toBe('1')
  })

  test('timeout still exits 60 with a diagnostic and leaves the manifest in place ()', () => {
    const r = neverSurfacesWithTimeout
    expect(r.signal).toBeNull()
    expect(r.code).toBe(60)
    expect(r.stderr).toContain('SR-6.1')
    expect(r.manifestExists).toBe(true)
  })
})
