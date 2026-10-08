#!/usr/bin/env bun
/**
 * scripts/ci-verdict.ts — the `/ci` verdict reader (b.uqm SR-17). It is the
 * only code that reads `verdict.txt`, and the only mapping from a run's files
 * to `/ci`'s report and exit code. The `/ci` skill relays what it prints and
 * the code it exits with, and holds no verdict logic of its own (SR-18.2).
 *
 * Usage (b.uqm SR-17.1):
 *
 *   bun scripts/ci-verdict.ts report <RUN_ID> <PID> <grace> [the /ci arguments]...
 *     Prints the run's outcome and exits with its code (SR-17.3):
 *       0  full PASS: `✓ Integration tests passed.`, then the timing summary
 *       1  full or selective FAIL, or the runner died or wrote no valid verdict
 *       2  not runnable: the refusal's `NOT RUN:` line and its detail lines
 *       3  selective PASS (not a gate result)
 *       4  injected run (not a gate result)
 *     It removes the run directory only after printing a full or selective
 *     PASS with its timing summary, or a refusal (SR-16.3).
 *
 *   bun scripts/ci-verdict.ts wait <RUN_ID> <PID>
 *     Waits at most 90 s for the run to move on (SR-17.5). It checks the run
 *     at its start, then every 1 s on its injected clock, and returns at the
 *     first check at which one of these holds, in this order:
 *       10 verdict  `verdict.txt` exists (it is never read here)
 *       11 refused  the status file records a refusal
 *       12 gone     the runner is gone (SR-6.3)
 *       13 grace    the grace has ended and the runner is alive
 *        0 running  the phase differs from the first check's, or the bound
 *                   is reached
 *     The deadline is the status file's, or the RUN_ID's time plus 90 min
 *     while there is none; the grace ends 10 min after it. Before exiting it
 *     prints one `wait:` line on standard output. It writes, renames,
 *     removes, signals and spawns nothing.
 *
 *   bun scripts/ci-verdict.ts stop <RUN_ID> <PID>
 *     Stops a runner still alive at grace expiry (SR-17.6). It signals only a
 *     runner alive by SR-6.3, and only its PID, never a process group:
 *     SIGTERM, then, checking every 1 s on its injected clock, SIGKILL when
 *     the runner is still alive 30 s after the SIGTERM. A signal that is not
 *     delivered (no such process, or not permitted) counts as not sent.
 *     Before exiting it prints one `stop:` line on standard output, naming the
 *     grace argument for `report`. Exits 0 when nothing was sent (grace
 *     `none`), 20 after SIGTERM only (`term:<m>`), 21 after SIGTERM then
 *     SIGKILL (`kill:<m>`). It writes, renames, removes and spawns nothing.
 *
 *   `<PID>` is the runner PID the skill printed, or `-`. `<grace>` is `none`,
 *   `term:<m>` or `kill:<m>`, m a whole number of at least 1. Malformed
 *   arguments exit 64 with one `usage: ` line on standard error, having read,
 *   written, removed, spawned and signalled nothing (SR-17.1).
 *
 * Import safety (b.uqm SR-1.3). Importing this file runs nothing: no process,
 * no file read or write, no signal handler. Its top level holds only imports,
 * declarations and exports; there is no top-level call, `new` or `await`
 * outside the one entry block at the very end of the file, which acts only
 * when the file is run as the main module. Every input and side effect goes
 * through one injected dependency object, `ReaderDeps`, a subset of the
 * runner's `RunnerDeps` plus the reader's own run-directory reads, removal and
 * standard output. Its real bindings are built only by `createRealReaderDeps`,
 * which only that entry block calls. Component tests drive every verb in
 * process through fakes (SR-21.1); there is no test-only option or
 * environment variable. At run time the file loads only `node:` built-ins and
 * the runner, `scripts/ci-run.ts`, from which it takes every rule the two
 * share: argument parsing and the run kind, script-name forms, fault
 * normalization, canonical order, the RUN_ID and its time, the run-directory
 * path, the status file's format and the liveness rule.
 *
 * Section map:
 *
 *   1. dependencies (E3 T1)
 *   2. constants (E3 T1)
 *   3. arguments (E3 T1)
 *   4. run files, the runner's PID and liveness (E3 T1)
 *   5. first-line validity (E3 T1)
 *   6. the report verb (E3 T1)
 *   7. the wait verb (E3 T2)
 *   8. the stop verb (E3 T2)
 *   9. the verb runner and the entry block (E3 T1)
 *
 * Not in `package.json` `files`: never shipped.
 *
 * SPDX-License-Identifier: MIT
 */

import { lstatSync, rmSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  classifyScriptName,
  compareCanonical,
  createRealRunnerDeps,
  FAIL_PREFIX,
  FAILURE_EXIT_STATUS,
  formatUtcTime,
  injectedVerdictPrefix,
  isInjectedRun,
  isNumberForm,
  isOwnerAlive,
  isRunId,
  isSelectiveRun,
  isWholeNumber,
  lookUpBaseBuildToken,
  numberFormOf,
  parseCiArguments,
  parseStatus,
  readFileText,
  REDACTION_PLACEHOLDER,
  refusalLine,
  RESULTS_FILE_NAME,
  RESULTS_FORMAT_VERSION,
  RUNNER_LOG_FILE_NAME,
  runDirPath,
  runIdTimeMs,
  secretCredentialSet,
  STATUS_FILE_NAME,
  USAGE_EXIT_STATUS,
  USAGE_PREFIX,
  VERDICT_FILE_NAME,
} from './ci-run.ts'
import type { FileTextRead, Invocation, OwnerLivenessProbe, Refusal, RunnerDeps, RunStatus, SentSignal, StatusPhase, WriteResult } from './ci-run.ts'

// ---------------------------------------------------------------------------
// 1. Dependencies (E3 T1)
// ---------------------------------------------------------------------------
//
// The reader's injected dependencies (b.uqm SR-1.3): the runner's own
// interface, `RunnerDeps`, narrowed to the members the reader uses, plus the
// reader's run-directory reads, its one removal and standard output. The run
// directory and the system temp directory are derived from the injected
// environment (`env`) by the runner's path rule, so a test sets `TMPDIR`.

/** What lies at a path, judged on the path itself and never through a final symbolic link. */
export type RunPathKind = 'missing' | 'directory' | 'other'

/**
 * Every input and side effect of the reader (b.uqm SR-1.3), one member per
 * line. Only `createRealReaderDeps` binds the real ones.
 *
 * From `RunnerDeps`: `spawn` (the `gh` lookups, SR-17.4), `env` (the reader's
 * own environment), `worktreeRoot` (the tree holding this file; the `gh`
 * lookups run there), `clock` (the wait and stop verbs' clock and timers),
 * `sendSignal` (the stop verb), `isPidAlive` and `readProcCmdline` (the
 * liveness rule, SR-6.3) and `writeStderr`.
 */
export interface ReaderDeps extends Pick<RunnerDeps, 'spawn' | 'env' | 'worktreeRoot' | 'clock' | 'sendSignal' | 'isPidAlive' | 'readProcCmdline' | 'writeStderr'> {
  /** Writes text to standard output; each report line goes here. */
  readonly writeStdout: (text: string) => void
  /** A file's text, read-only: its content, missing (the path does not exist), or unreadable. */
  readonly readRunFile: (path: string) => FileTextRead
  /** What lies at a path, never following a final symbolic link. */
  readonly runPathKind: (path: string) => RunPathKind
  /** Removes a run directory and everything under it, never following a symbolic link (b.uqm SR-16.3). */
  readonly removeRunDir: (path: string) => WriteResult
}

/** The reader's run-directory members, which `createRealRunFileDeps` binds. */
export type RunFileDeps = Pick<ReaderDeps, 'readRunFile' | 'runPathKind' | 'removeRunDir'>

/** The members the run-file readers use. */
export type RunFileReads = Pick<ReaderDeps, 'readRunFile' | 'runPathKind'>

/** A thrown value's message on one line. */
function oneLineError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/** A thrown value's errno code, when it has one. */
function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function realRunPathKind(path: string): RunPathKind {
  try {
    return lstatSync(path).isDirectory() ? 'directory' : 'other'
  } catch (err) {
    const code = errnoCode(err)
    // Any other failure (EACCES, say) leaves something possibly there: never absent.
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'other'
  }
}

/** Removes a directory tree: only a directory, judged on the path itself, and never through a link (Bun's `rmSync` unlinks a link, never its target). */
function removeRealRunDir(path: string): WriteResult {
  try {
    if (!lstatSync(path).isDirectory()) return { ok: false, error: 'not a directory' }
    rmSync(path, { recursive: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: oneLineError(err) }
  }
}

/** Writes all of `text` to a file descriptor, synchronously, so nothing is lost when the process exits right after. */
function writeAllSync(fd: number, text: string): void {
  const bytes = Buffer.from(text)
  let offset = 0
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset)
    } catch (err) {
      if (errnoCode(err) !== 'EAGAIN') throw err
    }
  }
}

/**
 * The real run-directory members: reads through the runner's `readFileText`,
 * `lstat` for what lies at a path, and a removal that never follows a link.
 * The entry block's `createRealReaderDeps` uses them; a component test may
 * use them over a constructed temp directory.
 */
export function createRealRunFileDeps(): RunFileDeps {
  return {
    readRunFile: readFileText,
    runPathKind: realRunPathKind,
    removeRunDir: removeRealRunDir,
  }
}

/**
 * Builds the real bindings: the runner's own (`createRealRunnerDeps`) for the
 * members the two share, this file's worktree root, standard output and the
 * run-directory members. Called only by the main-module entry block
 * (section 9); never at import.
 */
export function createRealReaderDeps(): ReaderDeps {
  const runner = createRealRunnerDeps()
  return {
    spawn: runner.spawn,
    env: runner.env,
    worktreeRoot: resolve(import.meta.dir, '..'),
    clock: runner.clock,
    sendSignal: runner.sendSignal,
    isPidAlive: runner.isPidAlive,
    readProcCmdline: runner.readProcCmdline,
    writeStderr: runner.writeStderr,
    writeStdout: (text) => writeAllSync(1, text),
    ...createRealRunFileDeps(),
  }
}

// ---------------------------------------------------------------------------
// 2. Constants (E3 T1)
// ---------------------------------------------------------------------------
//
// Every numeric bound, exit code and fixed text of the reader (b.uqm SR-21.5),
// each under one name. Tests and the skill audit (E13) import them. The usage
// exit status 64 is the runner's `USAGE_EXIT_STATUS`.

// --- Bounds ---

/** The runner-log lines a runner-died report prints, at most: the log's last 40 (b.uqm SR-17.1, SR-17.3). */
export const RUNNER_LOG_TAIL_LINES = 40
/** The wait verb's bound: it returns at most 90 s after its start (b.uqm SR-17.5). */
export const WAIT_BOUND_MS = 90_000
/** The wait verb checks the run at its start, then every 1 s (b.uqm SR-17.5). */
export const WAIT_CHECK_INTERVAL_MS = 1_000
/** The grace after the deadline: 10 min (b.uqm SR-17.5, SR-18.2). */
export const GRACE_MINUTES = 10
/** The deadline while no status file can be read: the RUN_ID's time plus 90 min (b.uqm SR-17.5, SR-18.2). */
export const NO_STATUS_DEADLINE_MINUTES = 90
/** The stop verb sends SIGKILL when the runner is still alive 30 s after its SIGTERM (b.uqm SR-17.6). */
export const STOP_KILL_AFTER_MS = 30_000
/** The stop verb checks the PID every 1 s after its SIGTERM (b.uqm SR-17.6). */
export const STOP_CHECK_INTERVAL_MS = 1_000

// --- Exit codes ---

/** Wait: the phase moved on, or the bound was reached (b.uqm SR-17.5). */
export const WAIT_EXIT_RUNNING = 0
/** Wait: `verdict.txt` exists. */
export const WAIT_EXIT_VERDICT = 10
/** Wait: the status file records a refusal. */
export const WAIT_EXIT_REFUSED = 11
/** Wait: the runner is gone. */
export const WAIT_EXIT_GONE = 12
/** Wait: the grace has ended and the runner is alive. */
export const WAIT_EXIT_GRACE = 13
/** Stop: the runner was not alive; no signal sent; grace `none` (b.uqm SR-17.6). */
export const STOP_EXIT_NOT_ALIVE = 0
/** Stop: SIGTERM sent; grace `term:<m>`. */
export const STOP_EXIT_SENT_SIGTERM = 20
/** Stop: SIGTERM, then SIGKILL after 30 s; grace `kill:<m>`. */
export const STOP_EXIT_SENT_SIGKILL = 21
/** Report: a full, uninjected PASS (b.uqm SR-17.3). */
export const REPORT_EXIT_FULL_PASS = 0
/** Report: a full or selective FAIL, or the runner died or wrote no valid verdict. */
export const REPORT_EXIT_FAIL = 1
/** Report: not runnable, a recorded refusal. */
export const REPORT_EXIT_NOT_RUN = 2
/** Report: a selective PASS, not a gate result. */
export const REPORT_EXIT_SELECTIVE_PASS = 3
/** Report: an injected run, not a gate result. */
export const REPORT_EXIT_INJECTED = 4

// --- The skill's limits and its two failure lines (b.uqm SR-18.2) ---

/** After this many unknown wait exits in a row the skill stops polling. */
export const UNKNOWN_WAIT_EXIT_LIMIT = 3
/** The skill makes at most this many stop calls in all. */
export const STOP_CALL_LIMIT = 3
/** The skill's line after `UNKNOWN_WAIT_EXIT_LIMIT` unknown wait exits in a row; `<code>` and `<PID>` are its placeholders (b.uqm SR-18.2). */
export const WAIT_READER_FAILED_TEXT = `verdict reader failed: wait exited <code> ${UNKNOWN_WAIT_EXIT_LIMIT} times in a row; runner <PID> may still be running; finish the run as "Finishing a run by hand" says`
/** The skill's line after `STOP_CALL_LIMIT` unknown stop exits; `<code>` and `<PID>` are its placeholders (b.uqm SR-18.2). */
export const STOP_READER_FAILED_TEXT = `verdict reader failed: stop exited <code> ${STOP_CALL_LIMIT} times in a row; runner <PID> may still be running; finish the run as "Finishing a run by hand" says`

// --- Command line ---

/** The reader's verbs, in the order its usage text gives them (b.uqm SR-17.1). */
export const READER_VERBS = ['report', 'wait', 'stop'] as const
/** How the reader is run, as its usage text names it. */
export const READER_COMMAND = 'bun scripts/ci-verdict.ts'
/** The reader's usage text: its three command lines (b.uqm SR-17.1). */
export const READER_USAGE_TEXT = `${READER_COMMAND} report <RUN_ID> <PID> <grace> [/ci arguments] | ${READER_COMMAND} wait <RUN_ID> <PID> | ${READER_COMMAND} stop <RUN_ID> <PID>`
/** `<PID>` when the skill obtained none. */
export const PID_ARGUMENT_NONE = '-'
/** `<grace>` when the skill sent no signal. */
export const GRACE_NONE = 'none'
/** `<grace>`'s prefix when the skill sent SIGTERM only: `term:<m>`. */
export const GRACE_TERM_PREFIX = 'term:'
/** `<grace>`'s prefix when the skill sent SIGTERM, then SIGKILL: `kill:<m>`. */
export const GRACE_KILL_PREFIX = 'kill:'

// --- Verdict shapes (b.uqm SR-12.5, SR-17.2) ---

/** A passing verdict, and a full uninjected run's whole first line when it passes. */
export const PASS_VERDICT = 'PASS'
/** A selective verdict's opening, before its script list: `SELECTIVE (`. */
export const SELECTIVE_VERDICT_OPEN = 'SELECTIVE ('
/** What closes a `SELECTIVE (` or `INJECTED (` wrapper's list: `): `. */
export const VERDICT_WRAPPER_CLOSE = '): '
/** What separates a selective verdict's number forms: one space. */
export const SCRIPT_LIST_SEPARATOR = ' '

// --- Report texts (b.uqm SR-17.3) ---

/** The runner-died report's first line. */
export const RUNNER_DIED_TEXT = `test runner did not write a valid ${VERDICT_FILE_NAME}`
/** A full, uninjected PASS's report line. */
export const FULL_PASS_TEXT = '✓ Integration tests passed.'
/** An injected run's report prefix, before its verdict line. */
export const INJECTED_REPORT_PREFIX = 'INJECTED (not a gate result): '
/** A selective run's report prefix, before `PASS: <scripts>` or its FAIL line. */
export const SELECTIVE_REPORT_PREFIX = 'SELECTIVE (not a gate result): '
/** The prefix of the line naming a kept run directory. */
export const RESULTS_LINE_PREFIX = 'results: '

/** Milliseconds in a second, for the texts that give a bound in seconds. */
const MS_PER_SECOND = 1_000
/** The least `<PID>` and the least m of `<grace>`. */
const LEAST_POSITIVE_WHOLE_NUMBER = 1
/** test-1's number: every shard runs it, so every selective verdict's list holds it (b.uqm SR-12.5, SR-17.2). */
const EVERY_SHARD_SCRIPT_NUMBER = 1

// ---------------------------------------------------------------------------
// 3. Arguments (E3 T1)
// ---------------------------------------------------------------------------
//
// The three verbs' command lines (b.uqm SR-17.1). Malformed arguments exit 64
// with one `usage: ` line naming the argument, before anything is read. The
// `/ci` arguments after `report`'s `<grace>` are kept as given: SR-17.2
// judges them, never this parser.

/** One of the reader's verbs. */
export type ReaderVerb = (typeof READER_VERBS)[number]

/** `<grace>`: what the skill did at grace expiry (b.uqm SR-17.1). */
export type Grace =
  | {
      readonly kind: 'none'
    }
  | {
      /** SIGTERM only. */
      readonly kind: 'term'
      /** m, the deadline's minutes, as typed: a whole number of at least 1. */
      readonly minutes: string
    }
  | {
      /** SIGTERM, then SIGKILL. */
      readonly kind: 'kill'
      /** m, the deadline's minutes, as typed: a whole number of at least 1. */
      readonly minutes: string
    }

/** `report <RUN_ID> <PID> <grace> [/ci arguments]`. */
export interface ReportInvocation {
  readonly verb: 'report'
  readonly runId: string
  /** `<PID>` as given: `-` or a whole number of at least 1. */
  readonly pid: string
  readonly grace: Grace
  /** The `/ci` arguments as given, unparsed. */
  readonly ciArgs: readonly string[]
}

/** `wait <RUN_ID> <PID>`. */
export interface WaitInvocation {
  readonly verb: 'wait'
  readonly runId: string
  /** `<PID>` as given: `-` or a whole number of at least 1. */
  readonly pid: string
}

/** `stop <RUN_ID> <PID>`. */
export interface StopInvocation {
  readonly verb: 'stop'
  readonly runId: string
  /** `<PID>` as given: `-` or a whole number of at least 1. */
  readonly pid: string
}

/** A well-formed reader command line. */
export type ReaderInvocation = ReportInvocation | WaitInvocation | StopInvocation

/** The argument a malformed command line lacks or gets wrong (b.uqm SR-17.1). */
export type UsageProblem =
  | {
      /** A required argument is missing. */
      readonly kind: 'missing'
      readonly what: 'verb' | 'RUN_ID' | 'PID' | 'grace'
    }
  | {
      readonly kind: 'bad-verb'
      readonly arg: string
    }
  | {
      readonly kind: 'bad-run-id'
      readonly arg: string
    }
  | {
      readonly kind: 'bad-pid'
      readonly arg: string
    }
  | {
      readonly kind: 'bad-grace'
      readonly arg: string
    }
  | {
      /** `wait` or `stop` got an argument after `<PID>`: the first one. */
      readonly kind: 'extra'
      readonly verb: 'wait' | 'stop'
      readonly arg: string
    }

/** The reader's command line parsed: an invocation, or the first problem in argument order. */
export type ReaderArgumentParse =
  | {
      readonly ok: true
      readonly invocation: ReaderInvocation
    }
  | {
      readonly ok: false
      readonly problem: UsageProblem
    }

/** A control character, which an argument shown on one line must not carry raw. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

/** An argument as a usage line shows it: as given, or JSON-quoted when it is empty or holds a control character, so the line stays one readable line. */
function shownArgument(arg: string): string {
  return arg === '' || CONTROL_CHARACTER_PATTERN.test(arg) ? JSON.stringify(arg) : arg
}

/** Whether `text` is a whole number (the runner's rule) of at least 1: `<PID>`'s number and `<grace>`'s m. */
function isPositiveWholeNumber(text: string): boolean {
  return isWholeNumber(text) && Number(text) >= LEAST_POSITIVE_WHOLE_NUMBER
}

/** Whether `text` is a well-formed `<PID>`: `-`, or a whole number of at least 1 (no sign, no leading zero). */
export function isPidArgument(text: string): boolean {
  return text === PID_ARGUMENT_NONE || isPositiveWholeNumber(text)
}

/** `<grace>` parsed: `none`, `term:<m>` or `kill:<m>`, m a whole number of at least 1; null for anything else. */
export function parseGrace(text: string): Grace | null {
  if (text === GRACE_NONE) return { kind: 'none' }
  if (text.startsWith(GRACE_TERM_PREFIX)) {
    const minutes = text.slice(GRACE_TERM_PREFIX.length)
    return isPositiveWholeNumber(minutes) ? { kind: 'term', minutes } : null
  }
  if (text.startsWith(GRACE_KILL_PREFIX)) {
    const minutes = text.slice(GRACE_KILL_PREFIX.length)
    return isPositiveWholeNumber(minutes) ? { kind: 'kill', minutes } : null
  }
  return null
}

/** `<grace>` as the stop line and the report verb write it: `none`, `term:<m>` or `kill:<m>`. */
export function graceText(grace: Grace): string {
  switch (grace.kind) {
    case 'none':
      return GRACE_NONE
    case 'term':
      return `${GRACE_TERM_PREFIX}${grace.minutes}`
    case 'kill':
      return `${GRACE_KILL_PREFIX}${grace.minutes}`
  }
}

/** The verbs as the usage reasons list them: `report, wait or stop`. */
const VERB_CHOICES_TEXT = `${READER_VERBS[0]}, ${READER_VERBS[1]} or ${READER_VERBS[2]}`

/** Why a command line is malformed, naming the argument (b.uqm SR-17.1). */
export function usageProblemText(problem: UsageProblem): string {
  switch (problem.kind) {
    case 'missing':
      return problem.what === 'verb' ? `the verb is missing: the verb must be ${VERB_CHOICES_TEXT}` : `<${problem.what}> is missing`
    case 'bad-verb':
      return `${shownArgument(problem.arg)} is not a verb: the verb must be ${VERB_CHOICES_TEXT}`
    case 'bad-run-id':
      return `<RUN_ID> ${shownArgument(problem.arg)} is not a RUN_ID: a RUN_ID is <YYYYMMDD>t<HHMMSS>z-<suffix>, a real UTC moment, then 8 lowercase letters or digits`
    case 'bad-pid':
      return `<PID> ${shownArgument(problem.arg)} is malformed: <PID> must be ${PID_ARGUMENT_NONE} or a whole number of at least ${LEAST_POSITIVE_WHOLE_NUMBER}`
    case 'bad-grace':
      return `<grace> ${shownArgument(problem.arg)} is malformed: <grace> must be ${GRACE_NONE}, ${GRACE_TERM_PREFIX}<m> or ${GRACE_KILL_PREFIX}<m>, m a whole number of at least ${LEAST_POSITIVE_WHOLE_NUMBER}`
    case 'extra':
      return `${shownArgument(problem.arg)} is an extra argument: ${problem.verb} takes only <RUN_ID> <PID>`
  }
}

/** The one standard-error line of a malformed command line: `usage: <the three command lines>: <why>` (b.uqm SR-17.1). */
export function readerUsageLine(problem: UsageProblem): string {
  return `${USAGE_PREFIX}${READER_USAGE_TEXT}: ${usageProblemText(problem)}`
}

function isReaderVerb(text: string): text is ReaderVerb {
  return READER_VERBS.some((verb) => verb === text)
}

/**
 * Parses the reader's command line (b.uqm SR-17.1). Pure: it reads nothing.
 * Malformed when the verb is missing or unknown, an argument is missing, the
 * RUN_ID is not one (the runner's rule), `<PID>` is neither `-` nor a whole
 * number of at least 1, `<grace>` is not of its three forms, or `wait` or
 * `stop` gets more arguments. The first problem in argument order is named.
 */
export function parseReaderArguments(argv: readonly string[]): ReaderArgumentParse {
  const [verb, runId, pid, ...rest] = argv
  if (verb === undefined) return { ok: false, problem: { kind: 'missing', what: 'verb' } }
  if (!isReaderVerb(verb)) return { ok: false, problem: { kind: 'bad-verb', arg: verb } }
  if (runId === undefined) return { ok: false, problem: { kind: 'missing', what: 'RUN_ID' } }
  if (!isRunId(runId)) return { ok: false, problem: { kind: 'bad-run-id', arg: runId } }
  if (pid === undefined) return { ok: false, problem: { kind: 'missing', what: 'PID' } }
  if (!isPidArgument(pid)) return { ok: false, problem: { kind: 'bad-pid', arg: pid } }
  if (verb === 'report') {
    const [graceArg, ...ciArgs] = rest
    if (graceArg === undefined) return { ok: false, problem: { kind: 'missing', what: 'grace' } }
    const grace = parseGrace(graceArg)
    if (grace === null) return { ok: false, problem: { kind: 'bad-grace', arg: graceArg } }
    return { ok: true, invocation: { verb, runId, pid, grace, ciArgs } }
  }
  const [extra] = rest
  if (extra !== undefined) return { ok: false, problem: { kind: 'extra', verb, arg: extra } }
  return { ok: true, invocation: { verb, runId, pid } }
}

// ---------------------------------------------------------------------------
// 4. Run files, the runner's PID and liveness (E3 T1)
// ---------------------------------------------------------------------------
//
// Every read goes through the injected `readRunFile` and `runPathKind`. The
// status file is parsed by the runner's strict parser, so one it rejects
// counts exactly as a missing one (b.uqm SR-5.2). `results.json` is read
// narrowly: only `version` and `timingSummary` (b.uqm SR-16.1).

/** `verdict.txt` as `report` reads it: absent, present but unreadable, or its first line. */
export type VerdictFirstLine =
  | {
      readonly kind: 'absent'
    }
  | {
      /** It exists but cannot be read: an invalid first line, never absent. */
      readonly kind: 'unreadable'
    }
  | {
      readonly kind: 'line'
      /** The text up to the first line feed (the whole text when it has none). */
      readonly line: string
    }

/** What `report` reads from a run directory (b.uqm SR-17.1). */
export interface ReportFiles {
  /** The run directory, as the runner derives it. */
  readonly runDir: string
  /** Whether a directory lies at its path; when none does, nothing else is read. */
  readonly runDirExists: boolean
  readonly verdict: VerdictFirstLine
  /** The status file, or null for no status file: missing, unreadable, or rejected by the runner's parser. */
  readonly status: RunStatus | null
  /** `results.json`'s timing summary, one string per line; null when it cannot be read. */
  readonly timingSummary: readonly string[] | null
  /** The runner log's last lines, at most `RUNNER_LOG_TAIL_LINES`, in file order; null when there is no readable log. */
  readonly logTail: readonly string[] | null
}

/** Whether a directory (not a link, not a file) lies at the run directory's path. */
export function hasRunDirectory(reads: Pick<ReaderDeps, 'runPathKind'>, runDir: string): boolean {
  return reads.runPathKind(runDir) === 'directory'
}

/** Whether `verdict.txt` exists in the run directory: anything at its path counts, even what cannot be read. The wait verb's only look at it (b.uqm SR-17.1). */
export function verdictFileExists(reads: Pick<ReaderDeps, 'runPathKind'>, runDir: string): boolean {
  return reads.runPathKind(join(runDir, VERDICT_FILE_NAME)) !== 'missing'
}

/** `verdict.txt`'s first line, for `report` only: absent only when the path does not exist; any read failure is unreadable. */
export function readVerdictFirstLine(reads: Pick<ReaderDeps, 'readRunFile'>, runDir: string): VerdictFirstLine {
  const read = reads.readRunFile(join(runDir, VERDICT_FILE_NAME))
  switch (read.kind) {
    case 'missing':
      return { kind: 'absent' }
    case 'unreadable':
      return { kind: 'unreadable' }
    case 'text': {
      const end = read.text.indexOf('\n')
      return { kind: 'line', line: end < 0 ? read.text : read.text.slice(0, end) }
    }
  }
}

/** The status file through the runner's parser (b.uqm SR-5.2); null for no status file. */
export function readRunStatus(reads: Pick<ReaderDeps, 'readRunFile'>, runDir: string): RunStatus | null {
  const read = reads.readRunFile(join(runDir, STATUS_FILE_NAME))
  if (read.kind !== 'text') return null
  const parsed = parseStatus(read.text)
  return parsed.ok ? parsed.value : null
}

/** Whether a JSON value is an object: not null, not an array. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The timing summary from `results.json`'s text (b.uqm SR-16.1, SR-17.3):
 * null when the text is not JSON, not an object, holds another `version`, or
 * its `timingSummary` is not an array of strings. No other key is checked.
 */
export function parseTimingSummary(text: string): readonly string[] | null {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (!isJsonObject(value) || value.version !== RESULTS_FORMAT_VERSION) return null
  const summary = value.timingSummary
  return Array.isArray(summary) && summary.every((line) => typeof line === 'string') ? (summary as string[]) : null
}

/** `results.json`'s timing summary; null when the file is missing, unreadable or fails `parseTimingSummary`. */
export function readTimingSummary(reads: Pick<ReaderDeps, 'readRunFile'>, runDir: string): readonly string[] | null {
  const read = reads.readRunFile(join(runDir, RESULTS_FILE_NAME))
  return read.kind === 'text' ? parseTimingSummary(read.text) : null
}

/** A text's last `count` lines in order: split at line feeds, a final line feed ending the last line, so an empty text has none. */
export function lastLines(text: string, count: number): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines.slice(Math.max(lines.length - count, 0))
}

/** The runner log's last `RUNNER_LOG_TAIL_LINES` lines; null when the log is missing or cannot be read. */
export function readRunnerLogTail(reads: Pick<ReaderDeps, 'readRunFile'>, runDir: string): readonly string[] | null {
  const read = reads.readRunFile(join(runDir, RUNNER_LOG_FILE_NAME))
  return read.kind === 'text' ? lastLines(read.text, RUNNER_LOG_TAIL_LINES) : null
}

/** Everything `report` reads (b.uqm SR-17.1). When no directory lies at the run directory's path, nothing in it is read: no verdict, no status, no timing summary, no log. */
export function readReportFiles(reads: RunFileReads, runDir: string): ReportFiles {
  if (!hasRunDirectory(reads, runDir)) {
    return { runDir, runDirExists: false, verdict: { kind: 'absent' }, status: null, timingSummary: null, logTail: null }
  }
  return {
    runDir,
    runDirExists: true,
    verdict: readVerdictFirstLine(reads, runDir),
    status: readRunStatus(reads, runDir),
    timingSummary: readTimingSummary(reads, runDir),
    logTail: readRunnerLogTail(reads, runDir),
  }
}

/** The status file's refusal, or null when there is no status file or it records none. */
export function statusRefusal(status: RunStatus | null): Refusal | null {
  return status !== null && status.phase === 'refused' ? status.refusal : null
}

/**
 * The runner's PID (b.uqm SR-17.1): the status file's `pid` when the status
 * file can be read, else the `<PID>` argument when it is a number, else none
 * (null). A `<PID>` too large to be a process ID is none.
 */
export function resolveRunnerPid(status: RunStatus | null, pidArgument: string): number | null {
  if (status !== null) return status.pid
  if (pidArgument === PID_ARGUMENT_NONE) return null
  const pid = Number(pidArgument)
  return Number.isSafeInteger(pid) ? pid : null
}

/**
 * Whether the run's runner is alive (b.uqm SR-6.3, SR-17.1), by the runner's
 * own rule only: a PID that is none is gone; any other is alive only when it is
 * a live process whose command line runs `scripts/ci-run.ts` with this
 * RUN_ID, so a gone PID, one reused by another program and one reused by a
 * `/ci` runner with another RUN_ID are all gone.
 */
export function isRunnerAlive(runId: string, pid: number | null, probe: OwnerLivenessProbe): boolean {
  return pid !== null && isOwnerAlive({ runId, pid }, probe)
}

// ---------------------------------------------------------------------------
// 5. First-line validity (E3 T1)
// ---------------------------------------------------------------------------
//
// Which first lines are valid for an invocation (b.uqm SR-17.2), the second
// half of the double guard: only a full, uninjected invocation can have a
// first line of exactly `PASS`. The invocation is parsed by the runner's own
// rules; when it does not parse, no line is valid.

/** A first line judged against the invocation (b.uqm SR-17.2). */
export type FirstLineJudgement =
  | {
      readonly valid: false
    }
  | {
      readonly valid: true
      /** The invocation has a fault: the line is `INJECTED (<faults>): …`. */
      readonly injected: boolean
      /** The invocation selects scripts: the line (inside any `INJECTED` wrapper) is `SELECTIVE (<list>): …`. */
      readonly selective: boolean
      /** The line passes: `PASS`, or `SELECTIVE (<list>): PASS`, inside any wrapper. */
      readonly pass: boolean
      /** A selective line's list, as written; null for a full one. */
      readonly scripts: string | null
      /** The inner `FAIL: …` line, after any wrapper and `SELECTIVE (<list>): `; null for a PASS. */
      readonly failLine: string | null
    }

const INVALID_FIRST_LINE: FirstLineJudgement = { valid: false }

/**
 * The number forms a selective verdict's list must hold: test-1 and every
 * selected script, by its number form. Null when a SCRIPT argument is neither
 * a number form nor a file name: the runner refuses such a run, so no line is
 * valid for it.
 */
function requiredListEntries(invocation: Invocation): ReadonlySet<string> | null {
  const required = new Set<string>([numberFormOf(EVERY_SHARD_SCRIPT_NUMBER)])
  for (const script of invocation.scripts) {
    const form = classifyScriptName(script)
    if (form.kind === 'neither') return null
    required.add(form.numberForm)
  }
  return required
}

/** Whether a selective verdict's list is valid: number forms separated by single spaces, strictly in canonical order, holding every required entry. */
function isValidScriptList(list: string, required: ReadonlySet<string>): boolean {
  const entries = list.split(SCRIPT_LIST_SEPARATOR)
  if (!entries.every(isNumberForm)) return false
  for (let index = 1; index < entries.length; index++) {
    if (compareCanonical(entries[index - 1] as string, entries[index] as string) >= 0) return false
  }
  return [...required].every((entry) => entries.includes(entry))
}

/** A line's innermost part, after any wrapper: exactly `PASS`, a line beginning `FAIL: ` (kept whole as the FAIL line), or null for anything else. */
function passOrFail(text: string): { readonly pass: boolean; readonly failLine: string | null } | null {
  if (text === PASS_VERDICT) return { pass: true, failLine: null }
  if (text.startsWith(FAIL_PREFIX)) return { pass: false, failLine: text }
  return null
}

/**
 * Judges a verdict's first line against the `/ci` arguments (b.uqm SR-17.2).
 * Pure. Valid lines:
 * - no selection, no injection: exactly `PASS`, or a line beginning `FAIL: `;
 * - a selection, no injection: `SELECTIVE (<list>): PASS` or
 *   `SELECTIVE (<list>): FAIL: …`, the list being number forms separated by
 *   single spaces, strictly in canonical order, holding test-1 and every
 *   selected script (other number forms are the run's added prerequisites);
 * - an injection: `INJECTED (<faults>): ` followed by a line valid for the
 *   selection, the faults being the invocation's normalized faults in order.
 * Every other line is invalid, and every line is when the arguments do not
 * parse by the runner's rules.
 */
export function judgeFirstLine(ciArgs: readonly string[], line: string): FirstLineJudgement {
  const parsed = parseCiArguments(ciArgs)
  if (!parsed.ok) return INVALID_FIRST_LINE
  const invocation = parsed.invocation
  const required = requiredListEntries(invocation)
  if (required === null) return INVALID_FIRST_LINE
  const injected = isInjectedRun(invocation)
  let inner = line
  if (injected) {
    const prefix = injectedVerdictPrefix(invocation.faults)
    if (!line.startsWith(prefix)) return INVALID_FIRST_LINE
    inner = line.slice(prefix.length)
  }
  const selective = isSelectiveRun(invocation)
  if (!selective) {
    const result = passOrFail(inner)
    return result === null ? INVALID_FIRST_LINE : { valid: true, injected, selective, scripts: null, ...result }
  }
  if (!inner.startsWith(SELECTIVE_VERDICT_OPEN)) return INVALID_FIRST_LINE
  const afterOpen = inner.slice(SELECTIVE_VERDICT_OPEN.length)
  const close = afterOpen.indexOf(VERDICT_WRAPPER_CLOSE)
  if (close < 0) return INVALID_FIRST_LINE
  const scripts = afterOpen.slice(0, close)
  if (!isValidScriptList(scripts, required)) return INVALID_FIRST_LINE
  const result = passOrFail(afterOpen.slice(close + VERDICT_WRAPPER_CLOSE.length))
  return result === null ? INVALID_FIRST_LINE : { valid: true, injected, selective, scripts, ...result }
}

/** `verdict.txt` judged: null when it is absent; invalid when it cannot be read; else its first line judged. */
export function judgeVerdict(ciArgs: readonly string[], verdict: VerdictFirstLine): FirstLineJudgement | null {
  switch (verdict.kind) {
    case 'absent':
      return null
    case 'unreadable':
      return INVALID_FIRST_LINE
    case 'line':
      return judgeFirstLine(ciArgs, verdict.line)
  }
}

// ---------------------------------------------------------------------------
// 6. The report verb (E3 T1)
// ---------------------------------------------------------------------------
//
// The mapping from a run's files to the report's lines and exit code (b.uqm
// SR-17.3), the masking of every run-file text it prints (SR-17.4) and the
// removal of a PASS's or a refusal's run directory after printing (SR-16.3).
// The decision reads no liveness: the grace argument carries any signal sent.

/** The report's seven outcomes, in precedence (b.uqm SR-17.3). */
export type ReportOutcome = 'not-run' | 'runner-died' | 'injected' | 'selective-pass' | 'selective-fail' | 'full-pass' | 'full-fail'

/** What the report decision needs. */
export interface ReportInput {
  /** The run's files, as `readReportFiles` reads them. */
  readonly files: ReportFiles
  /** The verdict's first line judged (`judgeVerdict`); null when there is no `verdict.txt`. */
  readonly judgement: FirstLineJudgement | null
  readonly grace: Grace
  /** The runner's PID as `resolveRunnerPid` finds it; null for none. */
  readonly runnerPid: number | null
  /** `<PID>` as given, printed in the grace line when no PID is found. */
  readonly pidArgument: string
}

/** The report: its lines in print order, its exit code, and whether the run directory is then removed. */
export interface ReportDecision {
  readonly outcome: ReportOutcome
  readonly lines: readonly string[]
  readonly exitCode: number
  readonly removeRunDir: boolean
}

/** Replaces text taken from a run file before it is printed. */
export type RunFileMask = (text: string) => string

const NO_MASK: RunFileMask = (text) => text

/** `results: <run dir>`. */
export function resultsLine(runDir: string): string {
  return `${RESULTS_LINE_PREFIX}${runDir}`
}

/** `timing summary could not be read from <run dir>/results.json` (b.uqm SR-17.3). */
export function timingSummaryUnreadableLine(runDir: string): string {
  return `timing summary could not be read from ${runDir}/${RESULTS_FILE_NAME}`
}

/** `runner <PID> still alive after the <m> min deadline plus grace: sent SIGTERM`, ending `, then SIGKILL after 30 s` for `kill:<m>` (b.uqm SR-17.3). */
export function graceSignalLine(pid: string, grace: Exclude<Grace, { readonly kind: 'none' }>): string {
  const term = `runner ${pid} still alive after the ${grace.minutes} min deadline plus grace: sent SIGTERM`
  return grace.kind === 'kill' ? `${term}, then SIGKILL after ${STOP_KILL_AFTER_MS / MS_PER_SECOND} s` : term
}

/** `INJECTED (not a gate result): <verdict line>`. */
export function injectedReportLine(verdictLine: string): string {
  return `${INJECTED_REPORT_PREFIX}${verdictLine}`
}

/** `SELECTIVE (not a gate result): PASS: <scripts>`. */
export function selectivePassLine(scripts: string): string {
  return `${SELECTIVE_REPORT_PREFIX}${PASS_VERDICT}: ${scripts}`
}

/** `SELECTIVE (not a gate result): <FAIL line>`. */
export function selectiveFailLine(failLine: string): string {
  return `${SELECTIVE_REPORT_PREFIX}${failLine}`
}

/** A refusal's report: `NOT RUN: <reason>` (the runner's `refusalLine`), then each detail line in order (b.uqm SR-5.8, SR-17.3). */
export function notRunLines(refusal: Refusal): string[] {
  return [refusalLine(refusal), ...refusal.details]
}

/** The one standard-error line of a removal that failed, naming the run directory and holding no error text (b.uqm SR-16.3). */
export function removalFailedLine(runDir: string): string {
  return `ci-verdict: the run directory ${runDir} could not be removed; remove it by hand`
}

/** A PASS's lines: its line, then the timing summary, or the line saying it could not be read, which also keeps the directory. */
function passReport(outcome: 'selective-pass' | 'full-pass', passLine: string, files: ReportFiles, mask: RunFileMask, exitCode: number): ReportDecision {
  if (files.timingSummary === null) {
    return { outcome, lines: [passLine, timingSummaryUnreadableLine(files.runDir)], exitCode, removeRunDir: false }
  }
  return { outcome, lines: [passLine, ...files.timingSummary.map(mask)], exitCode, removeRunDir: true }
}

/** The runner-died report (b.uqm SR-17.3): its line, the directory when it exists, the log tail when there is one, and the grace line when the skill signalled. */
function runnerDiedReport(input: ReportInput, mask: RunFileMask): ReportDecision {
  const { files, grace } = input
  const lines = [RUNNER_DIED_TEXT]
  if (files.runDirExists) lines.push(resultsLine(files.runDir))
  if (files.logTail !== null) lines.push(...files.logTail.map(mask))
  if (grace.kind !== 'none') lines.push(graceSignalLine(input.runnerPid === null ? input.pidArgument : String(input.runnerPid), grace))
  return { outcome: 'runner-died', lines, exitCode: REPORT_EXIT_FAIL, removeRunDir: false }
}

/**
 * The report (b.uqm SR-17.3), in precedence:
 * 1. not runnable, exit 2: a refusal, no verdict, grace `none`;
 * 2. runner died or invalid, exit 1: no valid verdict and no refusal, a
 *    verdict and a refusal both, an invalid first line, or any signalled grace;
 * 3. injected, exit 4;
 * 4. selective PASS, exit 3;
 * 5. selective FAIL, exit 1;
 * 6. full PASS, exit 0, only for a full uninjected invocation and exactly `PASS`;
 * 7. full FAIL, exit 1.
 * Pure. `mask` is applied to every printed text taken from a run file (the
 * verdict line and what is derived from it, the refusal's summary and details,
 * the log tail, the timing summary), never to the reader's own texts or the
 * run directory's path. Removal is allowed only after rows 1, 4 and 6, and
 * not when a PASS's timing summary cannot be read.
 */
export function decideReport(input: ReportInput, mask: RunFileMask = NO_MASK): ReportDecision {
  const { files, judgement, grace } = input
  const refusal = statusRefusal(files.status)
  const verdictPresent = files.verdict.kind !== 'absent'
  if (refusal !== null && !verdictPresent && grace.kind === 'none') {
    const shown: Refusal = { kind: refusal.kind, summary: mask(refusal.summary), details: refusal.details.map(mask) }
    return { outcome: 'not-run', lines: notRunLines(shown), exitCode: REPORT_EXIT_NOT_RUN, removeRunDir: true }
  }
  if (grace.kind !== 'none' || refusal !== null || judgement === null || !judgement.valid || files.verdict.kind !== 'line') {
    return runnerDiedReport(input, mask)
  }
  const verdictLine = files.verdict.line
  if (judgement.injected) {
    return { outcome: 'injected', lines: [injectedReportLine(mask(verdictLine)), resultsLine(files.runDir)], exitCode: REPORT_EXIT_INJECTED, removeRunDir: false }
  }
  if (judgement.selective) {
    if (judgement.pass) return passReport('selective-pass', selectivePassLine(mask(judgement.scripts ?? '')), files, mask, REPORT_EXIT_SELECTIVE_PASS)
    return { outcome: 'selective-fail', lines: [selectiveFailLine(mask(judgement.failLine ?? '')), resultsLine(files.runDir)], exitCode: REPORT_EXIT_FAIL, removeRunDir: false }
  }
  if (judgement.pass) return passReport('full-pass', FULL_PASS_TEXT, files, mask, REPORT_EXIT_FULL_PASS)
  return { outcome: 'full-fail', lines: [mask(verdictLine), resultsLine(files.runDir)], exitCode: REPORT_EXIT_FAIL, removeRunDir: false }
}

/** A value as a pattern matching it literally. */
function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A mask that replaces every one of `values` with `<redacted>` (b.uqm
 * SR-17.4), longest first so one pass replaces each whole value. Empty values
 * are ignored; every other value is masked whatever its length.
 */
export function secretMask(values: Iterable<string>): RunFileMask {
  const list = [...new Set(values)].filter((value) => value !== '').sort((a, b) => b.length - a.length)
  if (list.length === 0) return NO_MASK
  const pattern = new RegExp(list.map(escapedPattern).join('|'), 'g')
  return (text) => text.replace(pattern, REDACTION_PLACEHOLDER)
}

/**
 * The secret values the report masks (b.uqm SR-15.1, SR-17.4): the reader's
 * environment's secret credentials, by the runner's set, plus the base-build
 * token found by the runner's lookup, run through the injected spawn in the
 * reader's worktree root. Its first `gh auth token` gets the reader's
 * environment plus `GH_CONFIG_DIR=<$HOME>/.config/gh-personal`, the plain one
 * after it the environment unchanged (SR-15.4). A failed or empty lookup adds
 * nothing. No value is printed, logged or passed on.
 */
export async function gatherSecretValues(deps: Pick<ReaderDeps, 'spawn' | 'env' | 'worktreeRoot'>): Promise<ReadonlySet<string>> {
  const baseBuildToken = await lookUpBaseBuildToken(deps.spawn, deps.env, deps.worktreeRoot)
  return secretCredentialSet(deps.env, { baseBuildToken })
}

/** Writes each line to standard output; false when a write failed, after which nothing more is written. */
function printLines(deps: Pick<ReaderDeps, 'writeStdout'>, lines: readonly string[]): boolean {
  for (const line of lines) {
    try {
      deps.writeStdout(`${line}\n`)
    } catch {
      return false
    }
  }
  return true
}

/** Writes one line to standard error; a failing standard error is the last place left, so its failure is dropped. */
function stderrLine(deps: Pick<ReaderDeps, 'writeStderr'>, line: string): void {
  try {
    deps.writeStderr(`${line}\n`)
  } catch {
    // Nowhere left to report to.
  }
}

/**
 * The report verb (b.uqm SR-17.1, SR-17.3, SR-17.4, SR-16.3): reads the run
 * directory derived from the RUN_ID, judges the verdict, gathers the secret
 * values, prints the report, and only then, when the decision allows it and
 * every line was written, removes that directory. A failed removal adds one
 * standard-error line naming the directory; the report and exit code stand.
 * Answers the exit code.
 */
export async function runReport(invocation: ReportInvocation, deps: ReaderDeps): Promise<number> {
  const runDir = runDirPath(deps.env, invocation.runId)
  const files = readReportFiles(deps, runDir)
  const decision = decideReport(
    {
      files,
      judgement: judgeVerdict(invocation.ciArgs, files.verdict),
      grace: invocation.grace,
      runnerPid: resolveRunnerPid(files.status, invocation.pid),
      pidArgument: invocation.pid,
    },
    secretMask(await gatherSecretValues(deps)),
  )
  const printed = printLines(deps, decision.lines)
  if (printed && decision.removeRunDir && !deps.removeRunDir(runDir).ok) stderrLine(deps, removalFailedLine(runDir))
  return decision.exitCode
}

// ---------------------------------------------------------------------------
// 7. The wait verb (E3 T2)
// ---------------------------------------------------------------------------
//
// `wait` (b.uqm SR-17.5) checks the run at its start, then every 1 s on the
// injected clock, for at most 90 s, and returns the first state that holds.
// It counts the deadline and the grace from the run's files and the RUN_ID
// alone, so the skill keeps no count across calls. It only reads: it never
// writes, renames, removes, signals or spawns, and it only tests whether
// `verdict.txt` exists, never reading it.

/** The wait verb's states, in the order its checks take them (b.uqm SR-17.5). */
export const WAIT_STATES = ['verdict', 'refused', 'gone', 'grace', 'running'] as const

/** One of the wait verb's states. */
export type WaitState = (typeof WAIT_STATES)[number]

/** The wait line's phase while no status file can be read. */
export const PHASE_NONE = 'none'

/** The status file's phase, or `none` while no status file can be read. */
export type WaitPhase = StatusPhase | typeof PHASE_NONE

/** Milliseconds in a minute, for the deadline and the grace. */
const MS_PER_MINUTE = 60_000

/** The run's deadline and grace as the wait and stop verbs count them (b.uqm SR-17.5). */
export interface RunDeadline {
  /** The deadline, epoch milliseconds. */
  readonly deadlineMs: number
  /** The deadline's minutes from the runner's start: `deadline.minutes`, or 90 while no status file can be read. */
  readonly minutes: number
  /** The grace's end, `GRACE_MINUTES` after the deadline, epoch milliseconds. */
  readonly graceEndsMs: number
}

/**
 * The run's deadline (b.uqm SR-17.5): the status file's `deadline.epochSeconds`
 * and `deadline.minutes` when it can be read, else the RUN_ID's time plus
 * `NO_STATUS_DEADLINE_MINUTES` and that many minutes. The grace ends
 * `GRACE_MINUTES` after the deadline. Throws for a `runId` that is no RUN_ID,
 * which the argument parser never lets through.
 */
export function runDeadline(status: RunStatus | null, runId: string): RunDeadline {
  let deadlineMs: number
  let minutes: number
  if (status !== null) {
    deadlineMs = status.deadline.epochSeconds * MS_PER_SECOND
    minutes = status.deadline.minutes
  } else {
    const startMs = runIdTimeMs(runId)
    if (startMs === null) throw new Error(`${runId} is not a RUN_ID`)
    deadlineMs = startMs + NO_STATUS_DEADLINE_MINUTES * MS_PER_MINUTE
    minutes = NO_STATUS_DEADLINE_MINUTES
  }
  return { deadlineMs, minutes, graceEndsMs: deadlineMs + GRACE_MINUTES * MS_PER_MINUTE }
}

/** What one check of the wait verb reads (b.uqm SR-17.5). */
export interface WaitReading extends RunDeadline {
  /** Whether anything lies at `verdict.txt`'s path. */
  readonly verdictExists: boolean
  /** The status file's phase, or `none`. */
  readonly phase: WaitPhase
  /** Whether the status file records a refusal. */
  readonly refused: boolean
  /** The runner's PID (`resolveRunnerPid`); null for none. */
  readonly pid: number | null
  /** Whether the runner is alive by b.uqm SR-6.3 (`isRunnerAlive`). */
  readonly alive: boolean
  /** The clock at the check, epoch milliseconds. */
  readonly nowMs: number
}

/** The members one wait check uses: reads, the liveness probe and the clock. Nothing that writes, removes, signals or spawns. */
export type WaitCheckDeps = Pick<ReaderDeps, 'env' | 'readRunFile' | 'runPathKind' | 'isPidAlive' | 'readProcCmdline' | 'clock'>

/** One check of the run (b.uqm SR-17.5): whether `verdict.txt` exists, the status file's phase, refusal and deadline, the runner's PID and liveness, and the clock. */
export function readWaitCheck(runId: string, pidArgument: string, deps: WaitCheckDeps): WaitReading {
  const runDir = runDirPath(deps.env, runId)
  const verdictExists = verdictFileExists(deps, runDir)
  const status = readRunStatus(deps, runDir)
  const pid = resolveRunnerPid(status, pidArgument)
  return {
    verdictExists,
    phase: status === null ? PHASE_NONE : status.phase,
    refused: statusRefusal(status) !== null,
    pid,
    alive: isRunnerAlive(runId, pid, deps),
    nowMs: deps.clock.now(),
    ...runDeadline(status, runId),
  }
}

/**
 * The state one check finds (b.uqm SR-17.5), the first that holds in this
 * order: `verdict`, `refused`, `gone`, `grace` (the clock at or after the
 * grace's end, the runner alive), `running` (the phase differs from
 * `firstPhase`, the one the first check read). Null when none holds; the
 * bound is the caller's.
 */
export function waitStateOf(reading: WaitReading, firstPhase: WaitPhase): WaitState | null {
  if (reading.verdictExists) return 'verdict'
  if (reading.refused) return 'refused'
  if (!reading.alive) return 'gone'
  if (reading.nowMs >= reading.graceEndsMs) return 'grace'
  if (reading.phase !== firstPhase) return 'running'
  return null
}

/** The wait verb's exit code for a state (b.uqm SR-17.5). */
export function waitExitCode(state: WaitState): number {
  switch (state) {
    case 'verdict':
      return WAIT_EXIT_VERDICT
    case 'refused':
      return WAIT_EXIT_REFUSED
    case 'gone':
      return WAIT_EXIT_GONE
    case 'grace':
      return WAIT_EXIT_GRACE
    case 'running':
      return WAIT_EXIT_RUNNING
  }
}

/** A PID as the wait and stop lines print it: the number, or `-` for none. */
function pidText(pid: number | null): string {
  return pid === null ? PID_ARGUMENT_NONE : String(pid)
}

/**
 * The wait verb's one line (b.uqm SR-17.5):
 * `wait: <state> phase=<phase|none> pid=<pid|-> runner=<alive|gone> deadline=<UTC time> minutes=<m> grace-ends=<UTC time>`,
 * the UTC times in the runner's format (`formatUtcTime`).
 */
export function waitLine(state: WaitState, reading: Pick<WaitReading, 'phase' | 'pid' | 'alive' | 'deadlineMs' | 'minutes' | 'graceEndsMs'>): string {
  const runner = reading.alive ? 'alive' : 'gone'
  return `wait: ${state} phase=${reading.phase} pid=${pidText(reading.pid)} runner=${runner} deadline=${formatUtcTime(reading.deadlineMs)} minutes=${reading.minutes} grace-ends=${formatUtcTime(reading.graceEndsMs)}`
}

/** Resolves after `delayMs` on the injected clock's timer: the verbs' only way to wait. */
function pause(clock: ReaderDeps['clock'], delayMs: number): Promise<void> {
  return new Promise((resolvePause) => {
    clock.setTimeout(resolvePause, delayMs)
  })
}

/** How a wait ended: its state and the check its line reports. */
export interface WaitResult {
  readonly state: WaitState
  readonly reading: WaitReading
}

/**
 * Waits for the run to move on (b.uqm SR-17.5), on the injected clock only.
 * It checks at its start, then `WAIT_CHECK_INTERVAL_MS` after each check
 * (one `clock.setTimeout` per pause), and returns at the first check at which
 * a state holds (`waitStateOf`). When a check finds none and the bound
 * (`WAIT_BOUND_MS` from the start) is reached, it returns `running`; when
 * less than one interval is left, it pauses for what is left and returns
 * `running` with that check, never checking more often than every 1 s.
 */
export async function waitForRun(runId: string, pidArgument: string, deps: WaitCheckDeps): Promise<WaitResult> {
  const boundAtMs = deps.clock.now() + WAIT_BOUND_MS
  let reading = readWaitCheck(runId, pidArgument, deps)
  const firstPhase = reading.phase
  for (;;) {
    const state = waitStateOf(reading, firstPhase)
    if (state !== null) return { state, reading }
    const leftMs = boundAtMs - deps.clock.now()
    if (leftMs <= 0) return { state: 'running', reading }
    if (leftMs < WAIT_CHECK_INTERVAL_MS) {
      await pause(deps.clock, leftMs)
      return { state: 'running', reading }
    }
    await pause(deps.clock, WAIT_CHECK_INTERVAL_MS)
    reading = readWaitCheck(runId, pidArgument, deps)
  }
}

/** The wait verb (b.uqm SR-17.5): waits, prints its one line on standard output and answers the state's exit code. */
export async function runWait(invocation: WaitInvocation, deps: ReaderDeps): Promise<number> {
  const { state, reading } = await waitForRun(invocation.runId, invocation.pid, deps)
  printLines(deps, [waitLine(state, reading)])
  return waitExitCode(state)
}

// ---------------------------------------------------------------------------
// 8. The stop verb (E3 T2)
// ---------------------------------------------------------------------------
//
// `stop` (b.uqm SR-17.6) signals only a runner alive by SR-6.3, and only its
// PID, never a process group: SIGTERM, then SIGKILL when it is still alive
// 30 s later. A signal that is not delivered (no such process, or not
// permitted) counts as not sent. It writes, renames, removes and spawns
// nothing.

/** What the stop verb did (b.uqm SR-17.6). */
export type StopOutcome =
  | {
      /** No signal sent: the PID is none, not alive by SR-6.3, or its SIGTERM was not delivered. */
      readonly kind: 'not-alive'
      readonly pid: number | null
    }
  | {
      /** SIGTERM sent; no SIGKILL sent. */
      readonly kind: 'term'
      readonly pid: number
      /** m, the deadline's minutes as the wait line prints them. */
      readonly minutes: number
    }
  | {
      /** SIGTERM, then SIGKILL 30 s later. */
      readonly kind: 'kill'
      readonly pid: number
      /** m, the deadline's minutes as the wait line prints them. */
      readonly minutes: number
    }

/** The grace argument a stop outcome gives the report verb: `none`, `term:<m>` or `kill:<m>`. */
export function stopGrace(outcome: StopOutcome): Grace {
  return outcome.kind === 'not-alive' ? { kind: 'none' } : { kind: outcome.kind, minutes: String(outcome.minutes) }
}

/**
 * The stop verb's one line (b.uqm SR-17.6), `stop: <what it did>; grace <grace>`:
 * - `stop: runner <pid|-> not alive, no signal sent; grace none`
 * - `stop: sent SIGTERM to runner <pid>; grace term:<m>`
 * - `stop: sent SIGTERM to runner <pid>, then SIGKILL after 30 s; grace kill:<m>`
 */
export function stopLine(outcome: StopOutcome): string {
  const grace = graceText(stopGrace(outcome))
  switch (outcome.kind) {
    case 'not-alive':
      return `stop: runner ${pidText(outcome.pid)} not alive, no signal sent; grace ${grace}`
    case 'term':
      return `stop: sent SIGTERM to runner ${outcome.pid}; grace ${grace}`
    case 'kill':
      return `stop: sent SIGTERM to runner ${outcome.pid}, then SIGKILL after ${STOP_KILL_AFTER_MS / MS_PER_SECOND} s; grace ${grace}`
  }
}

/** The stop verb's exit code for an outcome: 0, 20 or 21 (b.uqm SR-17.6). */
export function stopExitCode(outcome: StopOutcome): number {
  switch (outcome.kind) {
    case 'not-alive':
      return STOP_EXIT_NOT_ALIVE
    case 'term':
      return STOP_EXIT_SENT_SIGTERM
    case 'kill':
      return STOP_EXIT_SENT_SIGKILL
  }
}

/** The members the stop verb uses: reads, the liveness probe, the clock and the signal. Nothing that writes, removes or spawns. */
export type StopDeps = Pick<ReaderDeps, 'env' | 'readRunFile' | 'isPidAlive' | 'readProcCmdline' | 'clock' | 'sendSignal'>

/** Sends `signal` to `pid` alone, never to a process group; true only when it was delivered. */
function signalPid(deps: Pick<ReaderDeps, 'sendSignal'>, pid: number, signal: SentSignal): boolean {
  return deps.sendSignal({ kind: 'pid', pid }, signal) === 'delivered'
}

/**
 * Stops the run's runner (b.uqm SR-17.6). Reads the status file once for the
 * PID (`resolveRunnerPid`) and m (`runDeadline`). Sends nothing unless that
 * PID is alive by SR-6.3. Then it sends SIGTERM to the PID; one not delivered
 * gives `not-alive`. After it, it checks liveness every
 * `STOP_CHECK_INTERVAL_MS` on the injected clock (the last pause shortened to
 * end exactly `STOP_KILL_AFTER_MS` after the SIGTERM): a runner found gone,
 * its PID reused included, gives `term`; one still alive at the check
 * `STOP_KILL_AFTER_MS` after the SIGTERM gets SIGKILL, `kill` when it is
 * delivered and `term` when it is not.
 */
export async function stopRunner(runId: string, pidArgument: string, deps: StopDeps): Promise<StopOutcome> {
  const status = readRunStatus(deps, runDirPath(deps.env, runId))
  const pid = resolveRunnerPid(status, pidArgument)
  if (pid === null || !isRunnerAlive(runId, pid, deps)) return { kind: 'not-alive', pid }
  const { minutes } = runDeadline(status, runId)
  if (!signalPid(deps, pid, 'SIGTERM')) return { kind: 'not-alive', pid }
  const killAtMs = deps.clock.now() + STOP_KILL_AFTER_MS
  for (;;) {
    const leftMs = killAtMs - deps.clock.now()
    if (leftMs > 0) await pause(deps.clock, Math.min(STOP_CHECK_INTERVAL_MS, leftMs))
    if (!isRunnerAlive(runId, pid, deps)) return { kind: 'term', pid, minutes }
    if (deps.clock.now() >= killAtMs) {
      return signalPid(deps, pid, 'SIGKILL') ? { kind: 'kill', pid, minutes } : { kind: 'term', pid, minutes }
    }
  }
}

/** The stop verb (b.uqm SR-17.6): stops the runner, prints its one line on standard output and answers its exit code. */
export async function runStop(invocation: StopInvocation, deps: ReaderDeps): Promise<number> {
  const outcome = await stopRunner(invocation.runId, invocation.pid, deps)
  printLines(deps, [stopLine(outcome)])
  return stopExitCode(outcome)
}

// ---------------------------------------------------------------------------
// 9. The verb runner and the entry block (E3 T1)
// ---------------------------------------------------------------------------

/**
 * The reader, driven in process through its dependencies (b.uqm SR-21.1):
 * parses the command line, then runs its verb. Answers the exit code and
 * never exits the process; only the entry block does.
 * - Malformed arguments: one `usage: ` line on standard error, nothing on
 *   standard output, `USAGE_EXIT_STATUS` (64), and no other dependency used.
 * - `report`: `runReport`'s code.
 * - `wait`: `runWait`'s code.
 * - `stop`: `runStop`'s code.
 * - An error a verb throws: one `ci-verdict: ` line on standard error, 1.
 */
export async function runVerdictReader(argv: readonly string[], deps: ReaderDeps): Promise<number> {
  const parsed = parseReaderArguments(argv)
  if (!parsed.ok) {
    stderrLine(deps, readerUsageLine(parsed.problem))
    return USAGE_EXIT_STATUS
  }
  const invocation = parsed.invocation
  try {
    switch (invocation.verb) {
      case 'report':
        return await runReport(invocation, deps)
      case 'wait':
        return await runWait(invocation, deps)
      case 'stop':
        return await runStop(invocation, deps)
    }
  } catch (err) {
    stderrLine(deps, `ci-verdict: ${invocation.verb} failed: ${oneLineError(err)}`)
    return FAILURE_EXIT_STATUS
  }
}

// The one main-module entry block: the only top-level statement that is not
// a declaration, import or export, and the last thing in the file. It binds
// the real dependencies, runs the verb runner with the process arguments and
// exits with its code; an uncaught error writes one line to standard error and
// exits 1. Nothing here runs on import (b.uqm SR-1.3).
if (import.meta.main) {
  const fail: (err: unknown, origin: string) => never = (err, origin) => {
    writeSync(2, `ci-verdict: ${origin}: ${oneLineError(err)}\n`)
    process.exit(FAILURE_EXIT_STATUS)
  }
  process.on('uncaughtException', (err) => fail(err, 'uncaught exception'))
  process.on('unhandledRejection', (reason) => fail(reason, 'unhandled rejection'))
  let deps: ReaderDeps
  try {
    deps = createRealReaderDeps()
  } catch (err) {
    fail(err, 'binding the dependencies')
  }
  runVerdictReader(process.argv.slice(2), deps).then(
    (code) => process.exit(code),
    (err: unknown) => fail(err, 'main'),
  )
}
