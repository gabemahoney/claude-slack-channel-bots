/**
 * tests/ci-verdict.test.ts — The `/ci` verdict reader (`scripts/ci-verdict.ts`,
 * b.uqm SR-17, SR-21.6).
 *
 * E3 region: the reader's module properties (b.uqm SR-1.3, the reader's
 * half); one pin case per reader constant of SR-21.5; the verbs' arguments,
 * exit 64 and how the runner's PID is found (SR-17.1); valid and invalid
 * first lines (SR-17.2); every outcome row, its example and the precedence
 * (SR-17.3); the `wait` verb (SR-17.5); the `stop` verb (SR-17.6); redaction
 * (SR-17.4) and retention (SR-16.3).
 *
 * E13 region: the audit of the `/ci` skill (SR-18.3), added by E13.
 *
 * Every verb runs in process through `runVerdictReader` and the reader's
 * injected dependencies (b.uqm SR-21.1), built by the file's verb harness
 * below from `tests/test-helpers/ci-run.ts`: no test runs the reader or the
 * runner as a process, starts a container or signals a real process. Every
 * wait and timer runs on `createFakeClock`; every credential comes from
 * `fakeToken`; everything a verb prints, every dependency call and every file
 * under the case's root passes `assertNoLeak`. Only the constant-pin block
 * types a reader constant's value (b.uqm SR-21.5); the report texts and
 * report exit codes are typed only in the outcome block's row-example table.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import ts from 'typescript'
import * as runner from '../scripts/ci-run.ts'
import {
  GH_AUTH_TOKEN_ARGV,
  ghPersonalConfigDir,
  NUMBER_FORM_PATTERN,
  RUN_DIR_PREFIX,
  RUN_ID_PATTERN,
  runIdTimeMs,
  RUNNER_PATH_SUFFIX,
  SCRIPT_FILE_NAME_PATTERN,
  type RunStatus,
  type SentSignal,
  type SignalOutcome,
  type SignalTarget,
} from '../scripts/ci-run.ts'
import * as reader from '../scripts/ci-verdict.ts'
import {
  createRealRunFileDeps,
  GRACE_MINUTES,
  GRACE_NONE,
  LEAST_PID_AND_GRACE_MINUTES,
  NO_STATUS_DEADLINE_MINUTES,
  RUNNER_LOG_TAIL_LINES,
  runVerdictReader,
  STOP_CALL_LIMIT,
  STOP_CHECK_INTERVAL_MS,
  STOP_EXIT_NOT_ALIVE,
  STOP_EXIT_SENT_SIGKILL,
  STOP_EXIT_SENT_SIGTERM,
  STOP_KILL_AFTER_MS,
  STOP_READER_FAILED_TEXT,
  UNKNOWN_WAIT_EXIT_LIMIT,
  WAIT_BOUND_MS,
  WAIT_CHECK_INTERVAL_MS,
  WAIT_EXIT_GONE,
  WAIT_EXIT_GRACE,
  WAIT_EXIT_REFUSED,
  WAIT_EXIT_RUNNING,
  WAIT_EXIT_VERDICT,
  WAIT_READER_FAILED_TEXT,
  type ReaderDeps,
} from '../scripts/ci-verdict.ts'
import { assertNoLeak, fakeToken, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  buildRunDirectory,
  ciRunnerProcess,
  createProcessTable,
  createSignalRecorder,
  createSpawnRecorder,
  linkOutOfRunDir,
  makeResults,
  makeStatus,
  plantNonDirectoryAtRunDir,
  realScriptFileName,
  runDirIn,
  writeOffShapeResults,
  type FakeProcessOptions,
  type FakeProcessTable,
  type RunDirectorySpec,
  type SignalRecorder,
  type SpawnAnswer,
  type SpawnRecorder,
  type StatusSpec,
} from './test-helpers/ci-run.ts'
import { importSource, maskLiterals, runtimeSpecifiers, stripComments } from './test-helpers/source-audit.ts'
import { treeSnapshot } from './test-helpers/tree-snapshot.ts'

/** The repository root: this file sits in `tests/`. */
const REPO_ROOT = join(import.meta.dir, '..')

/** The reader's source text, read when a case runs. */
function readerSource(): string {
  return readFileSync(join(REPO_ROOT, 'scripts', 'ci-verdict.ts'), 'utf-8')
}

/** The specifier by which the reader, beside the runner in `scripts/`, imports it. */
const RUNNER_SPECIFIER = `./${basename(RUNNER_PATH_SUFFIX)}`

// ===========================================================================
// E3 region
// ===========================================================================

// ---------------------------------------------------------------------------
// The verb harness (E3 T3.S1), shared by every case of this region
// ---------------------------------------------------------------------------
//
// `verbHarness(options?)` builds one case's world and registers it for the
// file's `afterEach`, which removes its root and fails the case when the spawn
// recorder answered nothing for a spawn (`assertNoFailures`). Nothing in it is
// shared between cases.
//
// The world (fields of the harness):
// - `root`: the case's own `mkdtempSync` root. Under it: `tempDir`, the
//   constructed system temp directory (the reader's `TMPDIR`), `home` (its
//   `HOME`) and `worktreeRoot` (its worktree root; the `gh` lookups run there).
// - `env`: the reader's environment, `{ TMPDIR, HOME }` plus `options.env`
//   (credentials for redaction cases, built with `fakeToken`).
// - `clock`: a `createFakeClock`, started at `options.startMs`, by default
//   the RUN_ID's time (`runStartMs()`).
// - `processes`: E1's process table on that clock; the reader's `isPidAlive`
//   and `readProcCmdline` answer from it (b.uqm SR-6.3).
// - `spawns`: E1's spawn recorder on that table, answering `gh auth token`
//   only: the first lookup (its `GH_CONFIG_DIR` under `HOME`) with
//   `options.gh.first`, the plain one with `options.gh.plain`, each failing by
//   default (`GH_NO_TOKEN`); `ghTokenAnswer(token)` gives a token. Read the
//   spawns' environments from `spawns.spawns()`.
// - `signals`: E1's signal recorder on that table (the reader's `sendSignal`).
//
// Builders over that world:
// - `runDir(runId?)`: the run directory the reader derives (none created).
// - `buildRun(spec?)`: E1's `buildRunDirectory` in `tempDir`, RUN_ID by default.
// - `status(spec)`: E1's `makeStatus` with RUN_ID, the RUN_ID's time and
//   `STATUS_DEADLINE_MINUTES` by default; give `pid` and `phase`.
// - `addRunner(options?)`: a live `/ci` runner process with RUN_ID (or
//   `options.runId`) in the table; answers its PID. `{ alive: false }` gives a
//   gone one; other processes go in through `processes.add(otherProcess(…))`.
// - `markPlanted(...paths)`: files the case planted credential values in on
//   purpose (redaction cases); the leak check skips exactly these.
//
// Running a verb (never as a process, b.uqm SR-21.1):
// - `start(argv, options?)` calls `runVerdictReader(argv, deps)` at once, so
//   the first wait check and a stop's SIGTERM happen inside the call. It
//   answers a `StartedVerb`: `result` (a promise) and `settled()`. Move time
//   with `clock.advance(ms)` and change files or processes between steps.
// - `finish(started)` fires the clock's timers one at a time until the verb
//   settles, and answers its result; `run(argv, options?)` is `start` then
//   `finish`. Argument lists: `reportArgv`, `waitArgv`, `stopArgv`.
// - `options.deps` replaces members of the reader's dependencies (a failing
//   `removeRunDir`, a throwing `writeStdout`); the replacement is still
//   recorded. `options.signalFindsNoProcess` lists signals whose target PID
//   exits just before the signal is sent, so the recorder answers
//   `no-such-process` (a signal that finds no process, b.uqm SR-17.6).
//
// A `VerbResult` holds `exitCode`, `stdout` and `stderr` (one entry per line,
// its line feed removed; each write must be exactly one line), `calls` (every
// dependency call in order, `DepCall`, each with its fake-clock `atMs`; file
// reads keep only the read's kind and spawns only argv and cwd, so no planted
// value is recorded) and `callsTo(...deps)`. Before the result is answered,
// `assertNoLeak` checks the lines, the calls and every regular file under the
// root but the planted ones (`writtenFile`), so a leak fails the case.

/** The case's run: test data, a real UTC moment and 8 lowercase letters or digits. */
const RUN_ID = '20261008t120000z-verdict1'
/** Another run's RUN_ID, an hour earlier: test data. */
const OTHER_RUN_ID = '20261008t110000z-verdict2'
/** A status file's deadline minutes when a case gives none: test data, unlike `NO_STATUS_DEADLINE_MINUTES`. */
const STATUS_DEADLINE_MINUTES = 120

/** The RUN_ID's time, epoch milliseconds (the runner's rule). */
function runStartMs(runId: string = RUN_ID): number {
  const ms = runIdTimeMs(runId)
  if (ms === null) throw new Error(`verb harness: ${runId} is not a RUN_ID`)
  return ms
}

/** A `gh auth token` that gives no token. */
const GH_NO_TOKEN: SpawnAnswer = { exitCode: 1 }

/** A `gh auth token` that prints `token`. */
function ghTokenAnswer(token: string): SpawnAnswer {
  return { stdout: `${token}\n` }
}

/** `report <RUN_ID> <PID> <grace> [/ci arguments]`. */
function reportArgv(pid: number | string, grace: string = GRACE_NONE, ciArgs: readonly string[] = [], runId: string = RUN_ID): string[] {
  return ['report', runId, String(pid), grace, ...ciArgs]
}

/** `wait <RUN_ID> <PID>`. */
function waitArgv(pid: number | string, runId: string = RUN_ID): string[] {
  return ['wait', runId, String(pid)]
}

/** `stop <RUN_ID> <PID>`. */
function stopArgv(pid: number | string, runId: string = RUN_ID): string[] {
  return ['stop', runId, String(pid)]
}

/** The reader's dependency members the harness records. */
type DepName = 'readRunFile' | 'runPathKind' | 'removeRunDir' | 'spawn' | 'sendSignal' | 'isPidAlive' | 'readProcCmdline' | 'writeStdout' | 'writeStderr'

/** Every member that reads, writes, removes, spawns, signals or probes liveness: all but the two output streams. */
const READ_AND_ACT_DEPS: readonly DepName[] = ['readRunFile', 'runPathKind', 'removeRunDir', 'spawn', 'sendSignal', 'isPidAlive', 'readProcCmdline']

/** One dependency call, in call order, at its fake-clock time. */
type DepCall = { readonly atMs: number } & (
  | {
      readonly dep: 'readRunFile'
      readonly path: string
      /** The read's kind only, never its text. */
      readonly read: 'text' | 'missing' | 'unreadable'
    }
  | {
      readonly dep: 'runPathKind'
      readonly path: string
      readonly kind: reader.RunPathKind
    }
  | {
      readonly dep: 'removeRunDir'
      readonly path: string
      readonly ok: boolean
    }
  | {
      /** Argv and cwd only; the environment is in `spawns.spawns()`. */
      readonly dep: 'spawn'
      readonly argv: readonly string[]
      readonly cwd: string
    }
  | {
      readonly dep: 'sendSignal'
      readonly target: SignalTarget
      readonly signal: SentSignal
      readonly outcome: SignalOutcome
    }
  | {
      readonly dep: 'isPidAlive' | 'readProcCmdline'
      readonly pid: number
    }
  | {
      readonly dep: 'writeStdout' | 'writeStderr'
      readonly text: string
    }
)

/** A call as a recording wrapper gives it, before its time is added. */
type DepCallBody = DepCall extends infer Call ? (Call extends DepCall ? Omit<Call, 'atMs'> : never) : never

/** What a verb run gave. */
interface VerbResult {
  readonly exitCode: number
  /** Standard output, one entry per line, line feed removed. */
  readonly stdout: readonly string[]
  /** Standard error, one entry per line, line feed removed. */
  readonly stderr: readonly string[]
  /** Every dependency call, in order. */
  readonly calls: readonly DepCall[]
  /** The calls to the given members, in order. */
  callsTo(...deps: readonly DepName[]): readonly DepCall[]
}

/** A verb started and not yet driven to its end. */
interface StartedVerb {
  readonly result: Promise<VerbResult>
  settled(): boolean
}

interface VerbRunOptions {
  /** Members that replace the harness's own; still recorded. */
  readonly deps?: Partial<Omit<ReaderDeps, 'clock'>>
  /** Signals whose target PID exits just before they are sent, so they find no process. */
  readonly signalFindsNoProcess?: readonly SentSignal[]
}

interface VerbHarnessOptions {
  /** The fake clock's start; default the RUN_ID's time. */
  readonly startMs?: number
  /** Variables added to the reader's `{ TMPDIR, HOME }`. */
  readonly env?: Readonly<Record<string, string>>
  /** The `gh auth token` answers: the first lookup's and the plain one's; each fails by default. */
  readonly gh?: {
    readonly first?: SpawnAnswer
    readonly plain?: SpawnAnswer
  }
}

interface VerbHarness {
  readonly root: string
  readonly tempDir: string
  readonly home: string
  readonly worktreeRoot: string
  readonly env: Readonly<Record<string, string>>
  readonly clock: FakeClock
  readonly processes: FakeProcessTable
  readonly spawns: SpawnRecorder
  readonly signals: SignalRecorder
  runDir(runId?: string): string
  buildRun(spec?: Omit<RunDirectorySpec, 'runId'> & { readonly runId?: string }): string
  status(spec: Pick<StatusSpec, 'pid' | 'phase'> & Partial<StatusSpec>): RunStatus
  addRunner(options?: FakeProcessOptions & { readonly runId?: string }): number
  markPlanted(...paths: readonly string[]): void
  start(argv: readonly string[], options?: VerbRunOptions): StartedVerb
  finish(started: StartedVerb): Promise<VerbResult>
  run(argv: readonly string[], options?: VerbRunOptions): Promise<VerbResult>
}

/** Every harness built by the running case, for `afterEach`. */
const harnesses: VerbHarness[] = []

/** The most timers `finish` fires for one verb: well past the wait verb's 90 checks and the stop verb's 30. */
const FINISH_TIMER_LIMIT = 1_000

/** Every regular file under `dir`, never through a symbolic link. */
function regularFilesUnder(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = lstatSync(path)
    if (st.isDirectory()) files.push(...regularFilesUnder(path))
    else if (st.isFile()) files.push(path)
  }
  return files
}

/** One standard-stream write as its line: each write must be exactly one line ending in a line feed. */
function writtenLine(text: string, stream: string): string {
  if (!/^[^\n]*\n$/.test(text)) throw new Error(`verb harness: a ${stream} write is not one line ending in a line feed: ${JSON.stringify(text)}`)
  return text.slice(0, -1)
}

/** Builds one case's verb harness (see the API above). */
function verbHarness(options: VerbHarnessOptions = {}): VerbHarness {
  const root = mkdtempSync(join(tmpdir(), 'ci-verdict-'))
  const tempDir = join(root, 'tmp')
  const home = join(root, 'home')
  const worktreeRoot = join(root, 'worktree')
  for (const dir of [tempDir, home, worktreeRoot]) mkdirSync(dir)
  const env: Readonly<Record<string, string>> = { TMPDIR: tempDir, HOME: home, ...options.env }
  const clock = createFakeClock({ start: options.startMs ?? runStartMs() })
  const processes = createProcessTable({ clock })
  const spawns = createSpawnRecorder({ clock, processes, root })
  const signals = createSignalRecorder({ processes, clock })
  const ghFirst = options.gh?.first ?? GH_NO_TOKEN
  const ghPlain = options.gh?.plain ?? GH_NO_TOKEN
  spawns.answer([...GH_AUTH_TOKEN_ARGV], (request) => (request.env.GH_CONFIG_DIR === ghPersonalConfigDir(request.env) ? ghFirst : ghPlain))
  const planted = new Set<string>()

  function start(argv: readonly string[], runOptions: VerbRunOptions = {}): StartedVerb {
    const calls: DepCall[] = []
    const stdoutWrites: string[] = []
    const stderrWrites: string[] = []
    const record = (call: DepCallBody): void => {
      calls.push({ ...call, atMs: clock.now() } as DepCall)
    }
    const liveness = processes.deps()
    const base: Omit<ReaderDeps, 'clock'> = {
      spawn: spawns.spawn,
      env,
      worktreeRoot,
      sendSignal: signals.sendSignal,
      isPidAlive: liveness.isPidAlive,
      readProcCmdline: liveness.readProcCmdline,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      ...createRealRunFileDeps(),
    }
    const inner = { ...base, ...runOptions.deps }
    const findsNoProcess = runOptions.signalFindsNoProcess ?? []
    const deps: ReaderDeps = {
      env: inner.env,
      worktreeRoot: inner.worktreeRoot,
      clock,
      readRunFile: (path) => {
        const read = inner.readRunFile(path)
        record({ dep: 'readRunFile', path, read: read.kind })
        return read
      },
      runPathKind: (path) => {
        const kind = inner.runPathKind(path)
        record({ dep: 'runPathKind', path, kind })
        return kind
      },
      removeRunDir: (path) => {
        const removed = inner.removeRunDir(path)
        record({ dep: 'removeRunDir', path, ok: removed.ok })
        return removed
      },
      spawn: (request) => {
        record({ dep: 'spawn', argv: [...request.argv], cwd: request.cwd })
        return inner.spawn(request)
      },
      sendSignal: (target, signal) => {
        if (target.kind === 'pid' && findsNoProcess.includes(signal)) processes.makeGone(target.pid)
        const outcome = inner.sendSignal(target, signal)
        record({ dep: 'sendSignal', target: { ...target }, signal, outcome })
        return outcome
      },
      isPidAlive: (pid) => {
        record({ dep: 'isPidAlive', pid })
        return inner.isPidAlive(pid)
      },
      readProcCmdline: (pid) => {
        record({ dep: 'readProcCmdline', pid })
        return inner.readProcCmdline(pid)
      },
      writeStdout: (text) => {
        record({ dep: 'writeStdout', text })
        inner.writeStdout(text)
        stdoutWrites.push(text)
      },
      writeStderr: (text) => {
        record({ dep: 'writeStderr', text })
        inner.writeStderr(text)
        stderrWrites.push(text)
      },
    }
    let done = false
    const result = runVerdictReader(argv, deps).then((exitCode): VerbResult => {
      done = true
      const verbResult: VerbResult = {
        exitCode,
        stdout: stdoutWrites.map((text) => writtenLine(text, 'standard-output')),
        stderr: stderrWrites.map((text) => writtenLine(text, 'standard-error')),
        calls: [...calls],
        callsTo: (...names) => calls.filter((call) => names.includes(call.dep)),
      }
      const files = regularFilesUnder(root).filter((path) => !planted.has(path))
      assertNoLeak({ stdout: verbResult.stdout, stderr: verbResult.stderr, calls: verbResult.calls, files: files.map(writtenFile) })
      return verbResult
    })
    return { result, settled: () => done }
  }

  async function finish(started: StartedVerb): Promise<VerbResult> {
    for (let fired = 0; ; fired += 1) {
      await clock.flush()
      if (started.settled()) return started.result
      if (clock.pendingCount() === 0) throw new Error('verb harness: the verb has not settled and no timer is pending')
      if (fired >= FINISH_TIMER_LIMIT) throw new Error(`verb harness: the verb has not settled after ${FINISH_TIMER_LIMIT} timers`)
      await clock.runNext()
    }
  }

  const harness: VerbHarness = {
    root,
    tempDir,
    home,
    worktreeRoot,
    env,
    clock,
    processes,
    spawns,
    signals,
    runDir: (runId = RUN_ID) => runDirIn(tempDir, runId),
    buildRun: (spec = {}) => buildRunDirectory(tempDir, { runId: RUN_ID, ...spec }),
    status: (spec) => makeStatus({ runId: RUN_ID, startMs: runStartMs(spec.runId ?? RUN_ID), deadlineMinutes: STATUS_DEADLINE_MINUTES, ...spec }),
    addRunner: ({ runId = RUN_ID, ...processOptions } = {}) => processes.add(ciRunnerProcess(runId, { worktreeRoot, ...processOptions })),
    markPlanted: (...paths) => {
      for (const path of paths) planted.add(path)
    },
    start,
    finish,
    run: (argv, runOptions) => finish(start(argv, runOptions)),
  }
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  const built = harnesses.splice(0)
  try {
    for (const h of built) h.spawns.assertNoFailures()
  } finally {
    for (const h of built) rmSync(h.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Module properties (b.uqm SR-1.3, the reader's half)
// ---------------------------------------------------------------------------

/** One top-level expression that would run at import: a call, a `new` or an `await`. */
interface TopLevelFinding {
  readonly kind: 'call' | 'new' | 'await'
  readonly text: string
}

/** Whether a top-level statement is the main-module entry block, `if (import.meta.main) { … }` with no `else`. */
function isEntryBlock(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement !== undefined) return false
  const condition = statement.expression
  return (
    ts.isPropertyAccessExpression(condition) &&
    ts.isMetaProperty(condition.expression) &&
    condition.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    condition.name.text === 'main'
  )
}

function isStaticMember(member: ts.ClassElement): boolean {
  return ts.canHaveModifiers(member) && (ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
}

function parsedSource(source: string): ts.SourceFile {
  return ts.createSourceFile('ci-verdict.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/**
 * Every call, `new` and `await` at the top level of `source`, outside
 * function bodies, class bodies (static initializers and static blocks
 * audited, since they run at import) and the main-module entry block, with
 * the count of entry blocks and whether one is last.
 */
function auditTopLevel(source: string): { findings: TopLevelFinding[]; entryBlocks: number; entryBlockLast: boolean } {
  const file = parsedSource(source)
  const findings: TopLevelFinding[] = []
  const flag = (kind: TopLevelFinding['kind'], node: ts.Node): void => {
    findings.push({ kind, text: node.getText(file).replace(/\s+/g, ' ').slice(0, 80) })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return
    if (ts.isClassLike(node)) {
      for (const clause of node.heritageClauses ?? []) visit(clause)
      for (const member of node.members) {
        if (ts.isClassStaticBlockDeclaration(member)) ts.forEachChild(member.body, visit)
        else if (ts.isPropertyDeclaration(member) && isStaticMember(member) && member.initializer !== undefined) visit(member.initializer)
      }
      return
    }
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) flag('call', node)
    else if (ts.isNewExpression(node)) flag('new', node)
    else if (ts.isAwaitExpression(node)) flag('await', node)
    ts.forEachChild(node, visit)
  }
  let entryBlocks = 0
  for (const statement of file.statements) {
    if (isEntryBlock(statement)) entryBlocks += 1
    else visit(statement)
  }
  const last = file.statements.at(-1)
  return { findings, entryBlocks, entryBlockLast: last !== undefined && isEntryBlock(last) }
}

/** `source` with `statement` added as a top-level statement just before its entry block. */
function plantedBeforeEntryBlock(source: string, statement: string): string {
  const at = source.lastIndexOf('if (import.meta.main)')
  if (at < 0) throw new Error('the reader has no entry block to plant before')
  return `${source.slice(0, at)}${statement}\n${source.slice(at)}`
}

/** The process-level listeners a fresh import must not add (docs/testing-guide.md, Process-Level Listeners). */
const PROCESS_EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection'] as const

function listenerCounts(): Record<string, number> {
  return Object.fromEntries(PROCESS_EVENTS.map((event) => [event, process.listenerCount(event)]))
}

/**
 * The rules the reader shares with the runner (b.uqm SR-1.3), each by the
 * runner exports that hold it. The reader must import each from the runner
 * and use it. Fault normalization is `parseCiArguments`'s (the invocation's
 * `faults`), shown in a verdict through `injectedVerdictPrefix`.
 */
const SHARED_RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['argument parsing and the run kind', ['parseCiArguments', 'isSelectiveRun', 'isInjectedRun']],
  ['script-name forms', ['classifyScriptName', 'numberFormOf', 'isNumberForm']],
  ['fault normalization', ['injectedVerdictPrefix']],
  ['canonical order', ['compareCanonical']],
  ['the RUN_ID shape and its time', ['isRunId', 'runIdTimeMs']],
  ['the run-directory path', ['runDirPath']],
  ['the status file parser', ['parseStatus']],
  ['the liveness rule', ['isOwnerAlive']],
]

/** The runner's own rule texts, which a copy of a shared rule would hold. */
function runnerRuleTexts(): ReadonlyArray<readonly [string, string]> {
  return [
    ['the RUN_ID pattern', RUN_ID_PATTERN.source],
    ['the number-form pattern', NUMBER_FORM_PATTERN.source],
    ['the script file-name pattern', SCRIPT_FILE_NAME_PATTERN.source],
    ['the run-directory prefix', RUN_DIR_PREFIX],
    ['the runner path', RUNNER_PATH_SUFFIX],
  ]
}

/** The names the top level of `source` declares: functions, classes and variables. */
function topLevelValueNames(source: string): string[] {
  const names: string[] = []
  for (const statement of parsedSource(source).statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) names.push(statement.name.text)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
      }
    }
  }
  return names
}

/** Whether `name` is used in `code` outside its import statements: called, or passed on as a function. */
function usedOutsideImports(code: string, name: string): boolean {
  const body = maskLiterals(code.replace(/^import\b[^;]*?\bfrom\s*(['"])[^'"]+\1/gm, ''))
  return new RegExp(`(?<![\\w.$])${name}(?![\\w$])`).test(body)
}

/**
 * Where `source` breaks b.uqm SR-1.3's one-definition rule: a shared rule not
 * imported from the runner or never used, a top-level name that is one of
 * the runner's exports, or a copy of one of the runner's rule texts.
 */
function sharedRuleFindings(source: string): string[] {
  const code = stripComments(source)
  const findings: string[] = []
  for (const [rule, names] of SHARED_RULES) {
    for (const name of names) {
      if (typeof (runner as Record<string, unknown>)[name] !== 'function') findings.push(`${rule}: ${name} is not a runner function`)
      if (importSource(code, name) !== RUNNER_SPECIFIER) findings.push(`${rule}: ${name} is not imported from the runner`)
      if (!usedOutsideImports(code, name)) findings.push(`${rule}: ${name} is never used`)
    }
  }
  const runnerExports = new Set(Object.keys(runner))
  for (const name of topLevelValueNames(source)) {
    if (runnerExports.has(name)) findings.push(`${name}: the reader defines a runner export of its own`)
  }
  for (const [label, text] of runnerRuleTexts()) {
    if (code.includes(text)) findings.push(`the reader holds its own copy of ${label}`)
  }
  return findings
}

describe('module properties (b.uqm SR-1.3)', () => {
  test('the reader has no top-level call, new or await outside function and class bodies and its one entry block, which is last', () => {
    expect(auditTopLevel(readerSource())).toEqual({ findings: [], entryBlocks: 1, entryBlockLast: true })
  })

  test.each([
    ['a call', 'setUp()', 'call'],
    ['a new', "new Worker('w.ts')", 'new'],
    ['an await', 'await ready', 'await'],
  ] as const)('the audit flags %s planted at the reader top level', (_label, statement, kind) => {
    expect(auditTopLevel(plantedBeforeEntryBlock(readerSource(), statement)).findings.map((finding) => finding.kind)).toEqual([kind])
  })

  test('a fresh import adds no SIGINT, SIGTERM, SIGHUP, uncaughtException or unhandledRejection listener', async () => {
    const before = listenerCounts()

    await import(`../scripts/ci-verdict.ts?fresh=${crypto.randomUUID()}`)

    expect(listenerCounts()).toEqual(before)
  })

  test('the runtime loads are only node: built-ins, bun, bun:ffi and the runner', () => {
    const specifiers = runtimeSpecifiers(stripComments(readerSource()))
    const allowed = (specifier: string): boolean =>
      specifier.startsWith('node:') || specifier === 'bun' || specifier === 'bun:ffi' || specifier === RUNNER_SPECIFIER

    expect(specifiers).toContain(RUNNER_SPECIFIER)
    expect(specifiers.filter((specifier) => !allowed(specifier))).toEqual([])
  })

  test('the reader imports every shared rule from the runner, calls it, and defines none of its own', () => {
    expect(sharedRuleFindings(readerSource())).toEqual([])
  })

  test.each([
    ['its own RUN_ID test', (source: string) => plantedBeforeEntryBlock(source, 'function isRunId(value: string): boolean { return value.length > 0 }'), 'isRunId: the reader defines a runner export of its own'],
    ['a copy of the RUN_ID pattern', (source: string) => plantedBeforeEntryBlock(source, `const OWN_RUN_ID = /${RUN_ID_PATTERN.source}/`), 'the reader holds its own copy of the RUN_ID pattern'],
    [
      'the status parser from elsewhere',
      (source: string) => source.replace(/^ {2}parseStatus,\n/m, '').replace(/^import \{ lstatSync/m, "import { parseStatus } from './status.ts'\nimport { lstatSync"),
      'the status file parser: parseStatus is not imported from the runner',
    ],
  ] as const)('the shared-rule audit flags %s', (_label, plant, finding) => {
    const planted = plant(readerSource())

    expect(planted).not.toBe(readerSource())
    expect(sharedRuleFindings(planted)).toContain(finding)
  })
})

// ---------------------------------------------------------------------------
// Constants (b.uqm SR-21.5): one pin case per reader constant
// ---------------------------------------------------------------------------
//
// The only place the reader constants of SR-21.5 are typed, each beside the
// imported constant, as the PRD and SRD give them: times in milliseconds, the
// two `verdict reader failed:` texts as b.uqm SR-18.2 writes them. The
// runner's exit 64 is pinned by E1, and the report exit codes by the outcome
// block's row-example table.

const READER_CONSTANT_PINS: ReadonlyArray<readonly [string, unknown, unknown]> = [
  ['RUNNER_LOG_TAIL_LINES', RUNNER_LOG_TAIL_LINES, 40],
  ['WAIT_BOUND_MS', WAIT_BOUND_MS, 90_000],
  ['WAIT_CHECK_INTERVAL_MS', WAIT_CHECK_INTERVAL_MS, 1_000],
  ['GRACE_MINUTES', GRACE_MINUTES, 10],
  ['NO_STATUS_DEADLINE_MINUTES', NO_STATUS_DEADLINE_MINUTES, 90],
  ['STOP_KILL_AFTER_MS', STOP_KILL_AFTER_MS, 30_000],
  ['STOP_CHECK_INTERVAL_MS', STOP_CHECK_INTERVAL_MS, 1_000],
  ['WAIT_EXIT_RUNNING', WAIT_EXIT_RUNNING, 0],
  ['WAIT_EXIT_VERDICT', WAIT_EXIT_VERDICT, 10],
  ['WAIT_EXIT_REFUSED', WAIT_EXIT_REFUSED, 11],
  ['WAIT_EXIT_GONE', WAIT_EXIT_GONE, 12],
  ['WAIT_EXIT_GRACE', WAIT_EXIT_GRACE, 13],
  ['STOP_EXIT_NOT_ALIVE', STOP_EXIT_NOT_ALIVE, 0],
  ['STOP_EXIT_SENT_SIGTERM', STOP_EXIT_SENT_SIGTERM, 20],
  ['STOP_EXIT_SENT_SIGKILL', STOP_EXIT_SENT_SIGKILL, 21],
  ['UNKNOWN_WAIT_EXIT_LIMIT', UNKNOWN_WAIT_EXIT_LIMIT, 3],
  ['STOP_CALL_LIMIT', STOP_CALL_LIMIT, 3],
  ['LEAST_PID_AND_GRACE_MINUTES', LEAST_PID_AND_GRACE_MINUTES, 1],
  [
    'WAIT_READER_FAILED_TEXT',
    WAIT_READER_FAILED_TEXT,
    'verdict reader failed: wait exited <code> 3 times in a row; runner <PID> may still be running; finish the run as "Finishing a run by hand" says',
  ],
  [
    'STOP_READER_FAILED_TEXT',
    STOP_READER_FAILED_TEXT,
    'verdict reader failed: stop exited <code> 3 times in a row; runner <PID> may still be running; finish the run as "Finishing a run by hand" says',
  ],
]

describe('constants (b.uqm SR-21.5)', () => {
  test.each(READER_CONSTANT_PINS)('%s', (name, actual, typed) => {
    expect((reader as Record<string, unknown>)[name]).toBe(actual)
    expect(actual).toEqual(typed)
  })
})

// --- E3 T3.S2 (.gg): arguments, exit 64 and PID resolution ---
//
// b.uqm SR-17.1's three rules, owned here once: the command lines, the
// malformed-argument rule (exit 64, one naming `usage:` line, nothing else
// done) and the PID rule (the status file's `pid`, else a numeric `<PID>`,
// else none). Later blocks use one alive and one gone runner only; the
// liveness variants are the stop block's.

/** `/ci` arguments the runner's rules refuse (an unknown option): test data. */
const REFUSED_CI_ARGS: readonly string[] = ['--bogus']

/** The status file's phase when a case needs one and its phase does not matter. */
const ANY_PHASE = 'shards'

/** A RUN_ID the runner refuses: the case's RUN_ID in capitals (the RUN_ID rule itself is E1's). */
function refusedRunId(): string {
  const runId = RUN_ID.toUpperCase()
  if (runner.isRunId(runId)) throw new Error(`${runId} is a RUN_ID`)
  return runId
}

/** The whole number just below the least `<PID>` and m of `<grace>`. */
function belowLeast(): string {
  return String(LEAST_PID_AND_GRACE_MINUTES - 1)
}

/** One malformed command line, given the PID of a live runner of the case's run. */
interface MalformedRow {
  readonly label: string
  readonly argv: (pid: string) => readonly string[]
  /** The problem its usage line names. */
  readonly problem: (pid: string) => reader.UsageProblem
  /** The text that names the argument in that line. */
  readonly names: (pid: string) => string
}

const MALFORMED_ROWS: readonly MalformedRow[] = [
  { label: 'no verb', argv: () => [], problem: () => ({ kind: 'missing', what: 'verb' }), names: () => 'the verb' },
  { label: 'an unknown verb', argv: (pid) => ['status', RUN_ID, pid], problem: () => ({ kind: 'bad-verb', arg: 'status' }), names: () => 'status' },
  { label: 'report with no <RUN_ID>', argv: () => ['report'], problem: () => ({ kind: 'missing', what: 'RUN_ID' }), names: () => '<RUN_ID>' },
  { label: 'report with no <PID>', argv: () => ['report', RUN_ID], problem: () => ({ kind: 'missing', what: 'PID' }), names: () => '<PID>' },
  { label: 'report with no <grace>', argv: (pid) => ['report', RUN_ID, pid], problem: () => ({ kind: 'missing', what: 'grace' }), names: () => '<grace>' },
  { label: 'wait with no <RUN_ID>', argv: () => ['wait'], problem: () => ({ kind: 'missing', what: 'RUN_ID' }), names: () => '<RUN_ID>' },
  { label: 'wait with no <PID>', argv: () => ['wait', RUN_ID], problem: () => ({ kind: 'missing', what: 'PID' }), names: () => '<PID>' },
  { label: 'stop with no <RUN_ID>', argv: () => ['stop'], problem: () => ({ kind: 'missing', what: 'RUN_ID' }), names: () => '<RUN_ID>' },
  { label: 'stop with no <PID>', argv: () => ['stop', RUN_ID], problem: () => ({ kind: 'missing', what: 'PID' }), names: () => '<PID>' },
  { label: 'a RUN_ID the runner refuses', argv: (pid) => waitArgv(pid, refusedRunId()), problem: () => ({ kind: 'bad-run-id', arg: refusedRunId() }), names: () => refusedRunId() },
  {
    label: `<PID> ${belowLeast()}, below the least`,
    argv: () => stopArgv(belowLeast()),
    problem: () => ({ kind: 'bad-pid', arg: belowLeast() }),
    names: () => `<PID> ${belowLeast()}`,
  },
  { label: '<PID> with a leading zero', argv: (pid) => waitArgv(`0${pid}`), problem: (pid) => ({ kind: 'bad-pid', arg: `0${pid}` }), names: (pid) => `0${pid}` },
  { label: '<PID> with a sign', argv: (pid) => reportArgv(`+${pid}`), problem: (pid) => ({ kind: 'bad-pid', arg: `+${pid}` }), names: (pid) => `+${pid}` },
  { label: '<PID> not a number', argv: () => stopArgv(GRACE_NONE), problem: () => ({ kind: 'bad-pid', arg: GRACE_NONE }), names: () => `<PID> ${GRACE_NONE}` },
  ...(
    [
      [`<grace> term:${belowLeast()}, m below the least`, () => `${reader.GRACE_TERM_PREFIX}${belowLeast()}`],
      ['<grace> kill: with no number', () => reader.GRACE_KILL_PREFIX],
      ['<grace> with a leading zero in m', () => `${reader.GRACE_TERM_PREFIX}05`],
      ['<grace> an unknown word', () => 'later'],
    ] as const
  ).map(
    ([label, grace]): MalformedRow => ({
      label,
      argv: (pid) => reportArgv(pid, grace()),
      problem: () => ({ kind: 'bad-grace', arg: grace() }),
      names: () => `<grace> ${grace()}`,
    }),
  ),
  { label: 'an extra argument to wait', argv: (pid) => [...waitArgv(pid), 'extra'], problem: () => ({ kind: 'extra', verb: 'wait', arg: 'extra' }), names: () => 'extra' },
  { label: 'an extra argument to stop', argv: (pid) => [...stopArgv(pid), 'extra'], problem: () => ({ kind: 'extra', verb: 'stop', arg: 'extra' }), names: () => 'extra' },
]

/** What a PID-resolution case planted: the `<PID>` to give, and the `pid=` and `runner=` fields wait's line must show. */
interface PidCase {
  readonly argument: string
  readonly pid: string
  readonly runner: 'alive' | 'gone'
}

/** Plants the case's run directory with a verdict, so wait returns at its first check, and the status file when given. */
function plantVerdictRun(h: VerbHarness, status?: RunDirectorySpec['status']): void {
  h.buildRun({ status, verdict: runner.PASS_VERDICT })
}

/** The `key=value` fields of wait's line. */
function waitLineFields(line: string): Record<string, string> {
  return Object.fromEntries(
    line
      .split(' ')
      .filter((token) => token.includes('='))
      .map((token) => [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]),
  )
}

const PID_ROWS: ReadonlyArray<{ readonly label: string; readonly plant: (h: VerbHarness) => PidCase }> = [
  {
    label: "the status file's pid wins over a different numeric <PID>",
    plant: (h) => {
      const pid = h.addRunner()
      plantVerdictRun(h, h.status({ pid, phase: ANY_PHASE }))
      return { argument: String(h.processes.allocatePid()), pid: String(pid), runner: 'alive' }
    },
  },
  {
    label: 'a missing status file falls back to a numeric <PID>',
    plant: (h) => {
      const pid = h.addRunner()
      plantVerdictRun(h)
      return { argument: String(pid), pid: String(pid), runner: 'alive' }
    },
  },
  {
    label: 'an unparseable status file falls back to a numeric <PID>',
    plant: (h) => {
      const pid = h.addRunner()
      plantVerdictRun(h, { status: h.status({ pid: h.processes.allocatePid(), phase: ANY_PHASE }), change: { kind: 'unparseable' } })
      return { argument: String(pid), pid: String(pid), runner: 'alive' }
    },
  },
  {
    label: '- with no readable status file is no PID: pid=- runner=gone',
    plant: (h) => {
      h.addRunner()
      plantVerdictRun(h)
      return { argument: reader.PID_ARGUMENT_NONE, pid: reader.PID_ARGUMENT_NONE, runner: 'gone' }
    },
  },
  {
    label: 'a <PID> of the largest safe integer is that PID',
    plant: (h) => {
      plantVerdictRun(h)
      return { argument: String(Number.MAX_SAFE_INTEGER), pid: String(Number.MAX_SAFE_INTEGER), runner: 'gone' }
    },
  },
  {
    label: 'a <PID> too large to be a safe integer is no PID',
    plant: (h) => {
      plantVerdictRun(h)
      return { argument: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(), pid: reader.PID_ARGUMENT_NONE, runner: 'gone' }
    },
  },
]

describe('arguments, exit 64 and PID resolution (b.uqm SR-17.1)', () => {
  test.each([...MALFORMED_ROWS])('$label: exit 64, one usage line naming it, nothing read, written, removed or signalled', async (row) => {
    const h = verbHarness()
    const pid = String(h.addRunner())
    plantVerdictRun(h, h.status({ pid: Number(pid), phase: ANY_PHASE }))
    const before = treeSnapshot(h.root, { extended: true })

    const result = await h.run(row.argv(pid))

    expect(result.exitCode).toBe(runner.USAGE_EXIT_STATUS)
    expect(result.stderr).toEqual([reader.readerUsageLine(row.problem(pid))])
    expect(result.stderr[0]?.startsWith(runner.USAGE_PREFIX)).toBe(true)
    expect(result.stderr[0]).toContain(row.names(pid))
    expect(result.stdout).toEqual([])
    expect(result.callsTo(...READ_AND_ACT_DEPS)).toEqual([])
    expect(treeSnapshot(h.root, { extended: true })).toEqual(before)
  })

  test('report with /ci arguments the runner refuses does not exit 64', async () => {
    const h = verbHarness()
    plantVerdictRun(h)

    const result = await h.run(reportArgv(reader.PID_ARGUMENT_NONE, GRACE_NONE, refusedArgs(REFUSED_CI_ARGS)))

    expect(result.exitCode).not.toBe(runner.USAGE_EXIT_STATUS)
    expect(result.stderr).toEqual([])
    expect(result.stdout).not.toEqual([])
  })

  test.each([...PID_ROWS])("the runner's PID: $label", async (row) => {
    const h = verbHarness()
    const planted = row.plant(h)

    const result = await h.run(waitArgv(planted.argument))

    expect(result.stdout).toHaveLength(1)
    const fields = waitLineFields(result.stdout[0] ?? '')
    expect({ pid: fields.pid, runner: fields.runner }).toEqual({ pid: planted.pid, runner: planted.runner })
  })
})

// --- E3 T3.S3 (.gu): valid first lines ---
//
// b.uqm SR-17.2: a first line is valid only when its shape matches the
// invocation (PRD AC 72, and AC 73's shape half). Each row runs `report` with
// grace `none`, `<PID>` `-` and no status file, so no refusal, and asserts
// validity only: an invalid line gives the runner-died outcome, a valid one
// does not (each row's full text is the outcome block's). Script names come
// from the repository's listing by number; lists are built with the runner's
// `sortCanonical`, faults with its `parseFault` and `normalizeFaults`.

/** The selected scripts' numbers: test-0 sorts after test-4 in canonical order, so ascending number order differs from it. */
const SELECTED_NUMBERS = [5, 0] as const
/** A prerequisite a selective run may add. */
const PREREQUISITE_NUMBER = 2
/** test-1, which every selective list holds. */
const EVERY_SHARD_NUMBER = 1

function selectedNumberForms(): string[] {
  return SELECTED_NUMBERS.map((n) => runner.numberFormOf(n))
}

function selectedFileNames(): string[] {
  return SELECTED_NUMBERS.map((n) => realScriptFileName(n))
}

/** test-1, the selected scripts and `extra` number forms, in canonical order. */
function canonicalList(extra: readonly string[] = []): string[] {
  return runner.sortCanonical([runner.numberFormOf(EVERY_SHARD_NUMBER), ...selectedNumberForms(), ...extra])
}

/** A list the valid one is not: throws when `list` equals the canonical list, so an invalid row stays what it claims. */
function offList(list: readonly string[]): string[] {
  if (list.join() === canonicalList().join()) throw new Error(`${list.join(' ')} is the canonical list`)
  return [...list]
}

/** `SELECTIVE (<list>): <inner>`, the list joined by `separator`. */
function selectiveLine(list: readonly string[], inner: string, separator: string = reader.SCRIPT_LIST_SEPARATOR): string {
  return `${reader.SELECTIVE_VERDICT_OPEN}${list.join(separator)}${reader.VERDICT_WRAPPER_CLOSE}${inner}`
}

/** A FAIL line: the runner's prefix, then test data. */
function failLine(): string {
  return `${runner.FAIL_PREFIX}${runner.numberFormOf(SELECTED_NUMBERS[0])}`
}

/** The `--inject` values in argument order: a script fault by file name, another fault, then the first again by number form. */
function injectValues(): string[] {
  const script = SELECTED_NUMBERS[0]
  return [`fail:${realScriptFileName(script)}`, 'kill:2', `fail:${runner.numberFormOf(script)}`]
}

function injectArgs(): string[] {
  return injectValues().flatMap((value) => ['--inject', value])
}

/** The `--inject` values parsed as given, before de-duplication. */
function givenFaults(): runner.GivenFault[] {
  return injectValues().map((value, index) => {
    const parsed = runner.parseFault(value)
    if (!parsed.ok) throw new Error(`${value} is not a fault: ${parsed.reason}`)
    return { position: 2 * index + 1, value, fault: parsed.fault }
  })
}

/** The faults as the wrapper must show them: normalized, in the given order, a repeated one once. Throws unless one was dropped, so the rows show de-duplication. */
function normalizedFaults(): runner.Fault[] {
  const given = givenFaults()
  const faults = [...runner.normalizeFaults(given).faults]
  if (faults.length !== given.length - 1) throw new Error('the --inject values hold no repeated fault')
  return faults
}

/** `INJECTED (<faults>): <inner>`. */
function injectedLine(faults: readonly runner.Fault[], inner: string): string {
  return `${runner.injectedVerdictPrefix(faults)}${inner}`
}

/** A script number in ascending number order, for a list that is not canonical. */
function byNumber(a: string, b: string): number {
  return (runner.scriptNameNumber(a) ?? 0) - (runner.scriptNameNumber(b) ?? 0)
}

/** `/ci` arguments the runner parses, with a SCRIPT that is neither a number form nor a file name (test data); throws when they are not that. */
function neitherScriptArgs(): string[] {
  const args = ['bogus']
  if (!runner.parseCiArguments(args).ok || args.some((arg) => runner.classifyScriptName(arg).kind !== 'neither')) throw new Error(`${args.join(' ')} are not that`)
  return args
}

/** `/ci` arguments the runner's rules refuse; throws when they parse. */
function refusedArgs(args: readonly string[]): readonly string[] {
  if (runner.parseCiArguments(args).ok) throw new Error(`the runner does not refuse ${args.join(' ')}`)
  return args
}

interface FirstLineRow {
  readonly label: string
  readonly ciArgs: () => readonly string[]
  readonly verdict: () => NonNullable<RunDirectorySpec['verdict']>
  readonly valid: boolean
}

/** A group's rows, each labelled with its group and its validity. */
function firstLineRows(group: string, ciArgs: () => readonly string[], rows: ReadonlyArray<readonly [boolean, string, () => NonNullable<RunDirectorySpec['verdict']>]>): FirstLineRow[] {
  return rows.map(([valid, label, verdict]) => ({ label: `${group}: ${valid ? 'valid' : 'invalid'}: ${label}`, ciArgs, verdict, valid }))
}

/** Exactly `PASS`. */
function passLine(): string {
  return runner.PASS_VERDICT
}

const FIRST_LINE_ROWS: readonly FirstLineRow[] = [
  ...firstLineRows('full, no injection', () => [], [
    [true, 'exactly PASS', passLine],
    [true, 'a line beginning FAIL: ', failLine],
    [false, 'a SELECTIVE (…) line', () => selectiveLine(canonicalList(), runner.PASS_VERDICT)],
    [false, 'an INJECTED (…) line', () => injectedLine(normalizedFaults(), runner.PASS_VERDICT)],
    [false, 'an empty first line, PASS on the second', () => ({ line: '', change: { kind: 'second-line', line: runner.PASS_VERDICT } })],
    [false, 'PASS in another case', () => runner.PASS_VERDICT.toLowerCase()],
    [false, 'PASS with a trailing space', () => `${runner.PASS_VERDICT} `],
    [false, 'PASS with trailing text', () => `${runner.PASS_VERDICT}: all`],
  ]),
  ...firstLineRows('selection, no injection', selectedNumberForms, [
    [true, 'test-1 and every selected script in canonical order', () => selectiveLine(canonicalList(), runner.PASS_VERDICT)],
    [true, 'the same with an added prerequisite', () => selectiveLine(canonicalList([runner.numberFormOf(PREREQUISITE_NUMBER)]), failLine())],
    [false, 'exactly PASS (AC 72)', passLine],
    [false, 'a list missing test-1', () => selectiveLine(offList(canonicalList().filter((entry) => entry !== runner.numberFormOf(EVERY_SHARD_NUMBER))), runner.PASS_VERDICT)],
    [false, 'a list missing a selected script', () => selectiveLine(offList(canonicalList().filter((entry) => entry !== runner.numberFormOf(SELECTED_NUMBERS[1]))), runner.PASS_VERDICT)],
    [false, 'a list in ascending number order, not canonical order', () => selectiveLine(offList([...canonicalList()].sort(byNumber)), runner.PASS_VERDICT)],
    [false, 'an entry repeated', () => selectiveLine(offList([...canonicalList(), ...canonicalList().slice(-1)]), runner.PASS_VERDICT)],
    [false, 'an entry that is a file name, not a number form', () => selectiveLine(offList(canonicalList().map((entry) => (entry === runner.numberFormOf(SELECTED_NUMBERS[0]) ? realScriptFileName(SELECTED_NUMBERS[0]) : entry))), runner.PASS_VERDICT)],
    [false, 'doubled spaces', () => selectiveLine(canonicalList(), runner.PASS_VERDICT, reader.SCRIPT_LIST_SEPARATOR.repeat(2))],
  ]),
  ...firstLineRows('selection given as file names, no injection', selectedFileNames, [[true, 'the canonical list of number forms', () => selectiveLine(canonicalList(), runner.PASS_VERDICT)]]),
  ...firstLineRows('selection with a script named twice, no injection', () => [...selectedNumberForms(), ...selectedFileNames().slice(0, 1)], [
    [true, 'each entry once', () => selectiveLine(canonicalList(), runner.PASS_VERDICT)],
  ]),
  ...firstLineRows('full, injection', injectArgs, [
    [true, 'INJECTED (<normalized faults>): wrapping a valid full line', () => injectedLine(normalizedFaults(), runner.PASS_VERDICT)],
    [false, 'exactly PASS (AC 72)', passLine],
    [false, 'other faults', () => injectedLine([{ kind: 'retag' }], runner.PASS_VERDICT)],
    [false, 'the same faults in another order', () => injectedLine([...normalizedFaults()].reverse(), runner.PASS_VERDICT)],
    [false, 'a missing fault', () => injectedLine(normalizedFaults().slice(1), runner.PASS_VERDICT)],
    [false, 'a repeated fault shown twice', () => injectedLine(givenFaults().map((given) => given.fault), runner.PASS_VERDICT)],
    [false, 'a file-name script shown as given, not in number form', () => injectedLine([{ kind: 'fail', script: realScriptFileName(SELECTED_NUMBERS[0]) }, ...normalizedFaults().slice(1)], runner.PASS_VERDICT)],
    [false, 'a missing wrapper', failLine],
  ]),
  ...firstLineRows('selection, injection', () => [...selectedNumberForms(), ...injectArgs()], [
    [true, 'INJECTED (<normalized faults>): wrapping a valid selective line', () => injectedLine(normalizedFaults(), selectiveLine(canonicalList(), failLine()))],
    [false, 'exactly PASS (AC 72)', passLine],
    [false, 'a missing wrapper', () => selectiveLine(canonicalList(), runner.PASS_VERDICT)],
  ]),
  ...firstLineRows('an unknown option the runner refuses', () => refusedArgs(REFUSED_CI_ARGS), [
    [false, 'exactly PASS', passLine],
    [false, 'a FAIL line', failLine],
  ]),
  ...firstLineRows('fail and timeout naming one script, which the runner refuses', () => refusedArgs(['--inject', `fail:${runner.numberFormOf(SELECTED_NUMBERS[0])}`, '--inject', `timeout:${runner.numberFormOf(SELECTED_NUMBERS[0])}`]), [
    [false, 'exactly PASS', passLine],
    [false, 'its faults wrapping PASS', () => injectedLine([{ kind: 'fail', script: runner.numberFormOf(SELECTED_NUMBERS[0]) }, { kind: 'timeout', script: runner.numberFormOf(SELECTED_NUMBERS[0]) }], runner.PASS_VERDICT)],
  ]),
  ...firstLineRows('a SCRIPT that is neither a number form nor a file name', neitherScriptArgs, [
    [false, 'exactly PASS', passLine],
    [false, 'a SELECTIVE line listing test-1', () => selectiveLine([runner.numberFormOf(EVERY_SHARD_NUMBER)], runner.PASS_VERDICT)],
  ]),
]

describe('valid first lines (b.uqm SR-17.2, PRD AC 72, AC 73)', () => {
  test.each([...FIRST_LINE_ROWS])('$label', async (row) => {
    const h = verbHarness()
    h.buildRun({ verdict: row.verdict() })

    const result = await h.run(reportArgv(reader.PID_ARGUMENT_NONE, GRACE_NONE, row.ciArgs()))

    const runnerDied = result.stdout[0] === reader.RUNNER_DIED_TEXT && result.exitCode === reader.REPORT_EXIT_FAIL
    expect(runnerDied).toBe(!row.valid)
  })
})

// --- E3 T3.S4 (.cu): outcomes and report lines ---
//
// b.uqm SR-17.3: the seven outcomes in precedence, their lines and exit codes
// (PRD AC 13, AC 73). The report texts and exit codes are typed only in the
// row-example table below, each beside the reader's exports that build it;
// every other case builds its expected lines from those exports. Removal and
// masking are the redaction and retention block's (T3.S7), but for something
// other than a directory at the run-directory path, whose one case here also
// shows it is never removed; first-line
// validity is T3.S3's, so only one invalid line is used here. The helpers
// up to the table serve that block too.

/** The runner's PID in the report cases: the PRD's example PID, test data. */
const REPORTED_PID = 81234
/** A `<PID>` argument other than the PID the status file names: test data. */
const OTHER_PID_ARGUMENT = 4242
/** m of a signalled grace: the PRD's example deadline minutes, test data. */
const GRACE_LINE_MINUTES = '138'
/** A PASS's timing summary as `results.json` holds it: test data, test-1's file name from the repository's listing. */
function reportTimingSummary(): readonly string[] {
  return ['shards: 6 requested, 6 effective', 'build 4 min (base build 0 min); shard-1 38 min; total 43 min', `${realScriptFileName(EVERY_SHARD_NUMBER)}: 2 min`]
}

/** A run directory's files for `buildRun`, its RUN_ID the case's. */
type ReportRunFiles = Omit<RunDirectorySpec, 'runId'>

/** The status file of a run whose merge runs, naming `REPORTED_PID`. */
function reportRunningStatus(h: VerbHarness): RunStatus {
  return h.status({ pid: REPORTED_PID, phase: 'merge' })
}

/** The status file of a refused run, naming `REPORTED_PID`. */
function reportRefusedStatus(h: VerbHarness, kind: runner.RefusalKind, reason: string, details: readonly string[] = []): RunStatus {
  return h.status({ pid: REPORTED_PID, phase: 'refused', refusal: { kind, reason, details } })
}

/** `results.json` holding `reportTimingSummary()`. */
function reportSummaryResults(): { readonly runId: string; readonly pid: number; readonly timingSummary: readonly string[] } {
  return { runId: RUN_ID, pid: REPORTED_PID, timingSummary: reportTimingSummary() }
}

/** A full PASS's run files: a running status, the timing summary and `PASS`. */
function fullPassFiles(h: VerbHarness): ReportRunFiles {
  return { status: reportRunningStatus(h), results: reportSummaryResults(), verdict: runner.PASS_VERDICT }
}

/** `selectiveLine` with the list test-1 and `numbers` (ascending, above 1) as number forms. */
function selectiveVerdictLine(numbers: readonly number[], inner: string): string {
  return selectiveLine([EVERY_SHARD_NUMBER, ...numbers].map((n) => runner.numberFormOf(n)), inner)
}

/** `INJECTED (<faults>): <inner>`, the faults those of the `/ci` arguments as the runner normalizes them. */
function injectedVerdictLine(ciArgs: readonly string[], inner: string): string {
  const parsed = runner.parseCiArguments(ciArgs)
  if (!parsed.ok) throw new Error(`injectedVerdictLine: ${ciArgs.join(' ')} does not parse`)
  return injectedLine(parsed.invocation.faults, inner)
}

/** A signalled `<grace>` as the reader parses it. */
function signalledGrace(text: string): Exclude<reader.Grace, { readonly kind: 'none' }> {
  const grace = reader.parseGrace(text)
  if (grace === null || grace.kind === 'none') throw new Error(`signalledGrace: ${text} is no signalled grace`)
  return grace
}

/** `term:<m>` and `kill:<m>`, m `GRACE_LINE_MINUTES`. */
const TERM_GRACE = `${reader.GRACE_TERM_PREFIX}${GRACE_LINE_MINUTES}`
const KILL_GRACE = `${reader.GRACE_KILL_PREFIX}${GRACE_LINE_MINUTES}`

/** A file's lines, read here rather than through the reader. */
function reportFileLines(path: string): string[] {
  const text = readFileSync(path, 'utf-8')
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/** One row of the row-example table: the run, the typed report and the same report from the reader's exports. */
interface OutcomeRow {
  readonly ciArgs: readonly string[]
  /** The run directory's files, verdict aside; null for a runner gone before its run directory exists. */
  readonly files: ((h: VerbHarness) => ReportRunFiles) | null
  /** `verdict.txt`'s line; null for none. */
  readonly verdict: string | null
  /** The `<grace>` argument; default `GRACE_NONE`. */
  readonly grace?: string
  /** The report as the PRD's example and b.uqm SR-17.3 write it. */
  readonly typedLines: (runDir: string) => readonly string[]
  readonly typedExit: number
  /** The report from the reader's exported texts and builders. */
  readonly builtLines: (runDir: string, verdict: string) => readonly string[]
  readonly exportedExit: number
}

/** A not-runnable row: a refusal of `kind` and its detail lines, no verdict. */
function notRunRow(kind: runner.RefusalKind, reason: () => string, details: readonly string[], typedFirstLine: string): OutcomeRow {
  return {
    ciArgs: [],
    files: (h) => ({ status: reportRefusedStatus(h, kind, reason(), details) }),
    verdict: null,
    typedLines: () => [typedFirstLine, ...details],
    typedExit: 2,
    builtLines: () => reader.notRunLines(runner.buildRefusal(kind, reason(), details)),
    exportedExit: reader.REPORT_EXIT_NOT_RUN,
  }
}

/**
 * The report's literal texts and exit codes, one row per outcome and refusal
 * kind, and one per fixed line of b.uqm SR-17.3 (the two grace lines, the
 * could-not-be-read line), the PRD's example where it has one: their pin case.
 */
const OUTCOME_ROWS: ReadonlyArray<readonly [string, OutcomeRow]> = [
  [
    'not runnable, memory',
    notRunRow(
      'memory',
      () => '6 shard(s) need 13.0 GiB; 11.5 GiB fits under the 54.4 GiB ceiling',
      ["ceiling: 85% of the 64 GiB pod limit, the sysadmin monitor's warn line", 'largest --shards value that fits now: 5'],
      'NOT RUN: memory: 6 shard(s) need 13.0 GiB; 11.5 GiB fits under the 54.4 GiB ceiling',
    ),
  ],
  [
    'not runnable, disk',
    notRunRow(
      'disk',
      () => "/home is 84% used; this run's 1 GiB would take it to 86%, at or over /ci's 85% disk line",
      ['/home: 840 GiB used of 1000 GiB', 'remove results directories no longer needed on /home, then re-run'],
      "NOT RUN: disk: /home is 84% used; this run's 1 GiB would take it to 86%, at or over /ci's 85% disk line",
    ),
  ],
  [
    'not runnable, cpu',
    notRunRow(
      'cpu',
      () => '6 shard(s) need 12 CPUs; active /ci runs hold 4 of the 12 CI CPUs',
      [`${OTHER_RUN_ID} runner ${OTHER_PID_ARGUMENT}: 2 shards, 4 CPUs, full`, 'largest --shards value that fits now: 4'],
      'NOT RUN: cpu: 6 shard(s) need 12 CPUs; active /ci runs hold 4 of the 12 CI CPUs',
    ),
  ],
  ['not runnable, no kind (the PRD example)', notRunRow(null, () => runner.outOfRangeReason('--shards', '7'), [], 'NOT RUN: --shards 7 is out of range: N must be a whole number from 1 to 6')],
  [
    'runner died: a runner gone before its run directory exists (the PRD example)',
    {
      ciArgs: [],
      files: null,
      verdict: null,
      typedLines: () => ['test runner did not write a valid verdict.txt'],
      typedExit: 1,
      builtLines: () => [reader.RUNNER_DIED_TEXT],
      exportedExit: reader.REPORT_EXIT_FAIL,
    },
  ],
  [
    'runner died: grace term:<m>, the status file naming the runner, no verdict',
    {
      ciArgs: [],
      files: (h) => ({ status: reportRunningStatus(h) }),
      verdict: null,
      grace: TERM_GRACE,
      typedLines: (runDir) => [
        'test runner did not write a valid verdict.txt',
        `results: ${runDir}`,
        'runner 81234 still alive after the 138 min deadline plus grace: sent SIGTERM',
      ],
      typedExit: 1,
      builtLines: (runDir) => [reader.RUNNER_DIED_TEXT, reader.resultsLine(runDir), reader.graceSignalLine(String(REPORTED_PID), signalledGrace(TERM_GRACE))],
      exportedExit: reader.REPORT_EXIT_FAIL,
    },
  ],
  [
    'runner died: grace kill:<m>, the status file naming the runner, no verdict',
    {
      ciArgs: [],
      files: (h) => ({ status: reportRunningStatus(h) }),
      verdict: null,
      grace: KILL_GRACE,
      typedLines: (runDir) => [
        'test runner did not write a valid verdict.txt',
        `results: ${runDir}`,
        'runner 81234 still alive after the 138 min deadline plus grace: sent SIGTERM, then SIGKILL after 30 s',
      ],
      typedExit: 1,
      builtLines: (runDir) => [reader.RUNNER_DIED_TEXT, reader.resultsLine(runDir), reader.graceSignalLine(String(REPORTED_PID), signalledGrace(KILL_GRACE))],
      exportedExit: reader.REPORT_EXIT_FAIL,
    },
  ],
  [
    'injected (the PRD example)',
    {
      ciArgs: ['--inject', 'leak:1,2'],
      files: (h) => ({ status: reportRunningStatus(h) }),
      verdict: "INJECTED (leak:1,2): FAIL: integrity: isolation-mounts: shard-2 mounts shard-1's results subdirectory",
      typedLines: (runDir) => [
        "INJECTED (not a gate result): INJECTED (leak:1,2): FAIL: integrity: isolation-mounts: shard-2 mounts shard-1's results subdirectory",
        `results: ${runDir}`,
      ],
      typedExit: 4,
      builtLines: (runDir, verdict) => [reader.injectedReportLine(verdict), reader.resultsLine(runDir)],
      exportedExit: reader.REPORT_EXIT_INJECTED,
    },
  ],
  [
    'selective PASS (the PRD example), with its timing summary',
    {
      ciArgs: ['test-23'],
      files: (h) => ({ status: reportRunningStatus(h), results: reportSummaryResults() }),
      verdict: 'SELECTIVE (test-1 test-23): PASS',
      typedLines: () => ['SELECTIVE (not a gate result): PASS: test-1 test-23', ...reportTimingSummary()],
      typedExit: 3,
      builtLines: () => [reader.selectivePassLine([1, 23].map((n) => runner.numberFormOf(n)).join(reader.SCRIPT_LIST_SEPARATOR)), ...reportTimingSummary()],
      exportedExit: reader.REPORT_EXIT_SELECTIVE_PASS,
    },
  ],
  [
    'selective FAIL (the PRD example)',
    {
      ciArgs: ['test-2', 'test-3'],
      files: (h) => ({ status: reportRunningStatus(h) }),
      verdict: 'SELECTIVE (test-1 test-2 test-3): FAIL: interrupted: SIGINT',
      typedLines: (runDir) => ['SELECTIVE (not a gate result): FAIL: interrupted: SIGINT', `results: ${runDir}`],
      typedExit: 1,
      builtLines: (runDir, verdict) => [
        reader.selectiveFailLine(verdict.slice(verdict.indexOf(reader.VERDICT_WRAPPER_CLOSE) + reader.VERDICT_WRAPPER_CLOSE.length)),
        reader.resultsLine(runDir),
      ],
      exportedExit: reader.REPORT_EXIT_FAIL,
    },
  ],
  [
    'full PASS (the PRD example), with its timing summary',
    {
      ciArgs: [],
      files: (h) => ({ status: reportRunningStatus(h), results: reportSummaryResults() }),
      verdict: 'PASS',
      typedLines: () => ['✓ Integration tests passed.', ...reportTimingSummary()],
      typedExit: 0,
      builtLines: () => [reader.FULL_PASS_TEXT, ...reportTimingSummary()],
      exportedExit: reader.REPORT_EXIT_FULL_PASS,
    },
  ],
  [
    'full PASS with no results file: its timing summary cannot be read',
    {
      ciArgs: [],
      files: (h) => ({ status: reportRunningStatus(h) }),
      verdict: 'PASS',
      typedLines: (runDir) => ['✓ Integration tests passed.', `timing summary could not be read from ${runDir}/results.json`],
      typedExit: 0,
      builtLines: (runDir) => [reader.FULL_PASS_TEXT, reader.timingSummaryUnreadableLine(runDir)],
      exportedExit: reader.REPORT_EXIT_FULL_PASS,
    },
  ],
  [
    'full FAIL (the PRD example)',
    {
      ciArgs: [],
      files: (h) => ({ status: reportRunningStatus(h) }),
      verdict: `FAIL: ${realScriptFileName(23)}: wall-time limit of 84 min exceeded in shard-2`,
      typedLines: (runDir) => [`FAIL: ${realScriptFileName(23)}: wall-time limit of 84 min exceeded in shard-2`, `results: ${runDir}`],
      typedExit: 1,
      builtLines: (runDir, verdict) => [verdict, reader.resultsLine(runDir)],
      exportedExit: reader.REPORT_EXIT_FAIL,
    },
  ],
]

/** Which forms a run-level line runs in: all three, or the full form only. */
type RunLevelForms = 'every form' | 'full only'

/**
 * The run-level FAIL lines as the PRD's examples write them (b.uqm SR-17.3:
 * run-level stops, image build failures and a shard's out-of-memory failure
 * are FAIL lines like any other), each with the forms it runs in: the
 * out-of-memory lines are the PRD's full FAIL examples, so full only. Inputs
 * only, typed here once: E1 exports no builder for them; a script's file name
 * comes from the repository's listing.
 */
const RUN_LEVEL_FAIL_LINES: ReadonlyArray<readonly [string, () => string, RunLevelForms]> = [
  ['interrupt', () => 'FAIL: interrupted: SIGTERM', 'every form'],
  [
    'memory watchdog',
    () => 'FAIL: memory watchdog: pod working set 54.1 GiB reached the 53.9 GiB stop line (85% of the 64 GiB pod limit; shard-1 1.1 GiB, shard-2 0.8 GiB)',
    'every form',
  ],
  ['run deadline', () => 'FAIL: run deadline: shards still running at the 138 min deadline', 'every form'],
  ['image build', () => 'FAIL: image build: test image build failed (exit 1)', 'every form'],
  ['a script killed for out of memory', () => `FAIL: ${realScriptFileName(23)}: killed for out of memory in shard-2`, 'full only'],
  ['a shard killed for out of memory, no script in progress', () => 'FAIL: shard-3: killed for out of memory', 'full only'],
  ['a shard whose out-of-memory status is unreadable', () => 'FAIL: shard-3: out-of-memory status unreadable', 'full only'],
]

/** A run-level line's three forms: the `/ci` arguments, the verdict line holding it, and the report and exit code that gives. */
interface RunLevelForm {
  readonly ciArgs: () => readonly string[]
  readonly verdict: (line: string) => string
  readonly report: (runDir: string, verdict: string, line: string) => readonly string[]
  readonly exitCode: () => number
}

/** Each form, and whether it is the full one. */
const RUN_LEVEL_FORMS: ReadonlyArray<readonly [string, RunLevelForm, boolean]> = [
  [
    'full, the full FAIL row',
    { ciArgs: () => [], verdict: (line) => line, report: (runDir, verdict) => [verdict, reader.resultsLine(runDir)], exitCode: () => reader.REPORT_EXIT_FAIL },
    true,
  ],
  [
    'selective, the selective FAIL row',
    {
      ciArgs: () => [runner.numberFormOf(2)],
      verdict: (line) => selectiveVerdictLine([2], line),
      report: (runDir, _verdict, line) => [reader.selectiveFailLine(line), reader.resultsLine(runDir)],
      exitCode: () => reader.REPORT_EXIT_FAIL,
    },
    false,
  ],
  [
    'injected, the injected row',
    {
      ciArgs: () => ['--inject', 'kill:1'],
      verdict: (line) => injectedVerdictLine(['--inject', 'kill:1'], line),
      report: (runDir, verdict) => [reader.injectedReportLine(verdict), reader.resultsLine(runDir)],
      exitCode: () => reader.REPORT_EXIT_INJECTED,
    },
    false,
  ],
]

const RUN_LEVEL_ROWS = RUN_LEVEL_FAIL_LINES.flatMap(([stop, line, forms]) =>
  RUN_LEVEL_FORMS.filter(([, , full]) => forms === 'every form' || full).map(([form, spec]) => [`${stop}, ${form}`, line, spec] as const),
)

/** The precedence pairings of b.uqm SR-17.3, each asserted once: the run, the `<grace>` and the report it gives. */
interface PrecedenceRow {
  readonly ciArgs: () => readonly string[]
  readonly grace: string
  readonly files: (h: VerbHarness) => ReportRunFiles
  readonly report: (runDir: string, files: ReportRunFiles) => readonly string[]
  readonly exitCode: () => number
}

/** `/ci` arguments selecting test-2 and injecting a failure into it. */
function injectedSelectiveArgs(): string[] {
  const script = runner.numberFormOf(2)
  return [script, '--inject', `fail:${script}`]
}

const PRECEDENCE_ROWS: ReadonlyArray<readonly [string, PrecedenceRow]> = [
  [
    'a refusal with a verdict gives the runner-died report, not the refusal',
    {
      ciArgs: () => [],
      grace: GRACE_NONE,
      files: (h) => ({ status: reportRefusedStatus(h, null, 'a refusal summary'), verdict: runner.PASS_VERDICT }),
      report: (runDir) => [reader.RUNNER_DIED_TEXT, reader.resultsLine(runDir)],
      exitCode: () => reader.REPORT_EXIT_FAIL,
    },
  ],
  [
    'a refusal with grace term:<m> gives the runner-died report with its grace line, not the refusal',
    {
      ciArgs: () => [],
      grace: TERM_GRACE,
      files: (h) => ({ status: reportRefusedStatus(h, null, 'a refusal summary') }),
      report: (runDir) => [reader.RUNNER_DIED_TEXT, reader.resultsLine(runDir), reader.graceSignalLine(String(REPORTED_PID), signalledGrace(TERM_GRACE))],
      exitCode: () => reader.REPORT_EXIT_FAIL,
    },
  ],
  [
    'a valid PASS with grace kill:<m> gives the runner-died report with its grace line, not the PASS',
    {
      ciArgs: () => [],
      grace: KILL_GRACE,
      files: fullPassFiles,
      report: (runDir) => [reader.RUNNER_DIED_TEXT, reader.resultsLine(runDir), reader.graceSignalLine(String(REPORTED_PID), signalledGrace(KILL_GRACE))],
      exitCode: () => reader.REPORT_EXIT_FAIL,
    },
  ],
  [
    'an injected selective FAIL gives the injected report, not the selective FAIL',
    {
      ciArgs: injectedSelectiveArgs,
      grace: GRACE_NONE,
      files: (h) => ({
        status: reportRunningStatus(h),
        verdict: injectedVerdictLine(injectedSelectiveArgs(), selectiveVerdictLine([2], runner.injectedFailureLine(realScriptFileName(2)))),
      }),
      report: (runDir, files) => [reader.injectedReportLine(String(files.verdict)), reader.resultsLine(runDir)],
      exitCode: () => reader.REPORT_EXIT_INJECTED,
    },
  ],
]

/**
 * The grace-line cases: the `<grace>`, the status file's PID (none: no status
 * file), the `<PID>` argument and the PID the line names. One row per grace
 * form and per branch of the line's PID (the resolved PID, or the argument
 * when none is found); the PID rule's sources are the arguments block's.
 */
const GRACE_LINE_ROWS: ReadonlyArray<readonly [string, string, number | null, string, string]> = [
  ['term:<m>, the status file naming the runner, not the <PID> argument', TERM_GRACE, REPORTED_PID, String(OTHER_PID_ARGUMENT), String(REPORTED_PID)],
  ['kill:<m>, no PID found: the <PID> argument -', KILL_GRACE, null, reader.PID_ARGUMENT_NONE, reader.PID_ARGUMENT_NONE],
]

/** The PASS forms whose timing summary may not be read: the `/ci` arguments, the verdict, the PASS line and exit code. */
const PASS_FORMS: ReadonlyArray<readonly [string, () => readonly string[], () => string, () => string, () => number]> = [
  ['full PASS', () => [], () => runner.PASS_VERDICT, () => reader.FULL_PASS_TEXT, () => reader.REPORT_EXIT_FULL_PASS],
  [
    'selective PASS',
    () => [runner.numberFormOf(23)],
    () => selectiveVerdictLine([23], runner.PASS_VERDICT),
    () => reader.selectivePassLine([1, 23].map((n) => runner.numberFormOf(n)).join(reader.SCRIPT_LIST_SEPARATOR)),
    () => reader.REPORT_EXIT_SELECTIVE_PASS,
  ],
]

/** The results files whose timing summary cannot be read (b.uqm SR-17.3), each a valid file with one stated change, or none. */
const UNREADABLE_SUMMARY_RESULTS: ReadonlyArray<readonly [string, () => RunDirectorySpec['results']]> = [
  ['no results file', () => undefined],
  ['an unparseable results file', () => ({ results: reportSummaryResults(), change: { kind: 'unparseable' } })],
  ['a results file of another version', () => ({ results: reportSummaryResults(), change: { kind: 'version', version: runner.RESULTS_FORMAT_VERSION + 1 } })],
  ['a results file with no timingSummary', () => ({ results: reportSummaryResults(), change: { kind: 'no-timing-summary' } })],
  ['a timingSummary that is one string, not an array', () => ({ results: reportSummaryResults(), change: { kind: 'broken-timing-summary' } })],
  ['a timingSummary array holding a number', () => ({ results: reportSummaryResults(), change: { kind: 'set-key', key: 'timingSummary', value: [reportTimingSummary()[0], 1] } })],
]

/** Every PASS form with every unreadable results file, but a full PASS with no results file: the row-example table's row. */
const UNREADABLE_SUMMARY_ROWS = PASS_FORMS.flatMap((form) =>
  UNREADABLE_SUMMARY_RESULTS.filter(([, spec]) => form[0] !== 'full PASS' || spec() !== undefined).map(([results, spec]) => [`${form[0]}, ${results}`, form, spec] as const),
)

describe('outcomes and report lines (b.uqm SR-17.3)', () => {
  test.each(OUTCOME_ROWS)('row example: %s', async (_label, row) => {
    const h = verbHarness()
    if (row.files !== null) h.buildRun({ ...row.files(h), ...(row.verdict === null ? {} : { verdict: row.verdict }) })

    const result = await h.run(reportArgv(REPORTED_PID, row.grace ?? GRACE_NONE, row.ciArgs))

    expect(result.stdout).toEqual(row.typedLines(h.runDir()))
    expect(result.exitCode).toBe(row.typedExit)
    expect(result.stderr).toEqual([])
    expect(row.builtLines(h.runDir(), row.verdict ?? '')).toEqual(row.typedLines(h.runDir()))
    expect(row.exportedExit).toBe(row.typedExit)
  })

  test.each(RUN_LEVEL_ROWS)('run-level line: %s', async (_label, line, form) => {
    const h = verbHarness()
    const verdict = form.verdict(line())
    h.buildRun({ status: reportRunningStatus(h), verdict })

    const result = await h.run(reportArgv(REPORTED_PID, GRACE_NONE, form.ciArgs()))

    expect(result.stdout).toEqual(form.report(h.runDir(), verdict, line()))
    expect(result.exitCode).toBe(form.exitCode())
  })

  test.each(PRECEDENCE_ROWS)('precedence: %s', async (_label, row) => {
    const h = verbHarness()
    const files = row.files(h)
    h.buildRun(files)

    const result = await h.run(reportArgv(REPORTED_PID, row.grace, row.ciArgs()))

    expect(result.stdout).toEqual(row.report(h.runDir(), files))
    expect(result.exitCode).toBe(row.exitCode())
  })

  test('runner died: an invalid first line (an empty verdict.txt) gives the report with its results line', async () => {
    const h = verbHarness()
    h.buildRun({ status: reportRunningStatus(h), verdict: { line: runner.PASS_VERDICT, change: { kind: 'empty' } } })

    const result = await h.run(reportArgv(REPORTED_PID))

    expect(result.stdout).toEqual([reader.RUNNER_DIED_TEXT, reader.resultsLine(h.runDir())])
    expect(result.exitCode).toBe(reader.REPORT_EXIT_FAIL)
  })

  test.each([
    ['no runner.log', false],
    ['an unreadable runner.log', true],
  ] as const)('runner died: %s prints no log tail', async (_label, unreadableLog) => {
    const h = verbHarness()
    const runDir = h.buildRun({ status: reportRunningStatus(h), ...(unreadableLog ? { runnerLog: { pid: REPORTED_PID, lineCount: 3 } } : {}) })
    const logPath = join(runDir, runner.RUNNER_LOG_FILE_NAME)
    const realReads = createRealRunFileDeps()

    const result = await h.run(reportArgv(REPORTED_PID), {
      deps: { readRunFile: (path) => (unreadableLog && path === logPath ? { kind: 'unreadable', error: 'EACCES: permission denied' } : realReads.readRunFile(path)) },
    })

    expect(result.stdout).toEqual([reader.RUNNER_DIED_TEXT, reader.resultsLine(runDir)])
    expect(result.exitCode).toBe(reader.REPORT_EXIT_FAIL)
  })

  test.each([
    [`shorter than ${RUNNER_LOG_TAIL_LINES} lines`, 5],
    [`of exactly ${RUNNER_LOG_TAIL_LINES} lines`, RUNNER_LOG_TAIL_LINES],
    [`longer than ${RUNNER_LOG_TAIL_LINES} lines`, RUNNER_LOG_TAIL_LINES + 1],
  ])(`runner died: a runner log %s prints its last lines, at most ${RUNNER_LOG_TAIL_LINES}, in order`, async (_label, lineCount) => {
    const h = verbHarness()
    const runDir = h.buildRun({ status: reportRunningStatus(h), runnerLog: { pid: REPORTED_PID, lineCount } })
    const logLines = reportFileLines(join(runDir, runner.RUNNER_LOG_FILE_NAME))
    expect(logLines.length).toBe(lineCount)

    const result = await h.run(reportArgv(REPORTED_PID))

    const tail = logLines.slice(-RUNNER_LOG_TAIL_LINES)
    expect(tail.length).toBe(Math.min(lineCount, RUNNER_LOG_TAIL_LINES))
    expect(result.stdout).toEqual([reader.RUNNER_DIED_TEXT, reader.resultsLine(runDir), ...tail])
    expect(result.exitCode).toBe(reader.REPORT_EXIT_FAIL)
  })

  test.each(GRACE_LINE_ROWS)('runner died: the grace line for %s', async (_label, grace, statusPid, pidArgument, namedPid) => {
    const h = verbHarness()
    const runDir = h.buildRun(statusPid === null ? {} : { status: h.status({ pid: statusPid, phase: 'shards' }) })

    const result = await h.run(reportArgv(pidArgument, grace))

    expect(result.stdout).toEqual([reader.RUNNER_DIED_TEXT, reader.resultsLine(runDir), reader.graceSignalLine(namedPid, signalledGrace(grace))])
    expect(result.exitCode).toBe(reader.REPORT_EXIT_FAIL)
  })

  test.each(['link', 'file'] as const)(
    'runner died: a %s at the run-directory path counts as no run directory: the first line only, nothing in it read, it never removed, what it points to untouched',
    async (kind) => {
      const h = verbHarness()
      const kept = plantNonDirectoryAtRunDir(h.runDir(), kind === 'file' ? { kind } : { kind, elsewhere: join(h.root, 'elsewhere'), run: { runId: RUN_ID, ...fullPassFiles(h) } })
      const before = treeSnapshot(h.tempDir, { extended: true })
      const keptBefore = treeSnapshot(kept, { extended: true })

      const result = await h.run(reportArgv(REPORTED_PID))

      expect(result.stdout).toEqual([reader.RUNNER_DIED_TEXT])
      expect(result.exitCode).toBe(reader.REPORT_EXIT_FAIL)
      expect(result.callsTo('readRunFile')).toEqual([])
      expect(result.callsTo('removeRunDir')).toEqual([])
      expect(treeSnapshot(h.tempDir, { extended: true })).toEqual(before)
      expect(treeSnapshot(kept, { extended: true })).toEqual(keptBefore)
    },
  )

  test.each(UNREADABLE_SUMMARY_ROWS)('a %s: the PASS line, then the could-not-be-read line, and the PASS exit code', async (_label, form, results) => {
    const [, ciArgs, verdict, passLine, exitCode] = form
    const h = verbHarness()
    const spec = results()
    const runDir = h.buildRun({ status: reportRunningStatus(h), verdict: verdict(), ...(spec === undefined ? {} : { results: spec }) })

    const result = await h.run(reportArgv(REPORTED_PID, GRACE_NONE, ciArgs()))

    expect(result.stdout).toEqual([passLine(), reader.timingSummaryUnreadableLine(runDir)])
    expect(result.exitCode).toBe(exitCode())
  })

  test('a results file whose other keys depart from the shape still prints its timing summary', async () => {
    const h = verbHarness()
    const runDir = h.buildRun({ status: reportRunningStatus(h), verdict: runner.PASS_VERDICT })
    writeOffShapeResults(runDir, makeResults({ runId: RUN_ID, pid: REPORTED_PID, timingSummary: reportTimingSummary() }, runDir))

    const result = await h.run(reportArgv(REPORTED_PID))

    expect(result.stdout).toEqual([reader.FULL_PASS_TEXT, ...reportTimingSummary()])
    expect(result.exitCode).toBe(reader.REPORT_EXIT_FULL_PASS)
  })

  test('the same run files give the same report whether the runner is alive or gone', async () => {
    const h = verbHarness()
    const pid = h.addRunner()
    h.buildRun({ status: h.status({ pid, phase: 'shards' }), runnerLog: { pid, lineCount: 3 } })

    const alive = await h.run(reportArgv(pid))
    h.processes.makeGone(pid)
    const gone = await h.run(reportArgv(pid))

    expect(alive.stdout[0]).toBe(reader.RUNNER_DIED_TEXT)
    expect(gone.stdout).toEqual(alive.stdout)
    expect(gone.exitCode).toBe(alive.exitCode)
  })
})

// --- E3 T3.S5 (.qz): wait verb ---

/** Where a case's deadline comes from: the status file (`STATUS_DEADLINE_MINUTES`), or the RUN_ID's time while there is none. */
type DeadlineSource = 'status' | 'no-status'

/** The deadline fields the wait line prints for a source, counted here from the RUN_ID's time and the reader's constants (b.uqm SR-17.5). */
function deadlineFieldsOf(source: DeadlineSource): Pick<reader.WaitReading, 'deadlineMs' | 'minutes' | 'graceEndsMs'> {
  const minuteMs = 60_000
  const minutes = source === 'status' ? STATUS_DEADLINE_MINUTES : NO_STATUS_DEADLINE_MINUTES
  const deadlineMs = runStartMs() + minutes * minuteMs
  return { deadlineMs, minutes, graceEndsMs: deadlineMs + GRACE_MINUTES * minuteMs }
}

/** The wait line the reader's builder gives for a state and what the case set up. */
function expectedWaitLine(
  state: reader.WaitState,
  fields: { readonly phase: reader.WaitPhase; readonly pid: number | null; readonly alive: boolean; readonly source: DeadlineSource },
): string {
  return reader.waitLine(state, { phase: fields.phase, pid: fields.pid, alive: fields.alive, ...deadlineFieldsOf(fields.source) })
}

/** A millisecond constant in seconds, `<n> s`, for test names. */
function seconds(ms: number): string {
  return `${ms / 1_000} s`
}

/** `count` fake-clock times, `intervalMs` apart, from `fromMs`. */
function stepTimes(fromMs: number, count: number, intervalMs: number): number[] {
  return Array.from({ length: count }, (_, index) => fromMs + index * intervalMs)
}

/** When a wait checked the run: each check tests once whether `verdict.txt` exists, its only `runPathKind` call. */
function waitCheckTimes(result: VerbResult): number[] {
  return result.callsTo('runPathKind').map((call) => call.atMs)
}

/** The reads of `verdict.txt`: wait only tests that it exists, never reads it (b.uqm SR-17.1, SR-17.4). */
function verdictFileReads(result: VerbResult): readonly DepCall[] {
  return result.callsTo('readRunFile').filter((call) => call.dep === 'readRunFile' && call.path.endsWith(`/${runner.VERDICT_FILE_NAME}`))
}

/** When a verb printed its line. */
function printTimes(result: VerbResult): number[] {
  return result.callsTo('writeStdout').map((call) => call.atMs)
}

/** A status of the case's run naming `pid`, in `phase`; a refused one records a refusal (test data). */
function statusIn(h: VerbHarness, pid: number, phase: runner.StatusPhase): RunStatus {
  return phase === 'refused' ? h.status({ pid, phase, refusal: { kind: 'memory', reason: 'test data: too little memory' } }) : h.status({ pid, phase })
}

/** A run with a `/ci` runner: a status file in `phase` naming it (none for null), and `verdict.txt` when asked. */
interface RunnerRun {
  readonly h: VerbHarness
  readonly pid: number
  readonly runDir: string
}

function runnerRun(spec: { readonly phase: runner.StatusPhase | null; readonly alive?: boolean; readonly verdict?: boolean; readonly startMs?: number }): RunnerRun {
  const h = verbHarness({ startMs: spec.startMs })
  const pid = h.addRunner({ alive: spec.alive ?? true })
  const runDir = h.buildRun({
    status: spec.phase === null ? undefined : statusIn(h, pid, spec.phase),
    verdict: spec.verdict === true ? runner.PASS_VERDICT : undefined,
  })
  return { h, pid, runDir }
}

/** A change a case makes to a run's files or processes; a file goes through the runner's own writers. */
type RunChange = (run: RunnerRun) => void

const writeStatusPhase =
  (phase: runner.StatusPhase): RunChange =>
  (run) => {
    expect(runner.writeStatusFile(run.runDir, statusIn(run.h, run.pid, phase))).toEqual({ ok: true })
  }

describe('the wait verb (b.uqm SR-17.5)', () => {
  test('pin: the wait line has the format SR-17.5 gives', () => {
    // Test data that equals no reader constant: minutes 120 and 95, a 15 min gap to the grace end.
    expect(
      reader.waitLine('grace', {
        phase: 'shards',
        pid: 4321,
        alive: true,
        deadlineMs: Date.UTC(2026, 9, 8, 14, 0, 0),
        minutes: 120,
        graceEndsMs: Date.UTC(2026, 9, 8, 14, 15, 0),
      }),
    ).toBe('wait: grace phase=shards pid=4321 runner=alive deadline=2026-10-08T14:00:00Z minutes=120 grace-ends=2026-10-08T14:15:00Z')
    expect(
      reader.waitLine('gone', {
        phase: 'none',
        pid: null,
        alive: false,
        deadlineMs: Date.UTC(2026, 9, 8, 13, 35, 0),
        minutes: 95,
        graceEndsMs: Date.UTC(2026, 9, 8, 13, 50, 0),
      }),
    ).toBe('wait: gone phase=none pid=- runner=gone deadline=2026-10-08T13:35:00Z minutes=95 grace-ends=2026-10-08T13:50:00Z')
  })

  test.each([
    ['a verdict and a refusal give verdict', { phase: 'refused', alive: true, verdict: true, atGraceEnd: false }, 'verdict', WAIT_EXIT_VERDICT],
    ['a refusal and a gone runner give refused', { phase: 'refused', alive: false, verdict: false, atGraceEnd: false }, 'refused', WAIT_EXIT_REFUSED],
    ['a refusal and an alive runner past the grace give refused', { phase: 'refused', alive: true, verdict: false, atGraceEnd: true }, 'refused', WAIT_EXIT_REFUSED],
    ['a gone runner past the grace gives gone', { phase: 'shards', alive: false, verdict: false, atGraceEnd: true }, 'gone', WAIT_EXIT_GONE],
    ['an alive runner at the grace end gives grace', { phase: 'shards', alive: true, verdict: false, atGraceEnd: true }, 'grace', WAIT_EXIT_GRACE],
  ] as const)('at the first check, %s, with no timer', async (_label, spec, state, exitCode) => {
    const startMs = spec.atGraceEnd ? deadlineFieldsOf('status').graceEndsMs : runStartMs()
    const { h, pid } = runnerRun({ phase: spec.phase, alive: spec.alive, verdict: spec.verdict, startMs })

    const result = await h.run(waitArgv(pid))

    expect(result.exitCode).toBe(exitCode)
    expect(result.stdout).toEqual([expectedWaitLine(state, { phase: spec.phase, pid, alive: spec.alive, source: 'status' })])
    expect(waitCheckTimes(result)).toEqual([startMs])
    expect(printTimes(result)).toEqual([startMs])
    expect(verdictFileReads(result)).toEqual([])
  })

  test.each([
    ['a verdict file appears', 'shards', ((run) => runner.writeVerdictFile(run.runDir, runner.PASS_VERDICT)) as RunChange, 'verdict', WAIT_EXIT_VERDICT, 'shards', true],
    ['a refusal is recorded', 'shards', writeStatusPhase('refused'), 'refused', WAIT_EXIT_REFUSED, 'refused', true],
    ['the runner dies', 'shards', ((run) => run.h.processes.makeGone(run.pid)) as RunChange, 'gone', WAIT_EXIT_GONE, 'shards', false],
    ['the phase moves from shards to merge', 'shards', writeStatusPhase('merge'), 'running', WAIT_EXIT_RUNNING, 'merge', true],
    ['the status file appears, moving the phase from none', null, writeStatusPhase('build'), 'running', WAIT_EXIT_RUNNING, 'build', true],
  ] as const)(`during a wait, when %s, it returns at the next ${seconds(WAIT_CHECK_INTERVAL_MS)} check`, async (_label, firstPhase, change, state, exitCode, phase, alive) => {
    const run = runnerRun({ phase: firstPhase })
    const startMs = run.h.clock.now()
    const started = run.h.start(waitArgv(run.pid))
    await run.h.clock.advance(2 * WAIT_CHECK_INTERVAL_MS + WAIT_CHECK_INTERVAL_MS / 2)

    change(run)
    const result = await run.h.finish(started)

    const exitCheckMs = startMs + 3 * WAIT_CHECK_INTERVAL_MS
    expect(result.exitCode).toBe(exitCode)
    expect(result.stdout).toEqual([expectedWaitLine(state, { phase, pid: run.pid, alive, source: 'status' })])
    expect(waitCheckTimes(result)).toEqual(stepTimes(startMs, 4, WAIT_CHECK_INTERVAL_MS))
    expect(printTimes(result)).toEqual([exitCheckMs])
    expect(verdictFileReads(result)).toEqual([])
  })

  test(`with nothing changing it returns running at exactly the bound and never before, checking every ${seconds(WAIT_CHECK_INTERVAL_MS)}, and writes, removes, signals and spawns nothing`, async () => {
    const { h, pid } = runnerRun({ phase: 'shards' })
    const startMs = h.clock.now()
    const before = treeSnapshot(h.root, { extended: true })

    const started = h.start(waitArgv(pid))
    await h.clock.advance(WAIT_BOUND_MS - 1)
    expect(started.settled()).toBe(false)
    const result = await h.finish(started)

    expect(result.exitCode).toBe(WAIT_EXIT_RUNNING)
    expect(result.stdout).toEqual([expectedWaitLine('running', { phase: 'shards', pid, alive: true, source: 'status' })])
    expect(waitCheckTimes(result)).toEqual(stepTimes(startMs, WAIT_BOUND_MS / WAIT_CHECK_INTERVAL_MS + 1, WAIT_CHECK_INTERVAL_MS))
    expect(printTimes(result)).toEqual([startMs + WAIT_BOUND_MS])
    expect(result.callsTo('removeRunDir', 'spawn', 'sendSignal')).toEqual([])
    expect(h.signals.signals()).toEqual([])
    expect(h.spawns.spawns()).toEqual([])
    expect(treeSnapshot(h.root, { extended: true })).toEqual(before)
  })

  test.each([
    ['the status file', 'status'],
    ["the RUN_ID's time, with no status file", 'no-status'],
  ] as const)('an alive runner one check before the grace end is not at grace, and is at the grace end; the deadline from %s', async (_label, source) => {
    const { graceEndsMs } = deadlineFieldsOf(source)
    const phase = source === 'status' ? 'shards' : null
    const { h, pid } = runnerRun({ phase, startMs: graceEndsMs - WAIT_CHECK_INTERVAL_MS })

    const result = await h.run(waitArgv(pid))

    expect(result.exitCode).toBe(WAIT_EXIT_GRACE)
    expect(result.stdout).toEqual([expectedWaitLine('grace', { phase: phase ?? reader.PHASE_NONE, pid, alive: true, source })])
    expect(waitCheckTimes(result)).toEqual([graceEndsMs - WAIT_CHECK_INTERVAL_MS, graceEndsMs])
  })
})

// --- E3 T3.S6 (.yn): stop verb ---

/** Every signal the recorder kept, as the case reads it: what, to whom, how it ended and when. */
function sentSignals(h: VerbHarness): { signal: SentSignal; target: SignalTarget; outcome: SignalOutcome; atMs: number }[] {
  return h.signals.signals().map(({ signal, target, outcome, atMs }) => ({ signal, target, outcome, atMs }))
}

/** A signal sent to the runner's PID alone. */
function toPid(signal: SentSignal, pid: number, outcome: SignalOutcome, atMs: number): ReturnType<typeof sentSignals>[number] {
  return { signal, target: { kind: 'pid', pid }, outcome, atMs }
}

/** A runner that ignores SIGTERM, with a status file naming it: only SIGKILL or a change the case makes ends it. */
function sigtermIgnoringRun(options: { readonly permitted?: boolean } = {}): RunnerRun {
  const h = verbHarness()
  const pid = h.addRunner({ signals: { SIGTERM: 'ignores' }, permitted: options.permitted })
  const runDir = h.buildRun({ status: statusIn(h, pid, 'shards') })
  return { h, pid, runDir }
}

describe('the stop verb (b.uqm SR-17.6)', () => {
  test('pin: the three stop lines are the ones SR-17.6 gives', () => {
    expect([
      reader.stopLine({ kind: 'not-alive', pid: null }),
      reader.stopLine({ kind: 'term', pid: 4321, minutes: 120 }),
      reader.stopLine({ kind: 'kill', pid: 4321, minutes: 120 }),
    ]).toEqual([
      'stop: runner - not alive, no signal sent; grace none',
      'stop: sent SIGTERM to runner 4321; grace term:120',
      'stop: sent SIGTERM to runner 4321, then SIGKILL after 30 s; grace kill:120',
    ])
  })

  test.each([
    ['no PID (-)', (): number | null => null],
    ['a gone PID', (h: VerbHarness): number | null => h.addRunner({ alive: false })],
    ['a PID reused by another program', (h: VerbHarness): number | null => h.processes.add({ argv: ['sleep', '600'] })],
    ['a PID reused by a /ci runner with another RUN_ID', (h: VerbHarness): number | null => h.addRunner({ runId: OTHER_RUN_ID })],
  ] as const)(`row ${STOP_EXIT_NOT_ALIVE}: %s gets no signal`, async (_label, place) => {
    const h = verbHarness()
    const pid = place(h)
    if (pid !== null) h.buildRun({ status: statusIn(h, pid, 'shards') })

    const result = await h.run(stopArgv(pid ?? reader.PID_ARGUMENT_NONE))

    expect(result.exitCode).toBe(STOP_EXIT_NOT_ALIVE)
    expect(result.stdout).toEqual([reader.stopLine({ kind: 'not-alive', pid })])
    expect(sentSignals(h)).toEqual([])
    expect(result.callsTo('sendSignal')).toEqual([])
  })

  test.each([
    ['the status file', 'status'],
    [`no status file (${NO_STATUS_DEADLINE_MINUTES})`, 'no-status'],
  ] as const)(`row ${STOP_EXIT_SENT_SIGTERM}: a runner that exits after SIGTERM within the ${seconds(STOP_KILL_AFTER_MS)} gets no SIGKILL; m from %s`, async (_label, source) => {
    const diesAfterMs = 10 * STOP_CHECK_INTERVAL_MS + STOP_CHECK_INTERVAL_MS / 2
    const h = verbHarness()
    const pid = h.addRunner({ signals: { SIGTERM: { diesAfterMs } } })
    h.buildRun(source === 'status' ? { status: statusIn(h, pid, 'shards') } : {})
    const startMs = h.clock.now()

    const result = await h.run(stopArgv(pid))

    expect(result.exitCode).toBe(STOP_EXIT_SENT_SIGTERM)
    expect(result.stdout).toEqual([reader.stopLine({ kind: 'term', pid, minutes: deadlineFieldsOf(source).minutes })])
    expect(sentSignals(h)).toEqual([toPid('SIGTERM', pid, 'delivered', startMs)])
    expect(printTimes(result)).toEqual([startMs + Math.ceil(diesAfterMs / STOP_CHECK_INTERVAL_MS) * STOP_CHECK_INTERVAL_MS])
  })

  test(`row ${STOP_EXIT_SENT_SIGKILL}: a runner still alive ${seconds(STOP_KILL_AFTER_MS)} after SIGTERM gets SIGKILL then and not at the check before, both to its PID only; stop writes, removes and spawns nothing`, async () => {
    const { h, pid } = sigtermIgnoringRun()
    const startMs = h.clock.now()
    const before = treeSnapshot(h.root, { extended: true })

    const started = h.start(stopArgv(pid))
    await h.clock.advance(STOP_KILL_AFTER_MS - STOP_CHECK_INTERVAL_MS)
    expect(sentSignals(h)).toEqual([toPid('SIGTERM', pid, 'delivered', startMs)])
    expect(started.settled()).toBe(false)
    const result = await h.finish(started)

    expect(result.exitCode).toBe(STOP_EXIT_SENT_SIGKILL)
    expect(result.stdout).toEqual([reader.stopLine({ kind: 'kill', pid, minutes: STATUS_DEADLINE_MINUTES })])
    expect(sentSignals(h)).toEqual([toPid('SIGTERM', pid, 'delivered', startMs), toPid('SIGKILL', pid, 'delivered', startMs + STOP_KILL_AFTER_MS)])
    expect(result.callsTo('isPidAlive').map((call) => call.atMs)).toEqual(stepTimes(startMs, STOP_KILL_AFTER_MS / STOP_CHECK_INTERVAL_MS + 1, STOP_CHECK_INTERVAL_MS))
    expect(printTimes(result)).toEqual([startMs + STOP_KILL_AFTER_MS])
    expect(result.callsTo('removeRunDir', 'spawn')).toEqual([])
    expect(h.spawns.spawns()).toEqual([])
    expect(treeSnapshot(h.root, { extended: true })).toEqual(before)
  })

  test(`a PID reused by another program during the ${seconds(STOP_KILL_AFTER_MS)} gets no SIGKILL: row ${STOP_EXIT_SENT_SIGTERM}`, async () => {
    const { h, pid } = sigtermIgnoringRun()
    const startMs = h.clock.now()
    const started = h.start(stopArgv(pid))
    await h.clock.advance(10 * STOP_CHECK_INTERVAL_MS + STOP_CHECK_INTERVAL_MS / 2)

    h.processes.makeGone(pid)
    h.processes.add({ pid, argv: ['sleep', '600'] })
    const result = await h.finish(started)

    expect(result.exitCode).toBe(STOP_EXIT_SENT_SIGTERM)
    expect(result.stdout).toEqual([reader.stopLine({ kind: 'term', pid, minutes: STATUS_DEADLINE_MINUTES })])
    expect(sentSignals(h)).toEqual([toPid('SIGTERM', pid, 'delivered', startMs)])
    expect(printTimes(result)).toEqual([startMs + 11 * STOP_CHECK_INTERVAL_MS])
  })

  test.each([
    [`a SIGTERM that finds no process gives row ${STOP_EXIT_NOT_ALIVE}`, { findsNoProcess: ['SIGTERM'], permitted: true }, [['SIGTERM', 'no-such-process', 0]], 'not-alive'],
    [`a SIGTERM that is not permitted gives row ${STOP_EXIT_NOT_ALIVE}`, { findsNoProcess: [], permitted: false }, [['SIGTERM', 'not-permitted', 0]], 'not-alive'],
    [
      `a SIGKILL that finds no process leaves row ${STOP_EXIT_SENT_SIGTERM}`,
      { findsNoProcess: ['SIGKILL'], permitted: true },
      [
        ['SIGTERM', 'delivered', 0],
        ['SIGKILL', 'no-such-process', STOP_KILL_AFTER_MS],
      ],
      'term',
    ],
  ] as const)('a signal not delivered counts as not sent: %s', async (_label, spec, signals, kind) => {
    const { h, pid } = sigtermIgnoringRun({ permitted: spec.permitted })
    const startMs = h.clock.now()

    const result = await h.run(stopArgv(pid), { signalFindsNoProcess: spec.findsNoProcess })

    const outcome: reader.StopOutcome = kind === 'term' ? { kind, pid, minutes: STATUS_DEADLINE_MINUTES } : { kind, pid }
    expect(result.exitCode).toBe(kind === 'term' ? STOP_EXIT_SENT_SIGTERM : STOP_EXIT_NOT_ALIVE)
    expect(result.stdout).toEqual([reader.stopLine(outcome)])
    expect(sentSignals(h)).toEqual(signals.map(([signal, sent, afterMs]) => toPid(signal, pid, sent, startMs + afterMs)))
  })
})

// --- E3 T3.S7 (.p8): redaction and retention ---
//
// b.uqm SR-17.4 (and the reader's half of SR-15.4): every secret value the
// reader holds prints as `<redacted>` in every text taken from a run file.
// b.uqm SR-16.3 (the reader's half of PRD AC 74): only a PASS with its timing
// summary, or a refusal, removes the run directory, and only after the last
// line is printed; nothing outside it is touched. The line texts are the
// outcome block's; this block asserts masking, removal and their order. Its
// run files and expected lines come from that block's helpers.

/** A gateway's URL beside a gateway key: test data. */
const READER_GATEWAY_URL = 'https://gateway.example.invalid'

/** The secret values the redaction cases plant, each from `fakeToken` with its own suffix (b.uqm SR-21.2), and one cut too short from a built one. */
function readerSecrets(): { rawKey: string; gatewayKey: string; ghToken: string; baseBuildToken: string; tooShort: string } {
  return {
    rawKey: fakeToken(runner.RAW_KEY_PREFIX, 'raw'),
    gatewayKey: fakeToken('gw-', 'gateway'),
    ghToken: fakeToken('', 'gh'),
    baseBuildToken: fakeToken('', 'base-build'),
    tooShort: fakeToken('', 'short').slice(0, runner.SECRET_MIN_LENGTH - 1),
  }
}

/** Each source of a secret value the reader masks: the value, and the harness options that make the reader hold it (b.uqm SR-17.4). */
const SECRET_SOURCES: ReadonlyArray<readonly [string, (s: ReturnType<typeof readerSecrets>) => { readonly value: string; readonly options: VerbHarnessOptions }]> = [
  ['a raw ANTHROPIC_API_KEY', (s) => ({ value: s.rawKey, options: { env: { ANTHROPIC_API_KEY: s.rawKey } } })],
  ['a gateway ANTHROPIC_API_KEY', (s) => ({ value: s.gatewayKey, options: { env: { ANTHROPIC_API_KEY: s.gatewayKey, ANTHROPIC_BASE_URL: READER_GATEWAY_URL } } })],
  ['GH_TOKEN', (s) => ({ value: s.ghToken, options: { env: { GH_TOKEN: s.ghToken } } })],
  ['the base-build token, known only through the gh lookup', (s) => ({ value: s.baseBuildToken, options: { gh: { first: ghTokenAnswer(s.baseBuildToken) } } })],
  ['a GH_TOKEN shorter than SECRET_MIN_LENGTH', (s) => ({ value: s.tooShort, options: { env: { GH_TOKEN: s.tooShort } } })],
]

/** A run-file text holding `value`: test data. */
function textHolding(value: string): string {
  return `the value ${value} in a run file`
}

/** `text` with every `value` in it replaced by the runner's placeholder. */
function maskedText(text: string, value: string): string {
  return text.split(value).join(runner.REDACTION_PLACEHOLDER)
}

/** A run whose files hold a text on purpose: its `/ci` arguments, the files holding the text, and the report with the text masked. */
interface PlantedRun {
  readonly ciArgs: readonly string[]
  readonly planted: readonly string[]
  readonly report: (runDir: string, masked: string) => readonly string[]
}

/** Each kind of run-file text the report prints, planted with `text`. */
const PLANTED_TEXT_KINDS: ReadonlyArray<readonly [string, (h: VerbHarness, text: string) => PlantedRun]> = [
  [
    'a runner-log line (the runner-died report)',
    (h, text) => {
      const runDir = h.buildRun({ status: reportRunningStatus(h), runnerLog: { pid: REPORTED_PID, lines: [text] } })
      const log = join(runDir, runner.RUNNER_LOG_FILE_NAME)
      const logLines = reportFileLines(log)
      return {
        ciArgs: [],
        planted: [log],
        report: (dir, masked) => [reader.RUNNER_DIED_TEXT, reader.resultsLine(dir), ...logLines.map((line) => (line === text ? masked : line))],
      }
    },
  ],
  [
    'a refusal summary line',
    (h, text) => {
      const runDir = h.buildRun({ status: reportRefusedStatus(h, 'memory', text, ['a plain detail']) })
      return { ciArgs: [], planted: [join(runDir, runner.STATUS_FILE_NAME)], report: (_dir, masked) => reader.notRunLines(runner.buildRefusal('memory', masked, ['a plain detail'])) }
    },
  ],
  [
    'a refusal detail line',
    (h, text) => {
      const runDir = h.buildRun({ status: reportRefusedStatus(h, null, 'a plain summary', ['a plain detail', text]) })
      return { ciArgs: [], planted: [join(runDir, runner.STATUS_FILE_NAME)], report: (_dir, masked) => reader.notRunLines(runner.buildRefusal(null, 'a plain summary', ['a plain detail', masked])) }
    },
  ],
  [
    'a timing-summary line',
    (h, text) => {
      const plain = reportTimingSummary()[0] ?? ''
      const runDir = h.buildRun({ status: reportRunningStatus(h), results: { runId: RUN_ID, pid: REPORTED_PID, timingSummary: [plain, text] }, verdict: runner.PASS_VERDICT })
      return { ciArgs: [], planted: [join(runDir, runner.RESULTS_FILE_NAME)], report: (_dir, masked) => [reader.FULL_PASS_TEXT, plain, masked] }
    },
  ],
  [
    'a verdict line (a full FAIL)',
    (h, text) => {
      const runDir = h.buildRun({ status: reportRunningStatus(h), verdict: `${runner.FAIL_PREFIX}${text}` })
      return { ciArgs: [], planted: [join(runDir, runner.VERDICT_FILE_NAME)], report: (dir, masked) => [`${runner.FAIL_PREFIX}${masked}`, reader.resultsLine(dir)] }
    },
  ],
]

const REDACTION_ROWS = SECRET_SOURCES.flatMap(([source, secret]) => PLANTED_TEXT_KINDS.map(([kind, plant]) => [`${source} in ${kind}`, secret, plant] as const))

/** The removals a verb made: each path and whether it succeeded. */
function removalsOf(result: VerbResult): { path: string; ok: boolean }[] {
  return result.callsTo('removeRunDir').flatMap((call) => (call.dep === 'removeRunDir' ? [{ path: call.path, ok: call.ok }] : []))
}

/** The order of a verb's calls to the given members, by member name. */
function callOrder(result: VerbResult, ...deps: readonly DepName[]): string[] {
  return result.callsTo(...deps).map((call) => call.dep)
}

/** A retention case's run: its files, `/ci` arguments and `<grace>`. */
interface RetentionRun {
  readonly ciArgs?: () => readonly string[]
  readonly grace?: string
  readonly files: (h: VerbHarness) => ReportRunFiles
}

/** The outcomes after which the run directory is removed (b.uqm SR-16.3). */
const REMOVED_ROWS: ReadonlyArray<readonly [string, RetentionRun]> = [
  ['a full PASS', { files: fullPassFiles }],
  ['a selective PASS', { ciArgs: () => [runner.numberFormOf(23)], files: (h) => ({ ...fullPassFiles(h), verdict: selectiveVerdictLine([23], runner.PASS_VERDICT) }) }],
  ['a refusal', { files: (h) => ({ status: reportRefusedStatus(h, null, 'a refusal summary', ['a detail']) }) }],
]

/** The outcomes after which the run directory is kept (b.uqm SR-16.3). */
const KEPT_ROWS: ReadonlyArray<readonly [string, RetentionRun]> = [
  ['a full FAIL', { files: (h) => ({ status: reportRunningStatus(h), verdict: `${runner.FAIL_PREFIX}a failure` }) }],
  ['a selective FAIL', { ciArgs: () => [runner.numberFormOf(23)], files: (h) => ({ status: reportRunningStatus(h), verdict: selectiveVerdictLine([23], `${runner.FAIL_PREFIX}a failure`) }) }],
  ['an injected PASS', { ciArgs: () => ['--inject', 'kill:1'], files: (h) => ({ ...fullPassFiles(h), verdict: injectedVerdictLine(['--inject', 'kill:1'], runner.PASS_VERDICT) }) }],
  ['a runner-died report: no verdict', { files: (h) => ({ status: reportRunningStatus(h), runnerLog: { pid: REPORTED_PID, lineCount: 3 } }) }],
  ['a runner-died report: a signalled grace over a full PASS', { grace: KILL_GRACE, files: fullPassFiles }],
  ['an invalid verdict (an empty verdict.txt)', { files: (h) => ({ status: reportRunningStatus(h), verdict: { line: runner.PASS_VERDICT, change: { kind: 'empty' } } }) }],
  ['a PASS whose timing summary cannot be read (no results file)', { files: (h) => ({ status: reportRunningStatus(h), verdict: runner.PASS_VERDICT }) }],
]

/** Runs `report` over a retention case's run. */
async function runRetention(h: VerbHarness, row: RetentionRun): Promise<VerbResult> {
  return h.run(reportArgv(REPORTED_PID, row.grace ?? GRACE_NONE, row.ciArgs?.() ?? []))
}

describe('redaction (b.uqm SR-17.4, SR-15.4)', () => {
  test.each(REDACTION_ROWS)('%s prints as <redacted>', async (_label, secret, plant) => {
    const { value, options } = secret(readerSecrets())
    const h = verbHarness(options)
    const text = textHolding(value)
    const run = plant(h, text)
    h.markPlanted(...run.planted)

    const result = await h.run(reportArgv(REPORTED_PID, GRACE_NONE, run.ciArgs))

    expect(result.stdout).toEqual(run.report(h.runDir(), maskedText(text, value)))
    expect(result.stdout.join('\n')).not.toContain(value)
  })

  test("secret values that also appear in the reader's own texts are masked only in run-file text: the fixed line and the results path print whole", async () => {
    const h = verbHarness({ env: { GH_TOKEN: RUN_ID, ANTHROPIC_API_KEY: runner.VERDICT_FILE_NAME } })
    const logLine = `run ${RUN_ID} ended with no ${runner.VERDICT_FILE_NAME}`
    const runDir = h.buildRun({ status: reportRunningStatus(h), runnerLog: { pid: REPORTED_PID, firstLine: 'absent', lines: [logLine] } })
    expect(reader.resultsLine(runDir)).toContain(RUN_ID)
    expect(reader.RUNNER_DIED_TEXT).toContain(runner.VERDICT_FILE_NAME)

    const result = await h.run(reportArgv(REPORTED_PID))

    expect(result.stdout).toEqual([
      reader.RUNNER_DIED_TEXT,
      reader.resultsLine(runDir),
      `run ${runner.REDACTION_PLACEHOLDER} ended with no ${runner.REDACTION_PLACEHOLDER}`,
    ])
    expect(result.exitCode).toBe(reader.REPORT_EXIT_FAIL)
  })

  test('the first gh lookup gets the environment plus GH_CONFIG_DIR under its HOME; after its empty answer the plain one gets the environment unchanged, and its token is masked', async () => {
    const s = readerSecrets()
    const h = verbHarness({ env: { ANTHROPIC_API_KEY: s.rawKey }, gh: { first: ghTokenAnswer(''), plain: ghTokenAnswer(s.baseBuildToken) } })
    const text = textHolding(s.baseBuildToken)
    const runDir = h.buildRun({ status: reportRunningStatus(h), verdict: `${runner.FAIL_PREFIX}${text}` })
    h.markPlanted(join(runDir, runner.VERDICT_FILE_NAME))

    const result = await h.run(reportArgv(REPORTED_PID))

    expect(h.spawns.spawns().map(({ argv, env, cwd }) => ({ argv, env, cwd }))).toEqual([
      { argv: [...GH_AUTH_TOKEN_ARGV], env: { ...h.env, GH_CONFIG_DIR: ghPersonalConfigDir(h.env) }, cwd: h.worktreeRoot },
      { argv: [...GH_AUTH_TOKEN_ARGV], env: { ...h.env }, cwd: h.worktreeRoot },
    ])
    expect(result.stdout).toEqual([`${runner.FAIL_PREFIX}${maskedText(text, s.baseBuildToken)}`, reader.resultsLine(runDir)])
  })

  test.each([
    ['both gh lookups exit non-zero', {}],
    ['neither gh lookup can be started', { first: { notStarted: 'gh: not found' }, plain: { notStarted: 'gh: not found' } }],
  ] as const)('%s: the report is otherwise unchanged', async (_label, gh) => {
    const s = readerSecrets()
    const h = verbHarness({ env: { GH_TOKEN: s.ghToken }, gh })
    const text = textHolding(s.ghToken)
    const runDir = h.buildRun({ status: reportRunningStatus(h), verdict: `${runner.FAIL_PREFIX}${text}` })
    h.markPlanted(join(runDir, runner.VERDICT_FILE_NAME))

    const result = await h.run(reportArgv(REPORTED_PID))

    expect(h.spawns.spawns().length).toBe(2)
    expect(result.stdout).toEqual([`${runner.FAIL_PREFIX}${maskedText(text, s.ghToken)}`, reader.resultsLine(runDir)])
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(reader.REPORT_EXIT_FAIL)
  })
})

describe('retention (b.uqm SR-16.3, the reader half of PRD AC 74)', () => {
  test.each(REMOVED_ROWS)('removed after %s, only once every report line is printed', async (_label, row) => {
    const h = verbHarness()
    const runDir = h.buildRun(row.files(h))

    const result = await runRetention(h, row)

    expect(removalsOf(result)).toEqual([{ path: runDir, ok: true }])
    expect(readdirSync(h.tempDir)).not.toContain(basename(runDir))
    expect(result.stdout.length).toBeGreaterThan(0)
    expect(callOrder(result, 'writeStdout', 'removeRunDir')).toEqual([...result.stdout.map(() => 'writeStdout'), 'removeRunDir'])
  })

  test.each(KEPT_ROWS)('kept after %s', async (_label, row) => {
    const h = verbHarness()
    h.buildRun(row.files(h))
    const before = treeSnapshot(h.tempDir, { extended: true })

    const result = await runRetention(h, row)

    expect(result.callsTo('removeRunDir')).toEqual([])
    expect(treeSnapshot(h.tempDir, { extended: true })).toEqual(before)
  })

  test('the removal takes only that run directory: a sibling run directory, an unrelated file and the targets of links out of it are untouched, the links removed as links', async () => {
    const h = verbHarness()
    const runDir = h.buildRun(fullPassFiles(h))
    const sibling = h.buildRun({ runId: OTHER_RUN_ID, status: h.status({ runId: OTHER_RUN_ID, pid: OTHER_PID_ARGUMENT, phase: 'merge' }), verdict: runner.PASS_VERDICT })
    const unrelated = join(h.tempDir, 'unrelated.txt')
    writeFileSync(unrelated, 'not a run directory\n')
    const outside = join(h.root, 'outside')
    mkdirSync(outside)
    const outsideFile = join(outside, 'kept.txt')
    writeFileSync(outsideFile, 'kept\n')
    linkOutOfRunDir(runDir, outside, 'link-to-directory')
    linkOutOfRunDir(runDir, outsideFile, 'link-to-file')
    const siblingBefore = treeSnapshot(sibling, { extended: true })
    const outsideBefore = treeSnapshot(outside, { extended: true })
    const unrelatedEntry = (): string[] => treeSnapshot(h.tempDir, { extended: true }).filter((line) => line.startsWith(`${basename(unrelated)}:`))
    const unrelatedBefore = unrelatedEntry()

    const result = await h.run(reportArgv(REPORTED_PID))

    expect(removalsOf(result)).toEqual([{ path: runDir, ok: true }])
    expect(readdirSync(h.tempDir).sort()).toEqual([basename(sibling), basename(unrelated)].sort())
    expect(treeSnapshot(sibling, { extended: true })).toEqual(siblingBefore)
    expect(treeSnapshot(outside, { extended: true })).toEqual(outsideBefore)
    expect(unrelatedBefore.length).toBe(1)
    expect(unrelatedEntry()).toEqual(unrelatedBefore)
  })

  test('a standard-output write that fails stops the printing, skips the removal and keeps the exit code', async () => {
    const h = verbHarness()
    const runDir = h.buildRun(fullPassFiles(h))
    let writes = 0
    const writeStdout = (): void => {
      writes += 1
      if (writes >= 2) throw new Error('standard output closed')
    }

    const result = await h.run(reportArgv(REPORTED_PID), { deps: { writeStdout } })

    expect(result.callsTo('writeStdout').length).toBe(2)
    expect(result.stdout).toEqual([reader.FULL_PASS_TEXT])
    expect(result.stderr).toEqual([])
    expect(result.callsTo('removeRunDir')).toEqual([])
    expect(readdirSync(h.tempDir)).toContain(basename(runDir))
    expect(result.exitCode).toBe(reader.REPORT_EXIT_FULL_PASS)
  })

  test('a removal that fails keeps the report and its exit code, and adds one standard-error line naming the directory', async () => {
    const h = verbHarness()
    const runDir = h.buildRun(fullPassFiles(h))

    const result = await h.run(reportArgv(REPORTED_PID), { deps: { removeRunDir: () => ({ ok: false, error: 'EACCES: permission denied' }) } })

    expect(result.stdout).toEqual([reader.FULL_PASS_TEXT, ...reportTimingSummary()])
    expect(result.exitCode).toBe(reader.REPORT_EXIT_FULL_PASS)
    expect(result.stderr).toEqual([reader.removalFailedLine(runDir)])
    expect(result.stderr[0]).toContain(runDir)
    expect(callOrder(result, 'writeStdout', 'removeRunDir', 'writeStderr')).toEqual([
      ...result.stdout.map(() => 'writeStdout'),
      'removeRunDir',
      'writeStderr',
    ])
  })
})

// ===========================================================================
// E13 (t1.t6s.vd): the audit of the /ci skill (b.uqm SR-18.3); E13 adds its cases here
// ===========================================================================
//
// The audit of `.claude/skills/ci/SKILL.md` (b.uqm SR-18.2, SR-18.3; b.t6s E13
// T7.S1). `e13SkillProblems(text)` returns what is wrong with the skill's
// text: the committed skill gives none, and each change planted into its real
// text is reported by name. Every exit code, limit, bound and fixed text it
// checks is the reader's or the runner's export, never typed. Only SR-17.1's
// argument forms are typed, from the SRD: `READER_USAGE_TEXT` writes
// `[/ci arguments]` where SR-17.1 writes `[<the /ci arguments>]`, and the
// skill is held to SR-17.1.
//
// A command is a line of a fenced shell block. "Finishing a run by hand" runs
// its commands as inline code, so there each inline code span holding
// whitespace is checked for `sleep`, `timeout` and `verdict.txt` too. The
// skill names those three in its other prose and headings on purpose, so
// nothing else there counts as a command. The skill's base tag and
// release-candidate names are tests/ci-live-docker.test.ts's checks, and
// `BEES_MCP_URL` and `host.docker.internal` tests/bees-mcp-removed.test.ts's;
// the 40-hex commit is checked here. Names in this region start with `e13` or
// `E13`.

import { findSection, flat, splitFences } from './test-helpers/markdown.ts'

/** The skill, from the repository root. */
const E13_SKILL_PATH = join('.claude', 'skills', 'ci', 'SKILL.md')

/** The committed skill's text, read when a case runs. */
function e13Skill(): string {
  return readFileSync(join(REPO_ROOT, E13_SKILL_PATH), 'utf-8')
}

/** Milliseconds in a second: the skill gives the reader's bounds in seconds. */
const E13_MS_PER_SECOND = 1_000

/** A bound in milliseconds, in the seconds the skill writes. */
function e13Seconds(ms: number): number {
  return ms / E13_MS_PER_SECOND
}

/** The `/ci` arguments' placeholder, as SR-17.1 and the skill's procedure write it. */
const E13_CI_ARGUMENTS = '<the /ci arguments>'

/** Each verb's arguments as SR-17.1 gives them (test data from the SRD, not `READER_USAGE_TEXT`). */
const E13_SR_17_1_ARGUMENTS: Readonly<Record<reader.ReaderVerb, string>> = {
  report: `<RUN_ID> <PID> <grace> [${E13_CI_ARGUMENTS}]`,
  wait: '<RUN_ID> <PID>',
  stop: '<RUN_ID> <PID>',
}

/** A verb's command line as SR-17.1 gives it. */
function e13VerbLine(verb: reader.ReaderVerb): string {
  return `${reader.READER_COMMAND} ${verb} ${E13_SR_17_1_ARGUMENTS[verb]}`
}

/** A verb as the procedure runs it: SR-17.1's line, with the `/ci` arguments given rather than optional. */
function e13VerbCall(verb: reader.ReaderVerb): string {
  return e13VerbLine(verb).replace(`[${E13_CI_ARGUMENTS}]`, E13_CI_ARGUMENTS)
}

/** The hand-finishing heading's title, as both `verdict reader failed:` lines name it. */
const E13_HAND_TITLE = /"([^"]+)" says$/.exec(WAIT_READER_FAILED_TEXT)?.[1] ?? ''

/** The launch's runner command up to its redirections: detached by `setsid`, the RUN_ID first, the `/ci` arguments after (b.uqm SR-18.2). */
const E13_LAUNCH = `setsid bun ${RUNNER_PATH_SUFFIX} "\${RUN_ID}" ${E13_CI_ARGUMENTS}`

/** A PID and minutes no skill text holds, put back as `<pid>` and `<m>` in the stop line. */
const E13_STOP_PID = 987_654_321
const E13_STOP_MINUTES = 123_456

/** The info words of a fenced block whose lines are commands; an untagged block counts. */
const E13_SHELL_INFOS = ['sh', 'bash', 'shell', '']

/** `codes` in ascending order, as the skill lists them: `0, 10, 11, 12 and 13`. */
function e13List(codes: readonly number[], last: 'and' | 'or'): string {
  const sorted = [...codes].sort((a, b) => a - b).map(String)
  return `${sorted.slice(0, -1).join(', ')} ${last} ${sorted.at(-1)}`
}

/** The stop table's rows as the reader's stop line and exit codes give them, `<pid>` and `<m>` in place: `<what it did>`, exit and `<grace>`. */
function e13StopRows(): { what: string; exit: number; grace: string }[] {
  const outcomes: reader.StopOutcome[] = [
    { kind: 'not-alive', pid: E13_STOP_PID },
    { kind: 'term', pid: E13_STOP_PID, minutes: E13_STOP_MINUTES },
    { kind: 'kill', pid: E13_STOP_PID, minutes: E13_STOP_MINUTES },
  ]
  return outcomes.map((outcome) => {
    const grace = reader.graceText(reader.stopGrace(outcome))
    const line = reader.stopLine(outcome)
    return {
      what: line.slice(line.indexOf(' ') + 1, line.lastIndexOf(`; grace ${grace}`)).replaceAll(String(E13_STOP_PID), '<pid>'),
      exit: reader.stopExitCode(outcome),
      grace: grace.replace(String(E13_STOP_MINUTES), '<m>'),
    }
  })
}

/** Every command line of `text`'s fenced shell blocks, trimmed; blank and comment lines left out. */
function e13Commands(text: string): string[] {
  return splitFences(text)
    .blocks.filter((b) => E13_SHELL_INFOS.includes(b.info))
    .flatMap((b) => b.body.split('\n').map((l) => l.trim()))
    .filter((l) => l !== '' && !l.startsWith('#'))
}

/** The inline code spans of `section`'s prose that hold whitespace, so may be commands; one span may cross a line wrap. */
function e13Spans(section: string): string[] {
  return [...flat(splitFences(section).prose).matchAll(/`([^`]+)`/g)].map((m) => (m[1] as string).trim()).filter((s) => /\s/.test(s))
}

/** Whether `line` runs `command`: any shell word equal to it, so after a keyword (`do`, `then`), `{` or `!` as well as at a command's start. */
function e13Runs(line: string, command: string): boolean {
  return new RegExp(`(?:^|[\\s;&|(\`{!])${command}(?=[\\s;)&|]|$)`).test(line)
}

/** The cells of every body row of `text`'s Markdown tables (the rows after a divider row). */
function e13TableRows(text: string): string[][] {
  const rows: string[][] = []
  let inBody = false
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (!line.startsWith('|')) inBody = false
    else if (/^\|[\s:|-]+\|$/.test(line)) inBody = true
    else if (inBody) rows.push(line.slice(1, -1).split('|').map((c) => c.trim()))
  }
  return rows
}

/** Which of the launch line's standard input, output and error are not on `/dev/null`, so stay on the Bash call's streams. */
function e13StreamsLeft(line: string): string[] {
  const out = /\s1?>\s*\/dev\/null(?=\s|$)/.exec(line)
  const merged = /\s2>&1(?=\s|$)/.exec(line)
  const left: string[] = []
  if (!/\s0?<\s*\/dev\/null(?=\s|$)/.test(line)) left.push('standard input')
  if (out === null) left.push('standard output')
  if (!/\s2>\s*\/dev\/null(?=\s|$)/.test(line) && !(out !== null && merged !== null && merged.index > out.index)) left.push('standard error')
  return left
}

/** What is wrong with the launch step's commands (b.uqm SR-18.2): detached, its streams on none of the call's, job control off, and the RUN_ID, PID and run directory printed. */
function e13LaunchProblems(lines: readonly string[]): string[] {
  const at = lines.findIndex((l) => l.includes(`bun ${RUNNER_PATH_SUFFIX} `))
  if (at < 0) return [`the launch does not run bun ${RUNNER_PATH_SUFFIX}`]
  const line = lines[at] as string
  const problems: string[] = []
  if (!line.startsWith(`${E13_LAUNCH} `)) problems.push(`the launch does not start ${E13_LAUNCH}: ${line}`)
  if (!/\s&$/.test(line)) problems.push(`the launch does not run the runner in the background: ${line}`)
  const left = e13StreamsLeft(line)
  if (left.length > 0) problems.push(`the launch leaves ${left.join(' and ')} on the Bash call's streams: ${line}`)
  if (!lines.slice(0, at).includes('set +m')) problems.push('the launch does not turn job control off (set +m) before it starts the runner')
  if (lines[at + 1] !== 'RUNNER_PID=$!') problems.push('the launch does not take the runner PID from $! just after it starts the runner')
  const echoes = lines.filter((l) => l.startsWith('echo '))
  const printed: [string, string][] = [
    ['the RUN_ID', '${RUN_ID}'],
    [`the runner PID, or ${reader.PID_ARGUMENT_NONE} when there is none`, `\${RUNNER_PID:-${reader.PID_ARGUMENT_NONE}}`],
    ['the run directory', '${RUN_DIR}'],
  ]
  for (const [what, ref] of printed) if (!echoes.some((e) => e.includes(ref))) problems.push(`the launch does not print ${what}: ${ref}`)
  if (!lines.some((l) => l.startsWith('RUN_DIR=') && l.includes(`/${RUN_DIR_PREFIX}\${RUN_ID}"`))) problems.push(`the launch's run directory is not ${RUN_DIR_PREFIX}<RUN_ID>`)
  return problems
}

/** What is wrong with the skill's text (b.uqm SR-18.2, SR-18.3); none for the committed skill. */
function e13SkillProblems(text: string): string[] {
  const problems: string[] = []
  const blocks = splitFences(text).blocks
  const commands = e13Commands(text)
  const stopRows = e13StopRows()

  // The three verbs as SR-17.1 gives them, and each wait and stop exit beside its state.
  const verbsHeading = "## The verdict reader's verbs"
  const verbs = findSection(text, verbsHeading)
  if (verbs === undefined) problems.push(`has no "${verbsHeading}" heading`)
  else {
    const lines = splitFences(verbs)
      .blocks.filter((b) => b.info === 'text')
      .flatMap((b) => b.body.split('\n').map((l) => l.trim()))
    for (const verb of reader.READER_VERBS) if (!lines.includes(e13VerbLine(verb))) problems.push(`the verbs block does not name the ${verb} verb as SR-17.1 gives it: ${e13VerbLine(verb)}`)
    const rows = e13TableRows(verbs)
    for (const state of reader.WAIT_STATES) {
      const row = rows.find((r) => r[0] === `\`${state}\``)
      const exit = String(reader.waitExitCode(state))
      if (row === undefined) problems.push(`the wait table has no ${state} row`)
      else if (row[1] !== exit) problems.push(`the wait table gives ${state} exit ${row[1]}, not ${exit}`)
    }
    for (const want of stopRows) {
      const row = rows.find((r) => r[2] === `\`${want.grace}\``)
      if (row === undefined) problems.push(`the stop table has no ${want.grace} row`)
      else {
        if (row[1] !== String(want.exit)) problems.push(`the stop table gives ${want.grace} exit ${row[1]}, not ${want.exit}`)
        if (row[0] !== `\`${want.what}\``) problems.push(`the stop table's ${want.grace} row says ${row[0]}, not the stop line's \`${want.what}\``)
      }
    }
  }

  // What the skill does after each wait exit.
  const poll = findSection(text, /^### .*\bPoll$/)
  if (poll === undefined) problems.push('has no Poll step')
  else {
    const rows = e13TableRows(poll)
    const exits = [String(WAIT_EXIT_RUNNING), e13List([WAIT_EXIT_VERDICT, WAIT_EXIT_REFUSED, WAIT_EXIT_GONE], 'or'), String(WAIT_EXIT_GRACE)]
    const found = rows.slice(0, exits.length).map((r) => r[0])
    if (JSON.stringify(found) !== JSON.stringify(exits)) problems.push(`the poll table's exits are ${JSON.stringify(found)}, not ${JSON.stringify(exits)}`)
    else if (!(rows[1]?.[1] ?? '').includes(`\`${GRACE_NONE}\``)) problems.push(`the poll table's ${exits[1]} row does not give the grace ${GRACE_NONE}`)
  }

  // The limits, the known and unknown exits and the bounds, each from the reader's constants.
  const waitCodes = reader.WAIT_STATES.map(reader.waitExitCode)
  const reportCodes = [reader.REPORT_EXIT_FULL_PASS, reader.REPORT_EXIT_FAIL, reader.REPORT_EXIT_NOT_RUN, reader.REPORT_EXIT_SELECTIVE_PASS, reader.REPORT_EXIT_INJECTED]
  const [none, term, kill] = stopRows as [(typeof stopRows)[number], (typeof stopRows)[number], (typeof stopRows)[number]]
  const phrases: [string, string][] = [
    ['the limit of unknown wait exits', `After ${UNKNOWN_WAIT_EXIT_LIMIT} unknown exits in a row`],
    ['the limit of stop calls', `at most ${STOP_CALL_LIMIT} stop calls in all`],
    ['the unknown wait exits', `a wait exit other than ${e13List(waitCodes, 'and')}`],
    ['the unknown stop exits', `a stop exit other than ${e13List(stopRows.map((r) => r.exit), 'and')}`],
    ['the grace after each stop exit', `\`${none.grace}\` after exit ${none.exit}, \`${term.grace}\` after ${term.exit}, \`${kill.grace}\` after ${kill.exit}`],
    ['the report exits', `exits with its code: ${e13List(reportCodes, 'or')}`],
    ['the usage exit as unknown', `counts a wait or stop exit of ${runner.USAGE_EXIT_STATUS} as unknown`],
    ["the wait's bound and checks", `waits at most ${e13Seconds(WAIT_BOUND_MS)} s for the run to move on, checking every ${e13Seconds(WAIT_CHECK_INTERVAL_MS)} s`],
    ['the deadline while no status file can be read', `the RUN_ID's time plus ${NO_STATUS_DEADLINE_MINUTES} min`],
    ['the grace', `The grace ends ${GRACE_MINUTES} min after the deadline`],
    ["the stop's SIGKILL", `SIGKILL when the runner is still alive ${e13Seconds(STOP_KILL_AFTER_MS)} s later`],
    ["a wait call's time", `a wait returns within ${e13Seconds(WAIT_BOUND_MS)} s plus its start-up`],
    ["a stop call's time", `a stop returns within ${e13Seconds(STOP_KILL_AFTER_MS)} s plus its start-up`],
  ]
  const all = flat(text)
  for (const [what, phrase] of phrases) if (!all.includes(phrase)) problems.push(`does not state ${what}: ${phrase}`)

  // Both `verdict reader failed:` lines, each a block of its own.
  const failed: [string, string][] = [
    ['wait', WAIT_READER_FAILED_TEXT],
    ['stop', STOP_READER_FAILED_TEXT],
  ]
  for (const [verb, line] of failed) if (!blocks.some((b) => b.info === 'text' && b.body.trim() === line)) problems.push(`does not hold the ${verb} verb's verdict reader failed: line as a block of its own: ${line}`)

  // Finishing a run by hand.
  const handHeading = `## ${E13_HAND_TITLE}`
  const hand = findSection(text, handHeading)
  if (hand === undefined) problems.push(`has no "${handHeading}" heading`)
  else {
    const handText = flat(hand)
    for (const verb of reader.READER_VERBS) if (!handText.includes(`\`${e13VerbCall(verb)}\``)) problems.push(`"${E13_HAND_TITLE}" does not run the ${verb} verb as SR-17.1 gives it: ${e13VerbCall(verb)}`)
    const until = `until it exits ${e13List([WAIT_EXIT_VERDICT, WAIT_EXIT_REFUSED, WAIT_EXIT_GONE, WAIT_EXIT_GRACE], 'or')}`
    if (!handText.includes(until)) problems.push(`"${E13_HAND_TITLE}" does not wait ${until}`)
  }

  // The launch.
  const launch = findSection(text, /^### .*\bLaunch$/)
  if (launch === undefined) problems.push('has no Launch step')
  else problems.push(...e13LaunchProblems(e13Commands(launch)))

  // The commands, the hand-finishing spans among them: no sleep or timeout, no verdict.txt, and the reader run only as SR-17.1 gives it.
  for (const line of [...commands, ...(hand === undefined ? [] : e13Spans(hand))]) {
    for (const command of ['sleep', 'timeout']) if (e13Runs(line, command)) problems.push(`a command runs ${command}: ${line}`)
    if (line.includes(runner.VERDICT_FILE_NAME)) problems.push(`a command names ${runner.VERDICT_FILE_NAME}, which only the reader reads: ${line}`)
  }
  for (const line of commands) {
    const at = line.indexOf(`${reader.READER_COMMAND} `)
    const call = at < 0 ? undefined : (line.slice(at).split(';')[0] as string).trim()
    if (call !== undefined && !reader.READER_VERBS.some((verb) => call === e13VerbCall(verb))) problems.push(`a command runs the reader other than as SR-17.1 gives it: ${call}`)
  }
  for (const verb of reader.READER_VERBS) if (!commands.some((l) => l.includes(e13VerbCall(verb)))) problems.push(`no command runs the ${verb} verb`)

  // No 40-hex commit.
  for (const hex of text.match(/(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []) problems.push(`holds a 40-hex commit: ${hex}`)

  return problems
}

/** `text` with `from` replaced by `to` once, checked to change it (a planted row that plants nothing would pass vacuously). */
function e13Planted(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, () => to)
  expect(out).not.toBe(text)
  return out
}

/** A 40-hex commit for the planted row. */
const E13_COMMIT = '0123456789abcdef'.repeat(3).slice(0, 40)

describe('E13: the /ci skill audit (b.uqm SR-18.2, SR-18.3; b.t6s E13 T7.S1)', () => {
  test('the committed skill has no problem: its verbs, exit tables, limits, bounds, failure lines, hand-finishing heading, launch and commands match the reader', () => {
    expect(E13_HAND_TITLE).not.toBe('')
    expect(STOP_READER_FAILED_TEXT.endsWith(`"${E13_HAND_TITLE}" says`)).toBe(true)
    expect(e13SkillProblems(e13Skill())).toEqual([])
  })

  const waitExits = [String(WAIT_EXIT_RUNNING), e13List([WAIT_EXIT_VERDICT, WAIT_EXIT_REFUSED, WAIT_EXIT_GONE], 'or')]
  const kill = (): { what: string; grace: string } => e13StopRows()[2] as { what: string; grace: string }
  const killAfter = ` after ${e13Seconds(STOP_KILL_AFTER_MS)} s`
  const waitCall = `${e13VerbCall('wait')}; echo`
  const reportCall = `${e13VerbCall('report')}; echo`
  const verdictRead = `head -n 1 "/tmp/${RUN_DIR_PREFIX}<RUN_ID>/${runner.VERDICT_FILE_NAME}"`
  const handExits = [WAIT_EXIT_VERDICT, WAIT_EXIT_REFUSED, WAIT_EXIT_GONE, WAIT_EXIT_GRACE]

  // Each row plants one change in the committed skill; the audit must name it.
  test.each<[string, (text: string) => string, () => string | string[]]>([
    ['dropped stop verb', (t) => e13Planted(t, `${e13VerbLine('stop')}\n`, ''), () => `the verbs block does not name the stop verb as SR-17.1 gives it: ${e13VerbLine('stop')}`],
    [
      "report verb in READER_USAGE_TEXT's form",
      (t) => e13Planted(t, `[${E13_CI_ARGUMENTS}]`, '[/ci arguments]'),
      () => `the verbs block does not name the report verb as SR-17.1 gives it: ${e13VerbLine('report')}`,
    ],
    [
      'changed wait exit',
      (t) => e13Planted(t, `| \`gone\` | ${WAIT_EXIT_GONE} |`, `| \`gone\` | ${WAIT_EXIT_GONE + 2} |`),
      () => `the wait table gives gone exit ${WAIT_EXIT_GONE + 2}, not ${WAIT_EXIT_GONE}`,
    ],
    [
      'changed stop exit',
      (t) => e13Planted(t, `| ${STOP_EXIT_SENT_SIGTERM} | \`${reader.GRACE_TERM_PREFIX}<m>\` |`, `| ${STOP_EXIT_SENT_SIGTERM + 2} | \`${reader.GRACE_TERM_PREFIX}<m>\` |`),
      () => `the stop table gives ${reader.GRACE_TERM_PREFIX}<m> exit ${STOP_EXIT_SENT_SIGTERM + 2}, not ${STOP_EXIT_SENT_SIGTERM}`,
    ],
    [
      'stop row that differs from the stop line',
      (t) => e13Planted(t, `${killAfter}\` |`, '` |'),
      () => `the stop table's ${kill().grace} row says \`${kill().what.replace(killAfter, '')}\`, not the stop line's \`${kill().what}\``,
    ],
    [
      'changed poll exit',
      (t) => e13Planted(t, new RegExp(`^\\| ${WAIT_EXIT_GRACE} \\|`, 'm'), `| ${WAIT_EXIT_GRACE + 1} |`),
      () => `the poll table's exits are ${JSON.stringify([...waitExits, String(WAIT_EXIT_GRACE + 1)])}, not ${JSON.stringify([...waitExits, String(WAIT_EXIT_GRACE)])}`,
    ],
    [
      'raised unknown-exit limit',
      (t) => e13Planted(t, `After ${UNKNOWN_WAIT_EXIT_LIMIT} unknown exits in a row`, `After ${UNKNOWN_WAIT_EXIT_LIMIT + 1} unknown exits in a row`),
      () => `does not state the limit of unknown wait exits: After ${UNKNOWN_WAIT_EXIT_LIMIT} unknown exits in a row`,
    ],
    [
      'raised stop-call limit',
      (t) => e13Planted(t, `at most ${STOP_CALL_LIMIT} stop calls in all`, `at most ${STOP_CALL_LIMIT + 2} stop calls in all`),
      () => `does not state the limit of stop calls: at most ${STOP_CALL_LIMIT} stop calls in all`,
    ],
    [
      'changed usage exit',
      (t) => e13Planted(t, `exit of ${runner.USAGE_EXIT_STATUS} as unknown`, `exit of ${runner.USAGE_EXIT_STATUS + 1} as unknown`),
      () => `does not state the usage exit as unknown: counts a wait or stop exit of ${runner.USAGE_EXIT_STATUS} as unknown`,
    ],
    [
      'changed wait bound',
      (t) => e13Planted(t, `waits at most ${e13Seconds(WAIT_BOUND_MS)} s`, `waits at most ${e13Seconds(WAIT_BOUND_MS) + 30} s`),
      () =>
        `does not state the wait's bound and checks: waits at most ${e13Seconds(WAIT_BOUND_MS)} s for the run to move on, checking every ${e13Seconds(WAIT_CHECK_INTERVAL_MS)} s`,
    ],
    [
      'changed wait failure line',
      (t) => e13Planted(t, WAIT_READER_FAILED_TEXT, WAIT_READER_FAILED_TEXT.replace('may still be running', 'is still running')),
      () => `does not hold the wait verb's verdict reader failed: line as a block of its own: ${WAIT_READER_FAILED_TEXT}`,
    ],
    [
      'changed stop failure line',
      (t) => e13Planted(t, STOP_READER_FAILED_TEXT, STOP_READER_FAILED_TEXT.replace(`stop exited <code>`, 'stop failed <code>')),
      () => `does not hold the stop verb's verdict reader failed: line as a block of its own: ${STOP_READER_FAILED_TEXT}`,
    ],
    ['renamed hand-finishing heading', (t) => e13Planted(t, `## ${E13_HAND_TITLE}\n`, '## Finishing a run manually\n'), () => `has no "## ${E13_HAND_TITLE}" heading`],
    [
      'hand finishing that stops waiting before the grace',
      (t) => e13Planted(t, `until it exits ${e13List(handExits, 'or')}`, `until it exits ${e13List(handExits.slice(0, -1), 'or')}`),
      () => `"${E13_HAND_TITLE}" does not wait until it exits ${e13List(handExits, 'or')}`,
    ],
    ['sleep command', (t) => e13Planted(t, waitCall, `sleep 30\n${waitCall}`), () => 'a command runs sleep: sleep 30'],
    ['timeout command', (t) => e13Planted(t, waitCall, `timeout 120 ${waitCall}`), () => `a command runs timeout: timeout 120 ${waitCall} "wait exit: $?"`],
    [
      'sleep after a shell keyword',
      (t) => e13Planted(t, `${waitCall} "wait exit: $?"`, `until ${e13VerbCall('wait')}; do sleep 5; done`),
      () => `a command runs sleep: until ${e13VerbCall('wait')}; do sleep 5; done`,
    ],
    [
      'sleep in a hand-finishing span',
      (t) => e13Planted(t, 'Run it again after an', 'Run `sleep 60`, then run it again after an'),
      () => 'a command runs sleep: sleep 60',
    ],
    [
      'verdict.txt read',
      (t) => e13Planted(t, reportCall, `${verdictRead}\n${reportCall}`),
      () => `a command names ${runner.VERDICT_FILE_NAME}, which only the reader reads: ${verdictRead}`,
    ],
    [
      "launch on the call's streams",
      (t) => e13Planted(t, ' >/dev/null 2>&1 &\n', ' &\n'),
      () => `the launch leaves standard output and standard error on the Bash call's streams: ${E13_LAUNCH} </dev/null &`,
    ],
    [
      'launch in the calling session',
      (t) => e13Planted(t, `setsid bun ${RUNNER_PATH_SUFFIX}`, `bun ${RUNNER_PATH_SUFFIX}`),
      () => `the launch does not start ${E13_LAUNCH}: ${E13_LAUNCH.replace('setsid ', '')} </dev/null >/dev/null 2>&1 &`,
    ],
    [
      'launch in the foreground',
      (t) => e13Planted(t, ' 2>&1 &\n', ' 2>&1\n'),
      () => `the launch does not run the runner in the background: ${E13_LAUNCH} </dev/null >/dev/null 2>&1`,
    ],
    ['launch with job control on', (t) => e13Planted(t, 'set +m\n', ''), () => 'the launch does not turn job control off (set +m) before it starts the runner'],
    ['launch with no PID from $!', (t) => e13Planted(t, 'RUNNER_PID=$!\n', ''), () => 'the launch does not take the runner PID from $! just after it starts the runner'],
    [
      'poll wait with no PID',
      (t) => e13Planted(t, waitCall, `${e13VerbCall('wait').replace(' <PID>', '')}; echo`),
      () => [`a command runs the reader other than as SR-17.1 gives it: ${e13VerbCall('wait').replace(' <PID>', '')}`, 'no command runs the wait verb'],
    ],
    [
      'poll table with no grace',
      (t) => e13Planted(t, `The grace is \`${GRACE_NONE}\`; go to step 4`, 'Go to step 4'),
      () => `the poll table's ${e13List([WAIT_EXIT_VERDICT, WAIT_EXIT_REFUSED, WAIT_EXIT_GONE], 'or')} row does not give the grace ${GRACE_NONE}`,
    ],
    [
      'printed PID with no fallback',
      (t) => e13Planted(t, `\${RUNNER_PID:-${reader.PID_ARGUMENT_NONE}}`, '${RUNNER_PID}'),
      () => `the launch does not print the runner PID, or ${reader.PID_ARGUMENT_NONE} when there is none: \${RUNNER_PID:-${reader.PID_ARGUMENT_NONE}}`,
    ],
    ['commit', (t) => `${t}\nBuilt from commit ${E13_COMMIT}.\n`, () => `holds a 40-hex commit: ${E13_COMMIT}`],
  ])('a planted %s is reported', (_label, plant, problem) => {
    expect(e13SkillProblems(plant(e13Skill()))).toEqual([problem()].flat())
  })
})
