/**
 * test-helpers/ci-run.ts — Builders and fakes for the sharded `/ci` runner's
 * component tests (`tests/ci-run-*.test.ts`; b.uqm SR-21.4).
 *
 * Every test of `scripts/ci-run.ts` drives the runner in process through its
 * injected dependencies (`RunnerDeps`), and takes those fakes and the files it
 * reads from here. Rules:
 *
 * - No test hand-writes a status file, reservation, results file, result-file
 *   line or verdict. Each is built here: a valid one through the runner's own
 *   writers and names, an invalid one from a valid one by a stated change.
 * - The helper types no runner constant or message: it imports them from
 *   `scripts/ci-run.ts`.
 * - It never starts a real child process, references a child-process function
 *   or uses `mock.module`. Children are answered by the spawn recorder and the
 *   fake container interface; time moves only on `createFakeClock`
 *   (`./fake-clock.ts`), which the runner takes as its `RunnerClock`.
 *
 * Layout. One banner per owner, in this fixed order; each lane writes only
 * under its own banner (Plan b.t6s, "One runner file"):
 *
 *    1. spawn recorder (E1 T6)
 *    2. process table, signals and `/proc` (E1 T6)
 *    3. lock probe (E1 T6)
 *    4. fake container interface (E1 T6)
 *    5. worktree builder (E1 T7)
 *    6. run-directory builder (E1 T7)
 *    7. reader additions (E3)
 *    8. lock directory and password file (E5)
 *    9. cgroups, `/ci-live` and readings (E6)
 *   10. sample sequences (E7)
 *
 * The import from the runner below also keeps `scripts/ci-run.ts` in
 * `bun run typecheck`: `tsconfig.json` includes only `src/`,
 * `tests/*.test.ts` and `tests/test-helpers/*.ts`, so the runner is checked
 * only through a file that imports it. Keep at least one import from it.
 *
 * SPDX-License-Identifier: MIT
 */

// The typecheck anchor (see above); each lane adds the names it uses, one per line.
import {
  atomicTempFileName,
  BASE_DOCKERFILE_PATH,
  BUILD_PROGRESS_OPTION,
  buildRefusal,
  buildRefusedStatus,
  buildStatus,
  CANARY_FILE_NAME,
  CANARY_LENGTH,
  CI_REQUIRES_KEYWORD,
  compareCanonical,
  CONTAINER_ID_PATTERN,
  CONTAINER_INSPECTION_FORMAT,
  CONTAINER_STATE_FORMAT,
  containerCopyOutArgs,
  containerCreateArgs,
  containerInspectionArgs,
  containerKillArgs,
  containerListArgs,
  containerLogsArgs,
  containerRemoveArgs,
  containerRunArgs,
  containerStateInspectArgs,
  createRunnerLog,
  DEPENDENCY_FINGERPRINT_FILE_NAME,
  derivedImageBuildArgs,
  derivedImageDockerfile,
  DOCKER_LOG_FILE_NAME,
  DOCKER_NO_SUCH_CONTAINER_TEXT,
  DOCKER_NO_SUCH_IMAGE_TEXT,
  DOCKER_PROGRAM,
  dockerAnswersArgs,
  DURATION_TABLE_PATH,
  fileNameNumber,
  formatHexRecord,
  formatResultFile,
  formatResultLine,
  formatRunnerLogFirstLine,
  formatRunTag,
  IMAGE_ID_PATTERN,
  IMAGE_INSPECT_FORMAT,
  imageInspectArgs,
  imageListArgs,
  imagePruneArgs,
  imageTagArgs,
  imageTagRemovalArgs,
  INTEGRATION_DIR_PATH,
  isScriptFileName,
  MAX_SHARDS,
  numberFormOf,
  OWNER_LABEL,
  PACKAGE_SHA256_FILE_NAME,
  parseResultLine,
  parseResults,
  parseRunTag,
  PRUNE_ALREADY_RUNNING_TEXT,
  RESULT_FILE_NAME,
  RESULTS_FILE_NAME,
  RESULTS_FORMAT_VERSION,
  RUN_DIR_MODE,
  RUN_DIR_PREFIX,
  RUN_TAG_ROLES,
  runDirPath,
  RUNNER_LOG_FILE_NAME,
  RUNNER_PATH_SUFFIX,
  SCRIPT_LOG_SUFFIX,
  serializeResults,
  serializeStatus,
  SHA256_HEX_LENGTH,
  SHARD_DIR_PREFIX,
  SHARD_MEMORY_CAP_BYTES,
  SIGNAL_EXIT_STATUS_BASE,
  sortCanonical,
  SPAWN_FAILED_EXIT_STATUS,
  STATUS_FILE_NAME,
  statusDeadline,
  TEST_DOCKERFILE_PATH,
  testImageBuildArgs,
  UNREADABLE_READING,
  VERDICT_FILE_NAME,
  writeStatusFile,
  writeVerdictFile,
  writeWholeFile,
  type ImageListFilter,
  type ProcRead,
  type RefusalKind,
  type ResultEvent,
  type Results,
  type RunnerClock,
  type RunnerDeps,
  type RunStatus,
  type RunTagRole,
  type SentSignal,
  type SignalOutcome,
  type SignalTarget,
  type SpawnFn,
  type SpawnRequest,
  type SpawnResult,
  type StatusPhase,
  type TrappedSignal,
  type Unreadable,
  type WriteResult,
} from '../../scripts/ci-run.ts'
// Libc's flock for the lock probe (section 3).
import { dlopen, FFIType } from 'bun:ffi'
import { createHash } from 'node:crypto'
// File writes and reads under a caller's root (sections 1, 4, 5 and 6).
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
// Signal numbers (section 1's exit statuses).
import { constants as osConstants } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from 'node:path'

// ---------------------------------------------------------------------------
// 1. Spawn recorder (E1 T6)
// ---------------------------------------------------------------------------
//
// `createSpawnRecorder` gives the runner's `spawn` dependency and keeps every
// spawn in order: its argument list, a copy of its environment, its working
// directory, whether it was started in a process group of its own and its
// standard input (b.uqm SR-15.4, SR-21.4). Each child is answered from:
//
// 1. scripted answers (`answer` by exact argument list, `answerWhen` by
//    predicate), the most recently added first, each for a number of spawns
//    or for every one;
// 2. responders, in the order added (the fake container interface, section 4,
//    is one: it claims every `docker` argument list);
// 3. the default answer (`answerOtherwise`), when one is set.
//
// A spawn none of them answers fails loudly: `spawn` throws an
// `UnscriptedSpawnError` naming its argument list, and the failure is kept
// (`failures()`, `assertNoFailures()`), since the docker layer turns a
// throwing spawn into a child that never started.
//
// A started child is a process of the shared process table (section 2): it
// has a PID, its own process group when it asked for one, its argument list
// as its command line and its working directory. It ends by itself at once,
// after a delay or at a time on the fake clock, or never (`untilSignalled`);
// and it ends early when the signal recorder makes it, or its group, gone:
// its exit status is then 128 + the signal's number (SIGKILL: 137), and only
// the lines it wrote before (`earlyLines`) are in its output. Output lines go
// to the request's `onOutputLine` as the real binding sends them, each line of
// standard output and standard error. A side effect writes files only under
// the root the test gives the recorder. No real process is ever started.

/** The exit status of a child that `signal` ended: 128 + the signal's number (SIGKILL: 137; SIGTERM: 143). */
export function signalExitStatus(signal: SentSignal): number {
  return SIGNAL_EXIT_STATUS_BASE + osConstants.signals[signal]
}

/** File writes for a side effect, held under one constructed root. */
export interface SideEffectFiles {
  /** The root's real path; every write stays under it. */
  readonly root: string
  /** Writes a file (absolute, or relative to the root), making its parent directories; answers its absolute path. A path outside the root, or through a symbolic link, throws. */
  writeFile(path: string, content: string | Uint8Array): string
  /** Makes a directory and its parents under the root; answers its absolute path. */
  makeDirectory(path: string): string
}

/** How a child ended, as its answer's `onEnd` hears it. */
export interface SpawnEnding {
  /** The signal that ended it; null when it ended by itself. */
  readonly signal: SentSignal | null
  /** The fake-clock time it ended. */
  readonly atMs: number
}

/** What an answer's `onEnd` may change in a child that ended by itself. */
export interface SpawnEndOverride {
  readonly exitCode?: number
  readonly stdout?: string | Uint8Array
  readonly stderr?: string
}

/** A started child, as its answer's `onStart` hears it. */
export interface SpawnStart {
  readonly pid: number
  readonly processGroup: number | null
}

/** One child's answer. Every field is optional: by default it exits 0 at once, with no output. */
export interface SpawnAnswer {
  /** Its exit status when it ends by itself (default 0). */
  readonly exitCode?: number
  /** Its standard output: text or bytes (a `docker cp` archive). */
  readonly stdout?: string | Uint8Array
  /** Its standard error. */
  readonly stderr?: string
  /** Lines it writes to standard error as soon as it starts (a build's progress): sent to `onOutputLine` at once, and in its standard error even when a signal ends it. */
  readonly earlyLines?: readonly string[]
  /** It ends by itself this long after its spawn, on the fake clock. */
  readonly delayMs?: number
  /** It ends by itself at this fake-clock time. */
  readonly atMs?: number
  /** It never ends by itself: only a signal to it or its group ends it. */
  readonly untilSignalled?: boolean
  /** It could not be started: its PID is null, its exit status `SPAWN_FAILED_EXIT_STATUS`, and this text its standard error. */
  readonly notStarted?: string
  /** How it takes each signal (section 2); by default every signal ends it. */
  readonly signals?: SignalResponses
  /** Files it writes, under the recorder's root, when it is answered (at its spawn). */
  readonly sideEffect?: (files: SideEffectFiles, request: SpawnRequest) => void
  /** Hears its PID and process group once it is started. */
  readonly onStart?: (child: SpawnStart) => void
  /** Hears how it ended, before its result settles; for a child that ended by itself it may change its exit status and output. */
  readonly onEnd?: (ending: SpawnEnding) => SpawnEndOverride | undefined
}

/** An answer, or a function of the request that gives one. */
export type SpawnAnswerSource = SpawnAnswer | ((request: SpawnRequest) => SpawnAnswer)

/** A pluggable answerer: an answer for a request it claims, undefined for one it leaves to others. It may throw to fail a request loudly. */
export type SpawnResponder = (request: SpawnRequest) => SpawnAnswer | undefined

/** How many spawns a scripted answer serves. */
export interface SpawnAnswerOptions {
  /** Default: every matching spawn. */
  readonly times?: number
}

/** One spawn as the recorder kept it. */
export interface RecordedSpawn {
  /** Its place in spawn order, from 0. */
  readonly index: number
  readonly argv: readonly string[]
  /** A copy of the environment it was given. */
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly ownProcessGroup: boolean
  /** The text written to its standard input; null when none. */
  readonly stdin: string | null
  /** The fake-clock time of its spawn. */
  readonly atMs: number
  /** Its PID; null when it was not started (unscripted, or answered `notStarted`). */
  readonly pid: number | null
  /** Its own process group; null when it has none. */
  readonly processGroup: number | null
  /** Its result, as the runner awaits it. */
  readonly result: Promise<SpawnResult>
}

/** A spawn that failed loudly: unscripted, or its answer or side effect threw. */
export interface SpawnFailure {
  readonly argv: readonly string[]
  readonly error: string
}

/** Thrown by `spawn` for an argument list nothing answers. */
export class UnscriptedSpawnError extends Error {
  constructor(readonly argv: readonly string[]) {
    super(`spawn recorder: unscripted spawn ${JSON.stringify(argv)}`)
    this.name = 'UnscriptedSpawnError'
  }
}

export interface SpawnRecorderOptions {
  /** The clock timed answers use; pass the test's `createFakeClock()`. */
  readonly clock: RunnerClock
  /** The process table children join (section 2); by default a new one on the same clock. */
  readonly processes?: FakeProcessTable
  /** The constructed root side effects write under; a side effect with no root throws. */
  readonly root?: string
  /** The process group of a child not started in a group of its own (the runner's); default none. */
  readonly runnerProcessGroup?: number | null
}

export interface SpawnRecorder {
  /** The runner's spawn dependency (`RunnerDeps.spawn`). */
  readonly spawn: SpawnFn
  readonly clock: RunnerClock
  /** The process table its children are in. */
  readonly processes: FakeProcessTable
  /** Answers spawns whose argument list is exactly `argv`. */
  answer(argv: readonly string[], answer: SpawnAnswerSource, options?: SpawnAnswerOptions): void
  /** Answers spawns the predicate accepts. */
  answerWhen(matches: (request: SpawnRequest) => boolean, answer: SpawnAnswerSource, options?: SpawnAnswerOptions): void
  /** Answers every spawn nothing else answers; unset by default, so such a spawn fails loudly. */
  answerOtherwise(answer: SpawnAnswerSource): void
  /** Adds a responder after those already added; answers its remover. */
  addResponder(responder: SpawnResponder): () => void
  /** Every spawn, in order. */
  spawns(): readonly RecordedSpawn[]
  /** Every spawn's argument list, in order. */
  argvs(): readonly (readonly string[])[]
  /** The children still running. */
  running(): readonly RecordedSpawn[]
  /** Every spawn that failed loudly, in order. */
  failures(): readonly SpawnFailure[]
  /** Throws when any spawn failed loudly, naming each. */
  assertNoFailures(): void
}

/** Whether `path` is `base` or below it. */
function isWithinPath(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

function createSideEffectFiles(root: string): SideEffectFiles {
  const given = resolve(root)
  const real = realpathSync(given)
  const refuse = (path: string): never => {
    throw new Error(`spawn recorder: a side effect writes only under ${real}; refused ${JSON.stringify(path)}`)
  }
  const place = (path: string): string => {
    const target = isAbsolute(path) ? resolve(path) : resolve(real, path)
    const mapped = !isWithinPath(target, real) && isWithinPath(target, given) ? `${real}${target.slice(given.length)}` : target
    return isWithinPath(mapped, real) ? mapped : refuse(path)
  }
  // The nearest existing ancestor's real path must stay under the root, so no symbolic link leads a write out of it.
  const checkAncestor = (target: string, path: string): void => {
    let probe = target
    while (!existsSync(probe)) probe = dirname(probe)
    if (!isWithinPath(realpathSync(probe), real)) refuse(path)
  }
  const isSymbolicLink = (target: string): boolean => {
    try {
      return lstatSync(target).isSymbolicLink()
    } catch {
      return false
    }
  }
  return {
    root: real,
    writeFile(path, content) {
      const target = place(path)
      if (target === real || isSymbolicLink(target)) refuse(path)
      checkAncestor(dirname(target), path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      return target
    },
    makeDirectory(path) {
      const target = place(path)
      checkAncestor(target, path)
      mkdirSync(target, { recursive: true })
      return target
    },
  }
}

/** Text as bytes. */
function textBytes(text: string | Uint8Array): Uint8Array {
  return typeof text === 'string' ? new TextEncoder().encode(text) : text
}

/** Text's lines, without the empty piece after a final line feed. */
function textLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Lines as text, each with its line feed. */
function linesText(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('')
}

/** Whether two argument lists are the same. */
function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, index) => arg === b[index])
}

/** Builds the spawn recorder. */
export function createSpawnRecorder(options: SpawnRecorderOptions): SpawnRecorder {
  const { clock } = options
  const processes = options.processes ?? createProcessTable({ clock })
  const runnerProcessGroup = options.runnerProcessGroup ?? null
  interface Rule {
    readonly matches: (request: SpawnRequest) => boolean
    readonly answer: SpawnAnswerSource
    remaining: number
  }
  const rules: Rule[] = []
  const responders: SpawnResponder[] = []
  let fallback: SpawnAnswerSource | null = null
  const records: RecordedSpawn[] = []
  const failures: SpawnFailure[] = []

  const answerOf = (source: SpawnAnswerSource, request: SpawnRequest): SpawnAnswer =>
    typeof source === 'function' ? source(request) : source

  function chooseAnswer(request: SpawnRequest): SpawnAnswer {
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i]!
      if (rule.remaining <= 0 || !rule.matches(request)) continue
      rule.remaining -= 1
      return answerOf(rule.answer, request)
    }
    for (const responder of [...responders]) {
      const answer = responder(request)
      if (answer !== undefined) return answer
    }
    if (fallback !== null) return answerOf(fallback, request)
    throw new UnscriptedSpawnError(request.argv)
  }

  function keep(request: SpawnRequest, atMs: number, pid: number | null, processGroup: number | null, result: Promise<SpawnResult>): void {
    records.push({
      index: records.length,
      argv: Object.freeze([...request.argv]),
      env: Object.freeze({ ...request.env }),
      cwd: request.cwd,
      ownProcessGroup: request.ownProcessGroup,
      stdin: request.stdin ?? null,
      atMs,
      pid,
      processGroup,
      result,
    })
  }

  function notStartedResult(why: string): Promise<SpawnResult> {
    return Promise.resolve({ exitCode: SPAWN_FAILED_EXIT_STATUS, stdout: new Uint8Array(0), stderr: why })
  }

  function runChild(request: SpawnRequest, answer: SpawnAnswer, pid: number): Promise<SpawnResult> {
    const early = [...(answer.earlyLines ?? [])]
    const deliver = (lines: readonly string[]): void => {
      const sink = request.onOutputLine
      if (sink === undefined) return
      for (const line of lines) {
        try {
          sink(line)
        } catch {
          // As the real binding: a sink that throws loses that line only.
        }
      }
    }
    return new Promise<SpawnResult>((settle) => {
      let ended = false
      let timer: unknown = null
      let stopListening = (): void => undefined
      const end = (signal: SentSignal | null): void => {
        if (ended) return
        ended = true
        stopListening()
        if (timer !== null) clock.clearTimeout(timer)
        const override = answer.onEnd?.({ signal, atMs: clock.now() }) ?? {}
        if (signal !== null) {
          settle({ exitCode: signalExitStatus(signal), stdout: new Uint8Array(0), stderr: linesText(early) })
          return
        }
        const stdout = textBytes(override.stdout ?? answer.stdout ?? '')
        const stderr = override.stderr ?? answer.stderr ?? ''
        deliver(textLines(new TextDecoder().decode(stdout)))
        deliver(textLines(stderr))
        processes.makeGone(pid, null)
        settle({ exitCode: override.exitCode ?? answer.exitCode ?? 0, stdout, stderr: `${linesText(early)}${stderr}` })
      }
      // Made gone from outside (a signal, or a time): a gone child without a signal ends as SIGKILL ends it.
      stopListening = processes.onGone(pid, (cause) => end(cause ?? 'SIGKILL'))
      queueMicrotask(() => deliver(early))
      if (answer.untilSignalled === true) return
      const delay = answer.atMs !== undefined ? answer.atMs - clock.now() : (answer.delayMs ?? 0)
      if (delay > 0) timer = clock.setTimeout(() => end(null), delay)
      else queueMicrotask(() => end(null))
    })
  }

  const spawn: SpawnFn = (request) => {
    const atMs = clock.now()
    let answer: SpawnAnswer
    try {
      answer = chooseAnswer(request)
      if (answer.sideEffect !== undefined) {
        if (options.root === undefined) throw new Error('spawn recorder: a side-effect answer needs the recorder to have a root')
        answer.sideEffect(createSideEffectFiles(options.root), request)
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      failures.push({ argv: Object.freeze([...request.argv]), error })
      keep(request, atMs, null, null, notStartedResult(error))
      throw err
    }
    if (answer.notStarted !== undefined) {
      const result = notStartedResult(answer.notStarted)
      keep(request, atMs, null, null, result)
      return { pid: null, processGroup: null, result }
    }
    const pid = processes.allocatePid()
    const processGroup = request.ownProcessGroup ? pid : null
    processes.add({
      pid,
      argv: request.argv,
      cwd: request.cwd,
      processGroup: processGroup ?? runnerProcessGroup,
      ...(answer.signals === undefined ? {} : { signals: answer.signals }),
    })
    const result = runChild(request, answer, pid)
    keep(request, atMs, pid, processGroup, result)
    answer.onStart?.({ pid, processGroup })
    return { pid, processGroup, result }
  }

  return {
    spawn,
    clock,
    processes,
    answer(argv, answer, answerOptions = {}) {
      const expected = [...argv]
      rules.push({ matches: (request) => sameArgs(request.argv, expected), answer, remaining: answerOptions.times ?? Infinity })
    },
    answerWhen(matches, answer, answerOptions = {}) {
      rules.push({ matches, answer, remaining: answerOptions.times ?? Infinity })
    },
    answerOtherwise(answer) {
      fallback = answer
    },
    addResponder(responder) {
      responders.push(responder)
      return () => {
        const at = responders.indexOf(responder)
        if (at >= 0) responders.splice(at, 1)
      }
    },
    spawns: () => [...records],
    argvs: () => records.map((record) => record.argv),
    running: () => records.filter((record) => record.pid !== null && processes.get(record.pid)?.alive === true),
    failures: () => [...failures],
    assertNoFailures() {
      if (failures.length > 0) {
        throw new Error(`spawn recorder: ${failures.length} spawn(s) failed loudly:\n${failures.map((f) => `  ${JSON.stringify(f.argv)}: ${f.error}`).join('\n')}`)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 2. Process table, signals and /proc (E1 T6)
// ---------------------------------------------------------------------------
//
// One fake process table per test (`createProcessTable`). The liveness
// dependency and the three `/proc` reads all answer from it (`deps()`), so a
// process made gone, by a signal or at a time, reads gone to each of them.
// Each process carries its command line, its working directory and its cgroup
// membership line (`0::<path>`), for owners (b.uqm SR-6.3), `/ci-live`'s
// `isLiveRunnerPid` and E6's container figures. A PID can be reused: adding a
// process on a gone PID replaces it, as after a VM reboot.
//
// The builders give a `/ci` runner with a given RUN_ID (its command line from
// the runner's own `RUNNER_PATH_SUFFIX`), a `/ci-live` runner in either form
// `ci-live/lib/run-lock.ts` judges, or another program.
//
// The signal recorder (`createSignalRecorder`) is the runner's `sendSignal`:
// it keeps every signal with its PID or process group, and delivers it only
// through the table. A process may die on it, die a while after it, or ignore
// it; a process the runner may not signal answers `not-permitted`; a PID or
// group with no live process answers `no-such-process`. The signal source
// (`createSignalSource`) is the runner's `onSignal`: it delivers SIGINT,
// SIGTERM or SIGHUP to the registered handlers, now or at a fake-clock time.
// Nothing here sends a real signal or reads the real `/proc`.

/** A `/proc` entry the fake answers. */
export type ProcEntry = 'cmdline' | 'cwd' | 'cgroup'

/** How a process takes one signal: it dies of it, it dies of it after a while, or it ignores it. */
export type SignalResponse =
  | 'dies'
  | 'ignores'
  | {
      readonly diesAfterMs: number
    }

/** How a process takes each signal; a signal not listed kills it. */
export type SignalResponses = Readonly<Partial<Record<SentSignal, SignalResponse>>>

/** Why a process went: the signal that killed it, or null (it exited, or was made gone at a time). */
export type GoneCause = SentSignal | null

/** A process to add to the table. */
export interface FakeProcessSpec {
  /** Its PID; by default the table picks one. */
  readonly pid?: number
  /** Its command line as its argument list. */
  readonly argv: readonly string[]
  /** Its working directory (default `/`). */
  readonly cwd?: string
  /** Its cgroup membership line, `0::<path>` (default `0::/`). */
  readonly cgroup?: string
  /** Its process group; null for none of interest (default). */
  readonly processGroup?: number | null
  /** Whether it is alive (default true); a gone one reads gone everywhere. */
  readonly alive?: boolean
  /** Whether the runner may signal it (default true); false answers `not-permitted`, as another user's process does. */
  readonly permitted?: boolean
  /** How it takes each signal (default: every signal kills it). */
  readonly signals?: SignalResponses
  /** `/proc` entries that cannot be read while it lives (each answers `unreadable`). */
  readonly unreadable?: readonly ProcEntry[]
  /** It goes at this fake-clock time. */
  readonly goneAtMs?: number
}

/** Options shared by the process builders: everything but the command line. */
export type FakeProcessOptions = Omit<FakeProcessSpec, 'argv'>

/** A process as the table holds it. */
export interface FakeProcess {
  readonly pid: number
  readonly argv: readonly string[]
  readonly cwd: string
  readonly cgroup: string
  readonly processGroup: number | null
  readonly permitted: boolean
  readonly signals: SignalResponses
  readonly unreadable: readonly ProcEntry[]
  readonly alive: boolean
  /** Why it went; undefined while it lives. */
  readonly goneBy: GoneCause | undefined
}

/** The liveness dependency and the three `/proc` reads, from the table. */
export type FakeProcessDeps = Pick<RunnerDeps, 'isPidAlive' | 'readProcCmdline' | 'readProcCwd' | 'readProcCgroup'>

export interface FakeProcessTable {
  /** Adds a process (replacing a gone one on the same PID); answers its PID. A live PID cannot be added twice. */
  add(spec: FakeProcessSpec): number
  /** A process, alive or gone. */
  get(pid: number): FakeProcess | undefined
  /** Every process, alive or gone, in PID order. */
  list(): readonly FakeProcess[]
  /** The live processes of a process group. */
  groupMembers(processGroup: number): readonly number[]
  /** Makes a process gone now; a gone or unknown PID is left as it is. */
  makeGone(pid: number, cause?: GoneCause): void
  /** Makes a process gone at a fake-clock time. */
  goneAt(pid: number, atMs: number): void
  /** Hears a process go; answers its remover. */
  onGone(pid: number, listener: (cause: GoneCause) => void): () => void
  /** A PID no process has used. */
  allocatePid(): number
  /** The runner's liveness and `/proc` dependencies over this table. */
  deps(): FakeProcessDeps
}

/** The first PID the table hands out. */
const FIRST_FAKE_PID = 41_000
/** A process's cgroup membership line when none is given: the namespace root. */
const DEFAULT_FAKE_CGROUP_LINE = '0::/'

/** Builds a process table; `clock` is needed only for processes that go at a time. */
export function createProcessTable(options: { readonly clock?: RunnerClock } = {}): FakeProcessTable {
  interface Entry {
    pid: number
    argv: readonly string[]
    cwd: string
    cgroup: string
    processGroup: number | null
    permitted: boolean
    signals: SignalResponses
    unreadable: readonly ProcEntry[]
    alive: boolean
    goneBy: GoneCause | undefined
    listeners: Set<(cause: GoneCause) => void>
  }
  const entries = new Map<number, Entry>()
  let nextPid = FIRST_FAKE_PID

  const snapshot = (entry: Entry): FakeProcess => ({
    pid: entry.pid,
    argv: entry.argv,
    cwd: entry.cwd,
    cgroup: entry.cgroup,
    processGroup: entry.processGroup,
    permitted: entry.permitted,
    signals: entry.signals,
    unreadable: entry.unreadable,
    alive: entry.alive,
    goneBy: entry.goneBy,
  })

  const isProcessId = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0

  function allocatePid(): number {
    while (entries.has(nextPid)) nextPid += 1
    return nextPid++
  }

  function makeGone(pid: number, cause: GoneCause = null): void {
    const entry = entries.get(pid)
    if (entry === undefined || !entry.alive) return
    entry.alive = false
    entry.goneBy = cause
    const listeners = [...entry.listeners]
    entry.listeners.clear()
    for (const listener of listeners) listener(cause)
  }

  function goneAt(pid: number, atMs: number): void {
    const clock = options.clock
    if (clock === undefined) throw new Error('process table: a process that goes at a time needs the table to have a clock')
    clock.setTimeout(() => makeGone(pid, null), Math.max(0, atMs - clock.now()))
  }

  function procRead<T>(pid: number, entryName: ProcEntry, value: (entry: Entry) => T): ProcRead<T> {
    if (!isProcessId(pid)) return { kind: 'unreadable', error: `not a PID: ${pid}` }
    const entry = entries.get(pid)
    if (entry === undefined || !entry.alive) return { kind: 'gone' }
    if (entry.unreadable.includes(entryName)) return { kind: 'unreadable', error: `fake /proc: ${entryName} of PID ${pid} cannot be read` }
    return { kind: 'value', value: value(entry) }
  }

  const processDeps: FakeProcessDeps = {
    isPidAlive: (pid) => isProcessId(pid) && entries.get(pid)?.alive === true,
    readProcCmdline: (pid) => procRead(pid, 'cmdline', (entry) => [...entry.argv]),
    readProcCwd: (pid) => procRead(pid, 'cwd', (entry) => entry.cwd),
    readProcCgroup: (pid) => procRead(pid, 'cgroup', (entry) => entry.cgroup),
  }

  return {
    add(spec) {
      const pid = spec.pid ?? allocatePid()
      if (!isProcessId(pid)) throw new Error(`process table: not a PID: ${pid}`)
      if (entries.get(pid)?.alive === true) throw new Error(`process table: PID ${pid} is already a live process`)
      const alive = spec.alive ?? true
      entries.set(pid, {
        pid,
        argv: Object.freeze([...spec.argv]),
        cwd: spec.cwd ?? '/',
        cgroup: spec.cgroup ?? DEFAULT_FAKE_CGROUP_LINE,
        processGroup: spec.processGroup ?? null,
        permitted: spec.permitted ?? true,
        signals: spec.signals ?? {},
        unreadable: Object.freeze([...(spec.unreadable ?? [])]),
        alive,
        goneBy: alive ? undefined : null,
        listeners: new Set(),
      })
      if (alive && spec.goneAtMs !== undefined) goneAt(pid, spec.goneAtMs)
      return pid
    },
    get(pid) {
      const entry = entries.get(pid)
      return entry === undefined ? undefined : snapshot(entry)
    },
    list: () => [...entries.values()].sort((a, b) => a.pid - b.pid).map(snapshot),
    groupMembers: (processGroup) =>
      [...entries.values()].filter((entry) => entry.alive && entry.processGroup === processGroup).map((entry) => entry.pid),
    makeGone,
    goneAt,
    onGone(pid, listener) {
      const entry = entries.get(pid)
      if (entry === undefined || !entry.alive) return () => undefined
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
      }
    },
    allocatePid,
    deps: () => processDeps,
  }
}

/** The program a runner's command line starts with: test data, the interpreter both runners are started under. */
const RUNNER_INTERPRETER = 'bun'

/** The worktree root a fake runner process uses when its caller gives none: test data. */
const DEFAULT_FAKE_WORKTREE_ROOT = '/home/ci/worktree'

// The `/ci-live` runner's directory and entry file, as `isLiveRunnerPid`
// (`ci-live/lib/run-lock.ts`) judges them. E6 adds the runner's own copies;
// until then they live here, once, and each is replaced by its export when it
// lands.
const CI_LIVE_DIR_NAME = 'ci-live'
const CI_LIVE_ENTRY_FILE_NAME = 'run.ts'

/** A `/ci` runner process: `bun <worktree>/scripts/ci-run.ts <RUN_ID> [args]...`, the command line a live owner holds (b.uqm SR-6.3). */
export function ciRunnerProcess(
  runId: string,
  options: FakeProcessOptions & { readonly worktreeRoot?: string; readonly args?: readonly string[] } = {},
): FakeProcessSpec {
  const { worktreeRoot = DEFAULT_FAKE_WORKTREE_ROOT, args = [], ...rest } = options
  return { cwd: worktreeRoot, ...rest, argv: [RUNNER_INTERPRETER, join(worktreeRoot, RUNNER_PATH_SUFFIX), runId, ...args] }
}

/**
 * A `/ci-live` runner process, in either form `isLiveRunnerPid`
 * (`ci-live/lib/run-lock.ts`) judges: `path`, `bun ci-live/run.ts ...` from
 * any directory; or `bare`, `bun run.ts ...` from a working directory ending
 * in `/ci-live`.
 */
export function ciLiveRunnerProcess(
  options: FakeProcessOptions & { readonly form?: 'path' | 'bare'; readonly worktreeRoot?: string; readonly args?: readonly string[] } = {},
): FakeProcessSpec {
  const { form = 'path', worktreeRoot = DEFAULT_FAKE_WORKTREE_ROOT, args = [], ...rest } = options
  const ciLiveDir = join(worktreeRoot, CI_LIVE_DIR_NAME)
  if (form === 'bare') return { cwd: ciLiveDir, ...rest, argv: [RUNNER_INTERPRETER, CI_LIVE_ENTRY_FILE_NAME, ...args] }
  return { cwd: worktreeRoot, ...rest, argv: [RUNNER_INTERPRETER, join(CI_LIVE_DIR_NAME, CI_LIVE_ENTRY_FILE_NAME), ...args] }
}

/** Another program's process. */
export function otherProcess(argv: readonly string[], options: FakeProcessOptions = {}): FakeProcessSpec {
  return { ...options, argv }
}

/**
 * A live process of the table takes `signal` as its `signals` say: it is made
 * gone of it now (`dies`, the default), a while after (`diesAfterMs`, on
 * `clock`), or not at all (`ignores`). The one place a signal acts on a
 * process: the signal recorder and the fake container interface's kill
 * (section 4) both deliver through it.
 */
function takeSignal(processes: FakeProcessTable, clock: RunnerClock, pid: number, signal: SentSignal): void {
  const response = processes.get(pid)?.signals[signal] ?? 'dies'
  if (response === 'dies') processes.makeGone(pid, signal)
  else if (response !== 'ignores') clock.setTimeout(() => processes.makeGone(pid, signal), response.diesAfterMs)
}

/** One signal as the recorder kept it. */
export interface RecordedSignal {
  /** Its place in send order, from 0. */
  readonly index: number
  readonly target: SignalTarget
  readonly signal: SentSignal
  readonly atMs: number
  /** What `sendSignal` answered. */
  readonly outcome: SignalOutcome
  /** The PIDs it was delivered to. */
  readonly reached: readonly number[]
}

export interface SignalRecorder {
  /** The runner's `sendSignal` dependency. */
  readonly sendSignal: RunnerDeps['sendSignal']
  /** Every signal sent, in order. */
  signals(): readonly RecordedSignal[]
}

/**
 * Builds the signal recorder over a process table. A signal to a PID reaches
 * that live process; one to a group reaches every live member. It answers
 * `no-such-process` when nothing live is there (an ID of 0 or below
 * included, as the real binding refuses it), `not-permitted` when every
 * process there refuses the runner, and `delivered` otherwise; each process
 * reached then takes the signal as its `signals` say.
 */
export function createSignalRecorder(options: { readonly processes: FakeProcessTable; readonly clock: RunnerClock }): SignalRecorder {
  const { processes, clock } = options
  const records: RecordedSignal[] = []
  return {
    sendSignal(target, signal) {
      const id = target.kind === 'pid' ? target.pid : target.processGroup
      let present: readonly number[] = []
      if (Number.isSafeInteger(id) && id > 0) {
        present = target.kind === 'pid' ? (processes.get(id)?.alive === true ? [id] : []) : processes.groupMembers(id)
      }
      const reached = present.filter((pid) => processes.get(pid)?.permitted === true)
      const outcome: SignalOutcome = present.length === 0 ? 'no-such-process' : reached.length === 0 ? 'not-permitted' : 'delivered'
      records.push({ index: records.length, target: { ...target }, signal, atMs: clock.now(), outcome, reached: Object.freeze([...reached]) })
      for (const pid of reached) takeSignal(processes, clock, pid, signal)
      return outcome
    },
    signals: () => [...records],
  }
}

/** One delivery by the signal source. */
export interface SourcedSignal {
  readonly signal: TrappedSignal
  readonly atMs: number
  /** The handlers it reached. */
  readonly handlers: number
}

export interface SignalSource {
  /** The runner's `onSignal` dependency. */
  readonly onSignal: RunnerDeps['onSignal']
  /** Delivers a signal now to every handler registered for it; answers how many it reached. */
  deliver(signal: TrappedSignal): number
  /** Delivers a signal at a fake-clock time. */
  deliverAt(signal: TrappedSignal, atMs: number): void
  /** The handlers registered, for one signal or for all. */
  handlerCount(signal?: TrappedSignal): number
  /** Every delivery, in order. */
  delivered(): readonly SourcedSignal[]
}

/** Builds the signal source: handlers live in this object only, and no real signal is ever sent or trapped. */
export function createSignalSource(options: { readonly clock: RunnerClock }): SignalSource {
  const { clock } = options
  const handlers = new Map<TrappedSignal, ((signal: TrappedSignal) => void)[]>()
  const deliveries: SourcedSignal[] = []
  const deliver = (signal: TrappedSignal): number => {
    const reached = [...(handlers.get(signal) ?? [])]
    deliveries.push({ signal, atMs: clock.now(), handlers: reached.length })
    for (const handler of reached) handler(signal)
    return reached.length
  }
  return {
    onSignal(signal, handler) {
      const list = handlers.get(signal) ?? []
      // A wrapper per registration, so one handler registered twice is removed once per remover.
      const registered = (received: TrappedSignal): void => handler(received)
      list.push(registered)
      handlers.set(signal, list)
      return () => {
        const at = list.indexOf(registered)
        if (at >= 0) list.splice(at, 1)
      }
    },
    deliver,
    deliverAt(signal, atMs) {
      clock.setTimeout(() => deliver(signal), Math.max(0, atMs - clock.now()))
    },
    handlerCount: (signal) =>
      signal === undefined ? [...handlers.values()].reduce((sum, list) => sum + list.length, 0) : (handlers.get(signal)?.length ?? 0),
    delivered: () => [...deliveries],
  }
}

// ---------------------------------------------------------------------------
// 3. Lock probe (E1 T6)
// ---------------------------------------------------------------------------
//
// Whether a file's `flock` is held, for E5 (a child the runner starts holds
// no admission lock) and E6 (the runner holds no lock on `/ci-live`'s lock
// files, PRD AC 18). On this host two descriptors opened by one process
// contend just as two processes do (b.uqm SR-6.1's note), so both the probe
// and the holder work in process, each on a fresh read-only descriptor of the
// path given, through libc's `flock` by `bun:ffi`. Neither starts a child,
// reads or writes the file's content, or changes its mode or times; opening a
// missing file throws.

/** libc's `flock` operations (`<sys/file.h>`). */
const FLOCK_EXCLUSIVE = 2
const FLOCK_NON_BLOCKING = 4
const FLOCK_UNLOCK = 8

let libcFlock: ((fd: number, operation: number) => number) | null = null

/** libc's `flock`, loaded on first use. */
function flockCall(fd: number, operation: number): number {
  if (libcFlock === null) {
    const libc = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
    libcFlock = (descriptor, op) => libc.symbols.flock(descriptor, op)
  }
  return libcFlock(fd, operation)
}

/** What the probe found. */
export type FlockState = 'free' | 'held'

/** Tries an exclusive, non-blocking `flock` on `path` from a fresh descriptor, releases it at once, and reports whether the file was free or held. */
export function probeFlock(path: string): FlockState {
  const fd = openSync(path, 'r')
  try {
    if (flockCall(fd, FLOCK_EXCLUSIVE | FLOCK_NON_BLOCKING) !== 0) return 'held'
    flockCall(fd, FLOCK_UNLOCK)
    return 'free'
  } finally {
    closeSync(fd)
  }
}

/** An exclusive `flock` held on one file until released. */
export interface FlockHolder {
  readonly path: string
  /** Releases the lock and closes the descriptor; a second call does nothing. */
  release(): void
}

/** Holds an exclusive `flock` on `path` from a fresh descriptor until released; throws when the file is already locked. */
export function holdFlock(path: string): FlockHolder {
  const fd = openSync(path, 'r')
  if (flockCall(fd, FLOCK_EXCLUSIVE | FLOCK_NON_BLOCKING) !== 0) {
    closeSync(fd)
    throw new Error(`holdFlock: ${path} is already locked`)
  }
  let released = false
  return {
    path,
    release() {
      if (released) return
      released = true
      flockCall(fd, FLOCK_UNLOCK)
      closeSync(fd)
    },
  }
}

// ---------------------------------------------------------------------------
// 4. Fake container interface (E1 T6)
// ---------------------------------------------------------------------------
//
// `createFakeDocker(recorder)` registers a responder on the spawn recorder
// that claims every `docker` argument list (b.uqm SR-21.4). It answers only
// the forms of the runner's docker layer (section 6/T4), each recognised by
// rebuilding the list with the runner's own exported builder and comparing
// them exactly; any other `docker` argument list throws, so the spawn fails
// loudly. The one shape answered beyond the builders is `docker image rm` with
// one operand that is not a run-private tag (an image ID, a digest or a
// foreign tag): the layer never builds it, but if one ever arrives the fake
// applies Docker's rules to it and records it as given.
//
// Everything is answered from constructed data: containers (running, stopped
// or created; names, labels with their image's labels, caps; a process in the
// table with a cgroup line; state readings, inspection data, logs and
// archives), images (IDs, tags, labels), builds, tag moves and prunes, and a
// failure on demand for every operation (`fail`). The answers follow the
// template keys of `CONTAINER_STATE_FORMAT`, `CONTAINER_INSPECTION_FORMAT` and
// `IMAGE_INSPECT_FORMAT` exactly, so no answer carries an environment field.
//
// Docker's image rules, as b.uqm SR-23.6 records them:
// - a build's image ID is a digest of what it was built from and its labels,
//   so two identical builds give one ID, and a build with a label of its own
//   gives another;
// - a removal by image ID is refused while two tags name the image; with one
//   tag (or none) left it removes that tag and deletes the image; refused
//   while any container, even a stopped one, uses the image;
// - a removal by tag removes that tag only; removing an image's last tag
//   deletes the image, and is refused while any container uses it;
// - `docker image tag` moves a tag, even off an image a container uses;
// - a prune filtered on one owner label removes only the untagged images that
//   carry exactly that value and that no container uses; an unfiltered prune
//   (the host's, from `startOtherPrune` with no owner) removes every untagged
//   image no container uses;
// - one image prune runs at a time: another, the runner's or one started
//   with `startOtherPrune` (another run's, or the host's), fails at once with
//   `PRUNE_ALREADY_RUNNING_TEXT` and removes nothing. A prune lasts its given
//   time on the fake clock.
//
// A digest (`<name>@sha256:<hex>`) names no image of the model: its removal
// answers "No such image", and is recorded. The operation log keeps every
// operation in order, with each removal's argument as given, each listing's
// filters, each kill's signal, each build's process group, and what each
// removal untagged and deleted.

/** A docker operation the fake answers. */
export type FakeDockerOperationKind =
  | 'version'
  | 'container-list'
  | 'container-state'
  | 'container-inspection'
  | 'container-create'
  | 'container-copy'
  | 'container-kill'
  | 'container-logs'
  | 'container-remove'
  | 'container-run'
  | 'image-inspect'
  | 'image-list'
  | 'image-remove'
  | 'image-tag'
  | 'image-build'
  | 'image-prune'

/** What an image removal's argument is. */
export type ImageRemovalArgument = 'tag' | 'id' | 'digest'

/** One operation as the fake recorded it. */
export interface FakeDockerOperation {
  /** Its place in the log, from 0. */
  readonly index: number
  readonly kind: FakeDockerOperationKind
  /** The argument list spawned; empty for a prune from `startOtherPrune`. */
  readonly argv: readonly string[]
  readonly atMs: number
  /** `runner` for a spawn; `other` for a prune from `startOtherPrune` (another run's, or the host's). */
  readonly source: 'runner' | 'other'
  /**
   * As given: the containers or images an inspect names; the container a
   * create (by name), logs, kill or removal names; `<container>:<path>` of a
   * copy; the new container's name of a run; an image removal's argument; the
   * image ID and tag of a tag move; a build's tag.
   */
  readonly refs: readonly string[]
  /** An image listing's filters, and a prune's label filter, as their texts. */
  readonly filters: readonly string[]
  /** A kill's signal; null for every other operation. */
  readonly signal: SentSignal | null
  /** What an image removal's argument is; null for every other operation. */
  readonly removalBy: ImageRemovalArgument | null
  /** A build's process group; null for every other operation. */
  readonly processGroup: number | null
  /** Its exit status; null while it runs. */
  readonly exitCode: number | null
  /** The tags an image removal removed. */
  readonly untagged: readonly string[]
  /** The image IDs an image removal or a prune deleted. */
  readonly deleted: readonly string[]
}

/** An image to add. */
export interface FakeImageSpec {
  /** Its ID, `sha256:<64 hex>`; by default a new one. */
  readonly id?: string
  /** Its tags (`name` alone means `name:latest`); each moves off any image that had it. */
  readonly tags?: readonly string[]
  readonly labels?: Readonly<Record<string, string>>
  /** The archives `docker container cp` gives for a container made from it, by absolute path in the container. */
  readonly archives?: Readonly<Record<string, Uint8Array>>
}

/** An image as the fake holds it. */
export interface FakeImage {
  readonly id: string
  readonly tags: readonly string[]
  readonly labels: Readonly<Record<string, string>>
}

/** One reading of a container's state form: fields that differ from the container's own, any of them unreadable (`UNREADABLE_READING`, answered as a value the layer cannot parse). */
export interface FakeStateReading {
  readonly status?: string
  readonly running?: boolean
  readonly pid?: number | Unreadable
  readonly oomKilled?: boolean | Unreadable
  readonly exitCode?: number | Unreadable
}

/** One mount of the inspection form. */
export interface FakeInspectionMount {
  readonly source: string
  readonly target: string
  readonly rw: boolean
}

/** The inspection form's fields beyond the container's name and labels (b.uqm SR-10.5). */
export interface FakeInspection {
  readonly imageId: string
  readonly mounts: readonly FakeInspectionMount[]
  readonly networkMode: string
  readonly pidMode: string
  readonly ipcMode: string
  readonly privileged: boolean
  readonly memoryBytes: number
  readonly memorySwapBytes: number
  readonly pidsLimit: number | null
  readonly nanoCpus: number
  readonly autoRemove: boolean
}

/** A container to add. */
export interface FakeContainerSpec {
  /** Its full ID, 64 hex; by default a new one. */
  readonly id?: string
  /** Its name (a leading `/` is dropped); unique among the containers. */
  readonly name: string
  /** The image it uses, by tag or ID; its labels join the container's. */
  readonly image?: string
  /** Its own labels, over its image's. */
  readonly labels?: Readonly<Record<string, string>>
  /** Running (default) with a live process in the table, or stopped. */
  readonly running?: boolean
  /** Docker's `State.Status`; by default `running` or `exited`. */
  readonly status?: string
  readonly exitCode?: number
  readonly oomKilled?: boolean
  /** Its memory cap; 0 for none (default). */
  readonly memoryBytes?: number
  /** Each state-form read that includes it takes the next reading; the last one repeats. */
  readonly stateReadings?: readonly FakeStateReading[]
  /** Inspection fields; the rest default from the container. */
  readonly inspection?: Partial<FakeInspection>
  /** How many inspection-form reads fail before one answers (`always`: every one). */
  readonly inspectionFailures?: number | 'always'
  readonly logs?: {
    readonly stdout?: string
    readonly stderr?: string
  }
  /** Archives `docker container cp` gives, by absolute path; over its image's. */
  readonly archives?: Readonly<Record<string, Uint8Array>>
  /** Its main process while it runs: by default a new PID, cgroup line `0::/system.slice/docker-<id>.scope`. */
  readonly process?: FakeProcessOptions & {
    readonly argv?: readonly string[]
  }
}

/** A container as the fake holds it. */
export interface FakeContainer {
  readonly id: string
  readonly name: string
  readonly imageId: string | null
  readonly labels: Readonly<Record<string, string>>
  readonly status: string
  readonly running: boolean
  /** Its main process's PID while it runs; 0 otherwise. */
  readonly pid: number
  readonly exitCode: number
  readonly oomKilled: boolean
  readonly memoryBytes: number
}

/** How a running container exits: now, or at a fake-clock time. */
export interface FakeContainerExit {
  readonly exitCode: number
  readonly oomKilled?: boolean
  readonly atMs?: number
}

/** A failure on demand. */
export interface FakeDockerFailure {
  /** Default 1. */
  readonly exitCode?: number
  /** Default: a daemon error naming the operation. */
  readonly stderr?: string
  /** How many matching operations fail (default 1); `always`: every one. */
  readonly times?: number | 'always'
  /** Only argument lists it accepts fail. */
  readonly when?: (argv: readonly string[]) => boolean
}

/** A `docker run`'s answer: a start (with the container's details), or a start failure. */
export type FakeRunAnswer =
  | {
      readonly kind: 'start'
      /** Over what the fake reads from the arguments: `--name`, `--label`, `--memory` and the first argument naming a known image. */
      readonly container?: Partial<FakeContainerSpec>
    }
  | {
      readonly kind: 'fail'
      /** Default 125, as `docker run` gives for a daemon error. */
      readonly exitCode?: number
      readonly stderr?: string
      /** The failed start leaves the container created, as Docker does. */
      readonly leavesContainer?: boolean
    }

/** How a build goes. Default: built at once. */
export type FakeBuildProgram =
  | {
      readonly kind: 'built'
      /** Its image ID; by default the digest of its base or context and labels. */
      readonly imageId?: string
      readonly durationMs?: number
    }
  | {
      readonly kind: 'failed'
      /** Default 1. */
      readonly exitCode?: number
      /** Its error line. */
      readonly error?: string
      readonly durationMs?: number
    }
  | {
      /** It runs until its process group is signalled. */
      readonly kind: 'hangs'
    }

/** Which builds a program serves: by role of the run-private tag, or by tag. */
export interface FakeBuildSelector {
  readonly role?: RunTagRole
  readonly tag?: string
  /** Default 1. */
  readonly times?: number
}

export interface FakeDockerOptions {
  /** The daemon's version (default `29.7.2`, the host's, b.uqm SR-23.6). */
  readonly serverVersion?: string
  /** Each prune's duration on the fake clock (default 0). */
  readonly pruneDurationMs?: number
}

export interface FakeDocker {
  addImage(spec?: FakeImageSpec): string
  addContainer(spec: FakeContainerSpec): string
  /** An image by tag or ID, or null. */
  image(ref: string): FakeImage | null
  /** Every image, in the order made. */
  images(): readonly FakeImage[]
  /** A container by ID, name or unique ID prefix, or null. */
  container(ref: string): FakeContainer | null
  /** Every container, in the order made. */
  containers(): readonly FakeContainer[]
  /** Makes a running container exit (its process goes), now or at a time. */
  exitContainer(ref: string, exit: FakeContainerExit): void
  setServerVersion(version: string): void
  setPruneDuration(durationMs: number): void
  /** Fails the next matching operations of one kind. */
  fail(kind: FakeDockerOperationKind, failure?: FakeDockerFailure): void
  /** Answers every `docker run` from now on. */
  answerRuns(handler: (runArguments: readonly string[]) => FakeRunAnswer): void
  /** Programs the next builds the selector picks. */
  programBuild(program: FakeBuildProgram, selector?: FakeBuildSelector): void
  /**
   * Starts a prune from another client lasting `durationMs`. When it ends it
   * deletes the untagged images no container uses: with an `owner`, another
   * run's prune, only those carrying exactly that owner label; with none, the
   * host's `docker image prune -f`, every one. A test that wants only the prune
   * slot taken passes an owner value no image has. Answers false, recording it
   * as refused, while another prune runs.
   */
  startOtherPrune(options?: { readonly durationMs?: number; readonly owner?: string }): boolean
  /** Whether a prune is running. */
  isPruneRunning(): boolean
  /** Every operation, or those of one kind, in order. */
  operations(kind?: FakeDockerOperationKind): readonly FakeDockerOperation[]
  /** Every removal (image removals, prunes and container removals), in order. */
  removals(): readonly FakeDockerOperation[]
}

/** The fake daemon's default version: test data, the host's (b.uqm SR-23.6). */
const DEFAULT_FAKE_SERVER_VERSION = '29.7.2'
/** A run-private tag's RUN_ID for the sample lists the form heads are read from. */
const FORM_SAMPLE_RUN_ID = '20261008t120000z-sample01'
/** A build error line when a program gives none. */
const DEFAULT_FAKE_BUILD_ERROR = 'process "/bin/sh -c npm ci" did not complete successfully: exit code: 1'
/** The inspection form's mount keys. */
const INSPECTION_MOUNT_KEYS = ['source', 'target', 'rw'] as const

/** The fixed parts of each form, read from the runner's own builders over sample operands, so no form word is typed here. */
interface DockerFormHeads {
  readonly stateInspect: readonly string[]
  readonly inspection: readonly string[]
  readonly create: readonly string[]
  readonly nameFlag: string
  readonly labelFlag: string
  readonly copy: readonly string[]
  readonly copyTail: string
  readonly kill: readonly string[]
  readonly logs: readonly string[]
  readonly remove: readonly string[]
  readonly run: readonly string[]
  readonly imageInspect: readonly string[]
  readonly imageList: readonly string[]
  readonly filterFlag: string
  readonly danglingFilter: string
  readonly labelFilterPrefix: string
  readonly referenceFilterPrefix: string
  readonly imageRemove: readonly string[]
  readonly imageTag: readonly string[]
  readonly build: readonly string[]
  readonly fileFlag: string
  readonly tagFlag: string
  readonly stdinOperand: string
  readonly dockerfilePrefix: string
  readonly dockerfileSuffix: string
  readonly prune: readonly string[]
  readonly pruneFilterPrefix: string
}

let dockerFormHeadsCache: DockerFormHeads | null = null

function dockerFormHeads(): DockerFormHeads {
  if (dockerFormHeadsCache !== null) return dockerFormHeadsCache
  const tag = formatRunTag({ runId: FORM_SAMPLE_RUN_ID, pid: 1 }, RUN_TAG_ROLES[0])
  const imageId = `sha256:${'0'.repeat(SHA256_HEX_LENGTH)}`
  const lastOf = (args: readonly string[]): string => args[args.length - 1]!
  const before = (args: readonly string[], operand: string): string => args[args.indexOf(operand) - 1]!
  const create = containerCreateArgs('c', { k: 'v' }, 'i')
  const copy = containerCopyOutArgs('c', '/p')
  const listed = imageListArgs([{ kind: 'dangling' }, { kind: 'label', key: 'k', value: null }, { kind: 'reference', pattern: 'p' }])
  const build = testImageBuildArgs({ dockerfilePath: 'F', contextDir: 'C', labels: { k: 'v' }, tag })
  const derived = derivedImageBuildArgs({ from: tag, labels: {}, tag })
  const dockerfile = derivedImageDockerfile({ from: tag, labels: {}, tag })
  const prune = imagePruneArgs('o')
  dockerFormHeadsCache = {
    stateInspect: containerStateInspectArgs(['c']).slice(0, -1),
    inspection: containerInspectionArgs('c').slice(0, -1),
    create: create.slice(0, create.indexOf('c')),
    nameFlag: before(create, 'c'),
    labelFlag: before(create, 'k=v'),
    copy: copy.slice(0, -2),
    copyTail: lastOf(copy),
    kill: containerKillArgs('c', 'SIGKILL').slice(0, -2),
    logs: containerLogsArgs('c').slice(0, -1),
    remove: containerRemoveArgs('c').slice(0, -1),
    run: containerRunArgs([]),
    imageInspect: imageInspectArgs(['i']).slice(0, -1),
    imageList: imageListArgs([]),
    filterFlag: listed[listed.length - 6]!,
    danglingFilter: listed[listed.length - 5]!,
    labelFilterPrefix: listed[listed.length - 3]!.slice(0, -'k'.length),
    referenceFilterPrefix: lastOf(listed).slice(0, -'p'.length),
    imageRemove: imageTagRemovalArgs(tag).slice(0, -1),
    imageTag: imageTagArgs(imageId, tag).slice(0, -2),
    build: build.slice(0, build.indexOf(BUILD_PROGRESS_OPTION) + 1),
    fileFlag: before(build, 'F'),
    tagFlag: before(build, tag),
    stdinOperand: lastOf(derived),
    dockerfilePrefix: dockerfile.slice(0, dockerfile.indexOf(tag)),
    dockerfileSuffix: dockerfile.slice(dockerfile.indexOf(tag) + tag.length),
    prune: prune.slice(0, -1),
    pruneFilterPrefix: lastOf(prune).slice(0, -'o'.length),
  }
  return dockerFormHeadsCache
}

/** One recognised form, with its operands. */
type DockerForm =
  | { readonly kind: 'version' }
  | { readonly kind: 'container-list' }
  | { readonly kind: 'container-state'; readonly refs: readonly string[] }
  | { readonly kind: 'container-inspection'; readonly ref: string }
  | { readonly kind: 'container-create'; readonly name: string; readonly labels: Record<string, string>; readonly image: string }
  | { readonly kind: 'container-copy'; readonly ref: string; readonly path: string }
  | { readonly kind: 'container-kill'; readonly ref: string; readonly signal: SentSignal }
  | { readonly kind: 'container-logs'; readonly ref: string }
  | { readonly kind: 'container-remove'; readonly ref: string }
  | { readonly kind: 'container-run'; readonly runArguments: readonly string[] }
  | { readonly kind: 'image-inspect'; readonly refs: readonly string[] }
  | { readonly kind: 'image-list'; readonly filters: readonly ImageListFilter[]; readonly filterTexts: readonly string[] }
  | { readonly kind: 'image-remove'; readonly argument: string }
  | { readonly kind: 'image-tag'; readonly imageId: string; readonly tag: string }
  | {
      readonly kind: 'image-build'
      readonly tag: string
      readonly labels: Record<string, string>
      /** The test build's Dockerfile and context; null for a derived build. */
      readonly dockerfilePath: string | null
      readonly contextDir: string | null
      /** A derived build's base, from its standard input; null for the test build. */
      readonly from: string | null
    }
  | { readonly kind: 'image-prune'; readonly owner: string; readonly filter: string }

/** `--label <key>=<value>` pairs from `from`: the labels, and the index after them. */
function labelPairs(args: readonly string[], from: number, labelFlag: string): { labels: Record<string, string>; next: number } {
  const labels: Record<string, string> = {}
  let next = from
  while (args[next] === labelFlag && next + 1 < args.length) {
    const pair = args[next + 1]!
    const at = pair.indexOf('=')
    if (at <= 0) break
    labels[pair.slice(0, at)] = pair.slice(at + 1)
    next += 2
  }
  return { labels, next }
}

function parseListFilter(text: string, heads: DockerFormHeads): ImageListFilter | null {
  if (text === heads.danglingFilter) return { kind: 'dangling' }
  if (text.startsWith(heads.labelFilterPrefix)) {
    const rest = text.slice(heads.labelFilterPrefix.length)
    const at = rest.indexOf('=')
    return at < 0 ? { kind: 'label', key: rest, value: null } : { kind: 'label', key: rest.slice(0, at), value: rest.slice(at + 1) }
  }
  if (text.startsWith(heads.referenceFilterPrefix)) return { kind: 'reference', pattern: text.slice(heads.referenceFilterPrefix.length) }
  return null
}

/** The build forms: the test build and a derived build (its Dockerfile on standard input); both only in a process group of their own. */
function matchBuildForm(request: SpawnRequest, rest: readonly string[], heads: DockerFormHeads, exactly: (build: () => readonly string[]) => boolean): DockerForm | null {
  if (!request.ownProcessGroup) return null
  if (rest[0] === heads.fileFlag && rest.length >= 2) {
    const dockerfilePath = rest[1]!
    const { labels, next } = labelPairs(rest, 2, heads.labelFlag)
    if (rest[next] !== heads.tagFlag || next + 3 !== rest.length) return null
    const tag = rest[next + 1]!
    const contextDir = rest[next + 2]!
    if (!exactly(() => testImageBuildArgs({ dockerfilePath, contextDir, labels, tag }))) return null
    return { kind: 'image-build', tag, labels, dockerfilePath, contextDir, from: null }
  }
  const { labels, next } = labelPairs(rest, 0, heads.labelFlag)
  if (rest[next] !== heads.tagFlag || next + 3 !== rest.length || rest[next + 2] !== heads.stdinOperand) return null
  const tag = rest[next + 1]!
  const stdin = request.stdin ?? ''
  if (!stdin.startsWith(heads.dockerfilePrefix) || !stdin.endsWith(heads.dockerfileSuffix)) return null
  const from = stdin.slice(heads.dockerfilePrefix.length, stdin.length - heads.dockerfileSuffix.length)
  if (!exactly(() => derivedImageBuildArgs({ from, labels, tag }))) return null
  try {
    if (derivedImageDockerfile({ from, labels, tag }) !== stdin) return null
  } catch {
    return null
  }
  return { kind: 'image-build', tag, labels, dockerfilePath: null, contextDir: null, from }
}

/** The runner's docker form a request is, rebuilt exactly by its builder; null for any other argument list. */
function matchDockerForm(request: SpawnRequest): DockerForm | null {
  const { argv } = request
  const heads = dockerFormHeads()
  const exactly = (build: () => readonly string[]): boolean => {
    try {
      return sameArgs(argv, build())
    } catch {
      return false
    }
  }
  const after = (head: readonly string[]): string[] | null =>
    argv.length >= head.length && head.every((arg, index) => argv[index] === arg) ? argv.slice(head.length) : null

  if (exactly(dockerAnswersArgs)) return { kind: 'version' }
  if (exactly(containerListArgs)) return { kind: 'container-list' }
  const state = after(heads.stateInspect)
  if (state !== null && state.length > 0 && exactly(() => containerStateInspectArgs(state))) return { kind: 'container-state', refs: state }
  const inspection = after(heads.inspection)
  if (inspection?.length === 1 && exactly(() => containerInspectionArgs(inspection[0]!))) return { kind: 'container-inspection', ref: inspection[0]! }
  const create = after(heads.create)
  if (create !== null && create.length >= 2) {
    const name = create[0]!
    const { labels, next } = labelPairs(create, 1, heads.labelFlag)
    const image = create[next]
    if (image !== undefined && next === create.length - 1 && exactly(() => containerCreateArgs(name, labels, image))) {
      return { kind: 'container-create', name, labels, image }
    }
  }
  const copy = after(heads.copy)
  if (copy?.length === 2 && copy[1] === heads.copyTail) {
    const operand = copy[0]!
    const at = operand.indexOf(':')
    const ref = operand.slice(0, at)
    const path = operand.slice(at + 1)
    if (at > 0 && exactly(() => containerCopyOutArgs(ref, path))) return { kind: 'container-copy', ref, path }
  }
  const kill = after(heads.kill)
  if (kill?.length === 2) {
    const signal = kill[0] as SentSignal
    const ref = kill[1]!
    if (exactly(() => containerKillArgs(ref, signal))) return { kind: 'container-kill', ref, signal }
  }
  const logs = after(heads.logs)
  if (logs?.length === 1 && exactly(() => containerLogsArgs(logs[0]!))) return { kind: 'container-logs', ref: logs[0]! }
  const remove = after(heads.remove)
  if (remove?.length === 1 && exactly(() => containerRemoveArgs(remove[0]!))) return { kind: 'container-remove', ref: remove[0]! }
  const run = after(heads.run)
  if (run !== null && exactly(() => containerRunArgs(run))) return { kind: 'container-run', runArguments: run }
  const imageInspect = after(heads.imageInspect)
  if (imageInspect !== null && imageInspect.length > 0 && exactly(() => imageInspectArgs(imageInspect))) return { kind: 'image-inspect', refs: imageInspect }
  const list = after(heads.imageList)
  if (list !== null && list.length % 2 === 0) {
    const filters: ImageListFilter[] = []
    const filterTexts: string[] = []
    for (let i = 0; i < list.length; i += 2) {
      const filter = list[i] === heads.filterFlag ? parseListFilter(list[i + 1]!, heads) : null
      if (filter === null) return null
      filters.push(filter)
      filterTexts.push(list[i + 1]!)
    }
    if (exactly(() => imageListArgs(filters))) return { kind: 'image-list', filters, filterTexts }
  }
  const imageRemove = after(heads.imageRemove)
  if (imageRemove?.length === 1) {
    const argument = imageRemove[0]!
    // A run-private tag is exactly T4's form. Any other one operand (an ID, a digest, a foreign tag) has the same
    // shape, which T4's builder refuses to build; if one ever arrives, Docker's rules answer it and it is recorded.
    if (exactly(() => imageTagRemovalArgs(argument)) || (argument !== '' && !argument.startsWith('-'))) return { kind: 'image-remove', argument }
  }
  const imageTag = after(heads.imageTag)
  if (imageTag?.length === 2 && exactly(() => imageTagArgs(imageTag[0]!, imageTag[1]!))) return { kind: 'image-tag', imageId: imageTag[0]!, tag: imageTag[1]! }
  const prune = after(heads.prune)
  if (prune?.length === 1 && prune[0]!.startsWith(heads.pruneFilterPrefix)) {
    const owner = prune[0]!.slice(heads.pruneFilterPrefix.length)
    if (exactly(() => imagePruneArgs(owner))) return { kind: 'image-prune', owner, filter: prune[0]! }
  }
  const build = after(heads.build)
  if (build !== null) return matchBuildForm(request, build, heads, exactly)
  return null
}

/** A tag as Docker stores it: `name` alone is `name:latest`. */
function normalizeImageTag(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1).includes(':') ? ref : `${ref}:latest`
}

/** What an image reference is: a digest, an ID (full, `sha256:` and a prefix, or 12 or more hex digits), or a tag. */
function imageRefKind(ref: string): ImageRemovalArgument {
  if (ref.includes('@')) return 'digest'
  if (IMAGE_ID_PATTERN.test(ref) || /^sha256:[0-9a-f]+$/.test(ref) || /^[0-9a-f]{12,64}$/.test(ref)) return 'id'
  return 'tag'
}

/** An ID's first 12 hex digits, as Docker's messages give it. */
function shortDockerId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12)
}

/** Labels as Docker's templates give them: null when there are none. */
function labelsOrNull(labels: Readonly<Record<string, string>>): Record<string, string> | null {
  return Object.keys(labels).length === 0 ? null : { ...labels }
}

/** Whether a tag matches a `reference=` pattern: a glob on the whole tag when the pattern has a tag part, else on the repository. */
function referenceMatches(pattern: string, tag: string): boolean {
  const glob = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
  const hasTag = pattern.slice(pattern.lastIndexOf('/') + 1).includes(':')
  return glob.test(hasTag ? tag : tag.slice(0, tag.lastIndexOf(':')))
}

/** Checks that an answer has exactly the keys its form's template selects (top level, and `nested` within). */
function checkFormKeys(format: string, answer: Readonly<Record<string, unknown>>, nested: readonly string[] = []): void {
  const templateKeys = new Set([...format.matchAll(/"(\w+)":/g)].map((match) => match[1]!))
  const topLevel = [...templateKeys].filter((key) => !nested.includes(key))
  const given = Object.keys(answer)
  if (given.length !== topLevel.length || !given.every((key) => topLevel.includes(key)) || !nested.every((key) => templateKeys.has(key))) {
    throw new Error(`fake docker: answer keys ${JSON.stringify(given)} are not the form's ${JSON.stringify(topLevel)}`)
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** A byte count from `--memory`: digits with an optional b, k, m or g. */
function parseMemoryBytes(text: string | undefined): number | undefined {
  const match = /^([0-9]+)([bkmg]?)$/i.exec(text ?? '')
  if (match === null) return undefined
  const unit = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]!.toLowerCase() as '' | 'b' | 'k' | 'm' | 'g']
  return Number(match[1]) * unit
}

/** Builds the fake container interface and registers it on the spawn recorder. */
export function createFakeDocker(recorder: SpawnRecorder, options: FakeDockerOptions = {}): FakeDocker {
  const { clock, processes } = recorder
  interface ImageModel {
    readonly id: string
    tags: string[]
    readonly labels: Record<string, string>
    readonly archives: Map<string, Uint8Array>
  }
  interface ContainerModel {
    readonly id: string
    readonly name: string
    readonly imageId: string | null
    readonly labels: Record<string, string>
    status: string
    running: boolean
    exitCode: number
    oomKilled: boolean
    readonly memoryBytes: number
    readonly readings: readonly FakeStateReading[]
    readingIndex: number
    readonly inspection: Partial<FakeInspection>
    inspectionFailures: number
    readonly logs: { readonly stdout: string; readonly stderr: string }
    readonly archives: Map<string, Uint8Array>
    readonly processOptions: FakeContainerSpec['process']
    pid: number
    pendingExit: FakeContainerExit | null
  }
  interface OperationModel {
    index: number
    kind: FakeDockerOperationKind
    argv: readonly string[]
    atMs: number
    source: 'runner' | 'other'
    refs: readonly string[]
    filters: readonly string[]
    signal: SentSignal | null
    removalBy: ImageRemovalArgument | null
    processGroup: number | null
    exitCode: number | null
    untagged: readonly string[]
    deleted: readonly string[]
  }
  interface FailureRule {
    readonly kind: FakeDockerOperationKind
    remaining: number
    readonly exitCode: number
    readonly stderr: string
    readonly when: ((argv: readonly string[]) => boolean) | undefined
  }
  interface BuildRule {
    readonly program: FakeBuildProgram
    readonly selector: FakeBuildSelector
    remaining: number
  }

  let serverVersion = options.serverVersion ?? DEFAULT_FAKE_SERVER_VERSION
  let pruneDurationMs = options.pruneDurationMs ?? 0
  let pruneRunning = false
  let runHandler: ((runArguments: readonly string[]) => FakeRunAnswer) | null = null
  const images = new Map<string, ImageModel>()
  const containers = new Map<string, ContainerModel>()
  const operations: OperationModel[] = []
  const failureRules: FailureRule[] = []
  const buildRules: BuildRule[] = []
  let imageCount = 0
  let containerCount = 0

  // --- the model ---

  function newImageId(): string {
    let id: string
    do id = `sha256:${sha256Hex(`fake image ${++imageCount}`)}`
    while (images.has(id))
    return id
  }

  function newContainerId(): string {
    let id: string
    do id = sha256Hex(`fake container ${++containerCount}`)
    while (containers.has(id))
    return id
  }

  function imageById(ref: string): ImageModel | null {
    if (IMAGE_ID_PATTERN.test(ref)) return images.get(ref) ?? null
    const hex = /^(?:sha256:)?([0-9a-f]+)$/.exec(ref)?.[1]
    if (hex === undefined) return null
    const found = [...images.values()].filter((image) => image.id.startsWith(`sha256:${hex}`))
    return found.length === 1 ? found[0]! : null
  }

  function imageByTag(ref: string): ImageModel | null {
    const tag = normalizeImageTag(ref)
    return [...images.values()].find((image) => image.tags.includes(tag)) ?? null
  }

  function findImage(ref: string): ImageModel | null {
    return (imageRefKind(ref) === 'id' ? imageById(ref) : null) ?? imageByTag(ref)
  }

  function findContainer(ref: string): ContainerModel | null {
    const name = ref.startsWith('/') ? ref.slice(1) : ref
    const exact = containers.get(ref) ?? [...containers.values()].find((container) => container.name === name)
    if (exact !== undefined) return exact
    const prefixed = ref === '' ? [] : [...containers.values()].filter((container) => container.id.startsWith(ref))
    return prefixed.length === 1 ? prefixed[0]! : null
  }

  function containerUsing(imageId: string): ContainerModel | null {
    return [...containers.values()].find((container) => container.imageId === imageId) ?? null
  }

  function moveTag(tag: string, target: ImageModel): void {
    for (const image of images.values()) image.tags = image.tags.filter((held) => held !== tag)
    target.tags.push(tag)
  }

  function addImageModel(spec: FakeImageSpec): ImageModel {
    const id = spec.id ?? newImageId()
    if (!IMAGE_ID_PATTERN.test(id)) throw new Error(`fake docker: not an image ID: ${id}`)
    if (images.has(id)) throw new Error(`fake docker: image ${id} already exists`)
    const image: ImageModel = { id, tags: [], labels: { ...(spec.labels ?? {}) }, archives: new Map(Object.entries(spec.archives ?? {})) }
    images.set(id, image)
    for (const tag of spec.tags ?? []) moveTag(normalizeImageTag(tag), image)
    return image
  }

  function containerStopped(container: ContainerModel, pid: number, cause: GoneCause): void {
    if (!container.running || container.pid !== pid) return
    const exit = container.pendingExit
    container.running = false
    container.status = 'exited'
    container.pid = 0
    container.exitCode = cause !== null ? signalExitStatus(cause) : (exit?.exitCode ?? container.exitCode)
    container.oomKilled = exit?.oomKilled ?? container.oomKilled
    container.pendingExit = null
  }

  function startContainerProcess(container: ContainerModel): void {
    const processSpec: NonNullable<FakeContainerSpec['process']> = container.processOptions ?? {}
    const { argv, ...processOptions } = processSpec
    const pid = processes.add({
      cgroup: `0::/system.slice/docker-${container.id}.scope`,
      ...processOptions,
      argv: argv ?? [`fake-container:${container.name}`],
    })
    container.pid = pid
    container.running = true
    container.status = 'running'
    processes.onGone(pid, (cause) => containerStopped(container, pid, cause))
  }

  function addContainerModel(spec: FakeContainerSpec, created = false): ContainerModel {
    const image = spec.image === undefined ? null : findImage(spec.image)
    if (spec.image !== undefined && image === null) throw new Error(`fake docker: no image ${spec.image}`)
    const name = spec.name.startsWith('/') ? spec.name.slice(1) : spec.name
    if ([...containers.values()].some((container) => container.name === name)) throw new Error(`fake docker: a container is already named ${name}`)
    const id = spec.id ?? newContainerId()
    if (!CONTAINER_ID_PATTERN.test(id) || containers.has(id)) throw new Error(`fake docker: not a new container ID: ${id}`)
    const failures = spec.inspectionFailures ?? 0
    const container: ContainerModel = {
      id,
      name,
      imageId: image?.id ?? null,
      labels: { ...(image?.labels ?? {}), ...(spec.labels ?? {}) },
      status: created ? 'created' : 'exited',
      running: false,
      exitCode: spec.exitCode ?? 0,
      oomKilled: spec.oomKilled ?? false,
      memoryBytes: spec.memoryBytes ?? 0,
      readings: [...(spec.stateReadings ?? [])],
      readingIndex: 0,
      inspection: { ...(spec.inspection ?? {}) },
      inspectionFailures: failures === 'always' ? Infinity : failures,
      logs: { stdout: spec.logs?.stdout ?? '', stderr: spec.logs?.stderr ?? '' },
      archives: new Map(Object.entries(spec.archives ?? {})),
      processOptions: spec.process,
      pid: 0,
      pendingExit: null,
    }
    containers.set(id, container)
    if (!created && (spec.running ?? true)) startContainerProcess(container)
    if (spec.status !== undefined) container.status = spec.status
    return container
  }

  /** Deletes the untagged images no container uses that carry exactly this owner label, or, for null (an unfiltered prune), every one; answers their IDs. */
  function pruneUntagged(owner: string | null): string[] {
    const deleted: string[] = []
    for (const image of [...images.values()]) {
      if (image.tags.length > 0 || (owner !== null && image.labels[OWNER_LABEL] !== owner) || containerUsing(image.id) !== null) continue
      images.delete(image.id)
      deleted.push(image.id)
    }
    return deleted
  }

  const imageSnapshot = (image: ImageModel): FakeImage => ({ id: image.id, tags: [...image.tags], labels: { ...image.labels } })
  const containerSnapshot = (container: ContainerModel): FakeContainer => ({
    id: container.id,
    name: container.name,
    imageId: container.imageId,
    labels: { ...container.labels },
    status: container.status,
    running: container.running,
    pid: container.pid,
    exitCode: container.exitCode,
    oomKilled: container.oomKilled,
    memoryBytes: container.memoryBytes,
  })
  const operationSnapshot = (op: OperationModel): FakeDockerOperation => ({ ...op, refs: [...op.refs], filters: [...op.filters], untagged: [...op.untagged], deleted: [...op.deleted] })

  // --- answers ---

  const answered = (stdout: string | Uint8Array = '', stderr = ''): SpawnAnswer => ({ exitCode: 0, stdout, stderr })
  const refused = (exitCode: number, lines: readonly string[]): SpawnAnswer => ({ exitCode, stderr: linesText(lines) })
  const noSuchContainer = (ref: string): SpawnAnswer => refused(1, [`Error response from daemon: ${DOCKER_NO_SUCH_CONTAINER_TEXT}: ${ref}`])
  const noSuchImage = (ref: string): SpawnAnswer => refused(1, [`Error response from daemon: ${DOCKER_NO_SUCH_IMAGE_TEXT}: ${ref}`])

  function record(kind: FakeDockerOperationKind, argv: readonly string[], fields: Partial<OperationModel> = {}): OperationModel {
    const op: OperationModel = {
      index: operations.length,
      kind,
      argv: Object.freeze([...argv]),
      atMs: clock.now(),
      source: 'runner',
      refs: [],
      filters: [],
      signal: null,
      removalBy: null,
      processGroup: null,
      exitCode: null,
      untagged: [],
      deleted: [],
      ...fields,
    }
    operations.push(op)
    return op
  }

  function operationFields(form: DockerForm): Partial<OperationModel> {
    switch (form.kind) {
      case 'container-state':
      case 'image-inspect':
        return { refs: [...form.refs] }
      case 'container-inspection':
      case 'container-logs':
      case 'container-remove':
        return { refs: [form.ref] }
      case 'container-kill':
        return { refs: [form.ref], signal: form.signal }
      case 'container-copy':
        return { refs: [`${form.ref}:${form.path}`] }
      case 'container-create':
        return { refs: [form.name] }
      case 'image-list':
        return { filters: [...form.filterTexts] }
      case 'image-remove':
        return { refs: [form.argument], removalBy: imageRefKind(form.argument) }
      case 'image-tag':
        return { refs: [form.imageId, form.tag] }
      case 'image-build':
        return { refs: [form.tag] }
      case 'image-prune':
        return { filters: [form.filter] }
      default:
        return {}
    }
  }

  /** The answer, with the operation's exit status recorded when it ends. */
  function settledWith(op: OperationModel, answer: SpawnAnswer): SpawnAnswer {
    return {
      ...answer,
      onEnd: (ending) => {
        const override = answer.onEnd?.(ending)
        op.exitCode = ending.signal !== null ? signalExitStatus(ending.signal) : (override?.exitCode ?? answer.exitCode ?? 0)
        return override
      },
    }
  }

  function takeFailure(kind: FakeDockerOperationKind, argv: readonly string[]): FailureRule | null {
    const rule = failureRules.find((candidate) => candidate.kind === kind && candidate.remaining > 0 && (candidate.when === undefined || candidate.when(argv)))
    if (rule === undefined) return null
    rule.remaining -= 1
    return rule
  }

  function takeBuildProgram(tag: string): FakeBuildProgram {
    const role = parseRunTag(tag)?.role
    const rule = buildRules.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (candidate.selector.tag === undefined || normalizeImageTag(candidate.selector.tag) === normalizeImageTag(tag)) &&
        (candidate.selector.role === undefined || candidate.selector.role === role),
    )
    if (rule === undefined) return { kind: 'built' }
    rule.remaining -= 1
    return rule.program
  }

  function stateAnswer(container: ContainerModel): Record<string, unknown> {
    const reading: FakeStateReading = container.readings.length === 0 ? {} : container.readings[Math.min(container.readingIndex, container.readings.length - 1)]!
    container.readingIndex += 1
    const field = <T>(value: T | Unreadable | undefined, fallback: T): T | null => (value === UNREADABLE_READING ? null : (value ?? fallback))
    const answer = {
      id: container.id,
      name: `/${container.name}`,
      status: reading.status ?? container.status,
      running: reading.running ?? container.running,
      pid: field(reading.pid, container.running ? container.pid : 0),
      oomKilled: field(reading.oomKilled, container.oomKilled),
      exitCode: field(reading.exitCode, container.exitCode),
      memoryBytes: container.memoryBytes,
      labels: labelsOrNull(container.labels),
    }
    checkFormKeys(CONTAINER_STATE_FORMAT, answer)
    return answer
  }

  function inspectionAnswer(container: ContainerModel): Record<string, unknown> {
    const given = container.inspection
    const answer = {
      name: `/${container.name}`,
      imageId: given.imageId ?? container.imageId ?? '',
      mounts: (given.mounts ?? []).map((mount) => ({ source: mount.source, target: mount.target, rw: mount.rw })),
      networkMode: given.networkMode ?? 'bridge',
      pidMode: given.pidMode ?? '',
      ipcMode: given.ipcMode ?? 'private',
      privileged: given.privileged ?? false,
      memoryBytes: given.memoryBytes ?? container.memoryBytes,
      memorySwapBytes: given.memorySwapBytes ?? container.memoryBytes,
      pidsLimit: given.pidsLimit ?? null,
      nanoCpus: given.nanoCpus ?? 0,
      labels: labelsOrNull(container.labels),
      autoRemove: given.autoRemove ?? false,
    }
    checkFormKeys(CONTAINER_INSPECTION_FORMAT, answer, INSPECTION_MOUNT_KEYS)
    return answer
  }

  function imageAnswer(image: ImageModel): Record<string, unknown> {
    const answer = { id: image.id, tags: image.tags.length === 0 ? null : [...image.tags], labels: labelsOrNull(image.labels) }
    checkFormKeys(IMAGE_INSPECT_FORMAT, answer)
    return answer
  }

  /** The `docker run` details the fake reads from the arguments when the handler gives none. */
  function runArgumentDetails(runArguments: readonly string[]): Partial<FakeContainerSpec> & { labels: Record<string, string> } {
    const heads = dockerFormHeads()
    const labels: Record<string, string> = {}
    let name: string | undefined
    let memoryBytes: number | undefined
    let image: string | undefined
    const optionValue = (flag: string, index: number): { value: string | undefined; skip: number } | null => {
      const arg = runArguments[index]!
      if (arg === flag) return { value: runArguments[index + 1], skip: 1 }
      if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), skip: 0 }
      return null
    }
    for (let i = 0; i < runArguments.length; i++) {
      const nameValue = optionValue(heads.nameFlag, i)
      const labelValue = optionValue(heads.labelFlag, i)
      const memoryValue = optionValue('--memory', i)
      if (nameValue !== null) {
        name = nameValue.value
        i += nameValue.skip
      } else if (labelValue !== null) {
        const pair = labelValue.value ?? ''
        const at = pair.indexOf('=')
        if (at > 0) labels[pair.slice(0, at)] = pair.slice(at + 1)
        i += labelValue.skip
      } else if (memoryValue !== null) {
        memoryBytes = parseMemoryBytes(memoryValue.value)
        i += memoryValue.skip
      } else if (image === undefined && !runArguments[i]!.startsWith('-') && findImage(runArguments[i]!) !== null) {
        image = runArguments[i]!
      }
    }
    return {
      labels,
      ...(name === undefined ? {} : { name }),
      ...(memoryBytes === undefined ? {} : { memoryBytes }),
      ...(image === undefined ? {} : { image }),
    }
  }

  function answerRun(op: OperationModel, runArguments: readonly string[]): SpawnAnswer {
    const answer: FakeRunAnswer = runHandler === null ? { kind: 'start' } : runHandler(runArguments)
    const read = runArgumentDetails(runArguments)
    const given = answer.kind === 'start' ? (answer.container ?? {}) : {}
    const name = given.name ?? read.name ?? `fake_run_${operations.length}`
    const spec: FakeContainerSpec = { ...read, ...given, name, labels: { ...read.labels, ...(given.labels ?? {}) } }
    const holder = findContainer(name)
    if (holder !== null && holder.name === name.replace(/^\//, '')) {
      return refused(125, [
        `docker: Error response from daemon: Conflict. The container name "/${holder.name}" is already in use by container "${holder.id}". You have to remove (or rename) that container to be able to reuse that name.`,
      ])
    }
    if (spec.image !== undefined && findImage(spec.image) === null) return refused(125, [`docker: Error response from daemon: ${DOCKER_NO_SUCH_IMAGE_TEXT}: ${spec.image}`])
    op.refs = [spec.name]
    if (answer.kind === 'fail') {
      if (answer.leavesContainer === true) addContainerModel(spec, true)
      return refused(answer.exitCode ?? 125, [answer.stderr ?? 'docker: Error response from daemon: failed to start the container (fake start failure).'])
    }
    const container = addContainerModel({ ...spec, running: true })
    return answered(`${container.id}\n`)
  }

  function answerImageRemoval(op: OperationModel, argument: string): SpawnAnswer {
    const by = imageRefKind(argument)
    const image = by === 'digest' ? null : by === 'id' ? imageById(argument) : imageByTag(argument)
    if (image === null) return noSuchImage(argument)
    const user = containerUsing(image.id)
    const untagged: string[] = []
    if (by === 'id') {
      if (image.tags.length > 1) {
        return refused(1, [`Error response from daemon: conflict: unable to delete ${shortDockerId(image.id)} (must be forced) - image is referenced in multiple repositories`])
      }
      if (user !== null) {
        const how = user.running ? 'cannot be forced) - image is being used by running' : 'must be forced) - image is being used by stopped'
        return refused(1, [`Error response from daemon: conflict: unable to delete ${shortDockerId(image.id)} (${how} container ${shortDockerId(user.id)}`])
      }
      untagged.push(...image.tags)
    } else {
      const tag = normalizeImageTag(argument)
      if (image.tags.length <= 1 && user !== null) {
        return refused(1, [
          `Error response from daemon: conflict: unable to remove repository reference "${argument}" (must force) - container ${shortDockerId(user.id)} is using its referenced image ${shortDockerId(image.id)}`,
        ])
      }
      untagged.push(tag)
    }
    image.tags = image.tags.filter((tag) => !untagged.includes(tag))
    const deleted = image.tags.length === 0 ? [image.id] : []
    for (const id of deleted) images.delete(id)
    op.untagged = untagged
    op.deleted = deleted
    return answered(`${untagged.map((tag) => `Untagged: ${tag}\n`).join('')}${deleted.map((id) => `Deleted: ${id}\n`).join('')}`)
  }

  function answerBuild(op: OperationModel, form: Extract<DockerForm, { kind: 'image-build' }>): SpawnAnswer {
    const onStart = (child: SpawnStart): void => {
      op.processGroup = child.processGroup
    }
    const base = form.from === null ? null : findImage(form.from)
    if (form.from !== null && base === null) {
      return { ...refused(1, [`#1 [internal] load metadata for ${form.from}`, `ERROR: failed to solve: ${form.from}: ${DOCKER_NO_SUCH_IMAGE_TEXT}`]), onStart }
    }
    const program = takeBuildProgram(form.tag)
    const timing: SpawnAnswer = program.kind === 'hangs' ? { untilSignalled: true } : { delayMs: program.durationMs ?? 0 }
    return {
      ...timing,
      earlyLines: [`#1 [internal] load build definition from ${form.dockerfilePath ?? 'Dockerfile'}`, '#1 DONE 0.0s'],
      onStart,
      onEnd: (ending) => {
        if (ending.signal !== null || program.kind === 'hangs') return undefined
        if (program.kind === 'failed') {
          const error = program.error ?? DEFAULT_FAKE_BUILD_ERROR
          return { exitCode: program.exitCode ?? 1, stderr: linesText([`#2 ERROR: ${error}`, `ERROR: failed to solve: ${error}`]) }
        }
        const labels = Object.entries(form.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        const source = base === null ? ['context', form.dockerfilePath, form.contextDir] : ['from', base.id]
        const id = program.imageId ?? `sha256:${sha256Hex(JSON.stringify([source, labels]))}`
        const image = images.get(id) ?? addImageModel({ id, labels: { ...(base?.labels ?? {}), ...form.labels } })
        moveTag(normalizeImageTag(form.tag), image)
        return {
          exitCode: 0,
          stderr: linesText(['#2 exporting to image', `#2 writing image ${id} done`, `#2 naming to docker.io/library/${form.tag} done`, '#2 DONE 0.0s']),
        }
      },
    }
  }

  function pruneReport(deleted: readonly string[]): string {
    const listed = deleted.length === 0 ? '' : `Deleted Images:\n${deleted.map((id) => `deleted: ${id}\n`).join('')}\n`
    return `${listed}Total reclaimed space: 0B\n`
  }

  function answerForm(form: DockerForm, op: OperationModel): SpawnAnswer {
    switch (form.kind) {
      case 'version':
        return answered(`${serverVersion}\n`)
      case 'container-list':
        return answered(linesText([...containers.keys()]))
      case 'container-state': {
        const found: string[] = []
        const missing: string[] = []
        for (const ref of form.refs) {
          const container = findContainer(ref)
          if (container === null) missing.push(`Error response from daemon: ${DOCKER_NO_SUCH_CONTAINER_TEXT}: ${ref}`)
          else found.push(JSON.stringify(stateAnswer(container)))
        }
        return { exitCode: missing.length === 0 ? 0 : 1, stdout: linesText(found), stderr: linesText(missing) }
      }
      case 'container-inspection': {
        const container = findContainer(form.ref)
        if (container === null) return noSuchContainer(form.ref)
        if (container.inspectionFailures > 0) {
          container.inspectionFailures -= 1
          return refused(1, [`Error response from daemon: fake inspection failure of ${form.ref}`])
        }
        return answered(`${JSON.stringify(inspectionAnswer(container))}\n`)
      }
      case 'container-create': {
        const image = findImage(form.image)
        if (image === null) return refused(1, [`Error response from daemon: ${DOCKER_NO_SUCH_IMAGE_TEXT}: ${form.image}`])
        const holder = findContainer(form.name)
        if (holder !== null && holder.name === form.name) {
          return refused(1, [`Error response from daemon: Conflict. The container name "/${form.name}" is already in use by container "${holder.id}". You have to remove (or rename) that container to be able to reuse that name.`])
        }
        const container = addContainerModel({ name: form.name, image: image.id, labels: form.labels }, true)
        return answered(`${container.id}\n`)
      }
      case 'container-copy': {
        const container = findContainer(form.ref)
        if (container === null) return noSuchContainer(form.ref)
        const archive = container.archives.get(form.path) ?? (container.imageId === null ? undefined : images.get(container.imageId)?.archives.get(form.path))
        if (archive === undefined) return refused(1, [`Error response from daemon: Could not find the file ${form.path} in container ${form.ref}`])
        return answered(archive)
      }
      case 'container-kill': {
        const container = findContainer(form.ref)
        if (container === null) return noSuchContainer(form.ref)
        if (!container.running) return refused(1, [`Error response from daemon: cannot kill container: ${form.ref}: container ${container.id} is not running`])
        takeSignal(processes, clock, container.pid, form.signal)
        return answered(`${form.ref}\n`)
      }
      case 'container-logs': {
        const container = findContainer(form.ref)
        if (container === null) return noSuchContainer(form.ref)
        return answered(container.logs.stdout, container.logs.stderr)
      }
      case 'container-remove': {
        const container = findContainer(form.ref)
        if (container === null) return noSuchContainer(form.ref)
        if (container.running) {
          return refused(1, [`Error response from daemon: cannot remove container "/${container.name}": container is running: stop the container before removing or force remove`])
        }
        containers.delete(container.id)
        return answered(`${form.ref}\n`)
      }
      case 'container-run':
        return answerRun(op, form.runArguments)
      case 'image-inspect': {
        const found: string[] = []
        const missing: string[] = []
        for (const ref of form.refs) {
          const image = findImage(ref)
          if (image === null) missing.push(`Error response from daemon: ${DOCKER_NO_SUCH_IMAGE_TEXT}: ${ref}`)
          else found.push(JSON.stringify(imageAnswer(image)))
        }
        return { exitCode: missing.length === 0 ? 0 : 1, stdout: linesText(found), stderr: linesText(missing) }
      }
      case 'image-list': {
        const labelFilters = form.filters.flatMap((filter) => (filter.kind === 'label' ? [filter] : []))
        const patterns = form.filters.flatMap((filter) => (filter.kind === 'reference' ? [filter.pattern] : []))
        const danglingOnly = form.filters.some((filter) => filter.kind === 'dangling')
        const lines: string[] = []
        for (const image of images.values()) {
          if (danglingOnly && image.tags.length > 0) continue
          if (!labelFilters.every((filter) => Object.hasOwn(image.labels, filter.key) && (filter.value === null || image.labels[filter.key] === filter.value))) continue
          const shown = patterns.length === 0 ? image.tags : image.tags.filter((tag) => patterns.some((pattern) => referenceMatches(pattern, tag)))
          if (patterns.length > 0 && shown.length === 0) continue
          // One line per tag, as `docker image ls` lists one row per tag; one for an untagged image.
          lines.push(...(shown.length === 0 ? [image.id] : shown.map(() => image.id)))
        }
        return answered(linesText(lines))
      }
      case 'image-remove':
        return answerImageRemoval(op, form.argument)
      case 'image-tag': {
        const image = images.get(form.imageId)
        if (image === undefined) return noSuchImage(form.imageId)
        moveTag(normalizeImageTag(form.tag), image)
        return answered()
      }
      case 'image-build':
        return answerBuild(op, form)
      case 'image-prune': {
        if (pruneRunning) return refused(1, [`Error response from daemon: ${PRUNE_ALREADY_RUNNING_TEXT}`])
        pruneRunning = true
        return {
          delayMs: pruneDurationMs,
          onEnd: () => {
            pruneRunning = false
            const deleted = pruneUntagged(form.owner)
            op.deleted = deleted
            return { exitCode: 0, stdout: pruneReport(deleted) }
          },
        }
      }
    }
  }

  recorder.addResponder((request) => {
    if (request.argv[0] !== DOCKER_PROGRAM) return undefined
    const form = matchDockerForm(request)
    if (form === null) {
      const why = request.argv[1] === dockerFormHeads().build[1] && !request.ownProcessGroup ? ' (a build must start in a process group of its own)' : ''
      throw new Error(`fake docker: no docker form of the runner matches ${JSON.stringify(request.argv)}${why}`)
    }
    const op = record(form.kind, request.argv, operationFields(form))
    const failure = takeFailure(form.kind, request.argv)
    if (failure !== null) return settledWith(op, refused(failure.exitCode, [failure.stderr]))
    return settledWith(op, answerForm(form, op))
  })

  return {
    addImage: (spec = {}) => addImageModel(spec).id,
    addContainer: (spec) => addContainerModel(spec).id,
    image(ref) {
      const image = findImage(ref)
      return image === null ? null : imageSnapshot(image)
    },
    images: () => [...images.values()].map(imageSnapshot),
    container(ref) {
      const container = findContainer(ref)
      return container === null ? null : containerSnapshot(container)
    },
    containers: () => [...containers.values()].map(containerSnapshot),
    exitContainer(ref, exit) {
      const container = findContainer(ref)
      if (container === null || !container.running) throw new Error(`fake docker: no running container ${ref}`)
      container.pendingExit = exit
      const pid = container.pid
      if (exit.atMs === undefined) processes.makeGone(pid, null)
      else clock.setTimeout(() => processes.makeGone(pid, null), Math.max(0, exit.atMs - clock.now()))
    },
    setServerVersion(version) {
      serverVersion = version
    },
    setPruneDuration(durationMs) {
      pruneDurationMs = durationMs
    },
    fail(kind, failure = {}) {
      const times = failure.times ?? 1
      failureRules.push({
        kind,
        remaining: times === 'always' ? Infinity : times,
        exitCode: failure.exitCode ?? 1,
        stderr: failure.stderr ?? `Error response from daemon: fake ${kind} failure`,
        when: failure.when,
      })
    },
    answerRuns(handler) {
      runHandler = handler
    },
    programBuild(program, selector = {}) {
      buildRules.push({ program, selector, remaining: selector.times ?? 1 })
    },
    startOtherPrune(pruneOptions = {}) {
      const { owner } = pruneOptions
      const op = record('image-prune', [], { source: 'other', filters: owner === undefined ? [] : [`${dockerFormHeads().pruneFilterPrefix}${owner}`] })
      if (pruneRunning) {
        op.exitCode = 1
        return false
      }
      pruneRunning = true
      clock.setTimeout(
        () => {
          pruneRunning = false
          op.deleted = pruneUntagged(owner ?? null)
          op.exitCode = 0
        },
        Math.max(1, pruneOptions.durationMs ?? pruneDurationMs),
      )
      return true
    },
    isPruneRunning: () => pruneRunning,
    operations: (kind) => operations.filter((op) => kind === undefined || op.kind === kind).map(operationSnapshot),
    removals: () =>
      operations.filter((op) => op.kind === 'image-remove' || op.kind === 'image-prune' || op.kind === 'container-remove').map(operationSnapshot),
  }
}

/**
 * A tar archive (ustar) of constructed files, as `docker container cp <c>:<path> -`
 * gives one: each entry's name (at most 100 bytes; a name ending in `/` is a
 * directory) and content. For the fake's `archives`.
 */
export function buildTarArchive(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const encoder = new TextEncoder()
  const blocks: Uint8Array[] = []
  for (const [name, content] of Object.entries(entries)) {
    const directory = name.endsWith('/')
    const body = directory ? new Uint8Array(0) : textBytes(content)
    const header = new Uint8Array(512)
    const put = (offset: number, length: number, text: string): void => {
      const bytes = encoder.encode(text)
      if (bytes.length > length) throw new Error(`buildTarArchive: ${JSON.stringify(name)} does not fit its header field`)
      header.fill(0, offset, offset + length)
      header.set(bytes, offset)
    }
    put(0, 100, name)
    put(100, 8, directory ? '0000755\0' : '0000644\0')
    put(108, 8, '0000000\0')
    put(116, 8, '0000000\0')
    put(124, 12, `${body.length.toString(8).padStart(11, '0')}\0`)
    put(136, 12, '00000000000\0')
    put(148, 8, '        ')
    put(156, 1, directory ? '5' : '0')
    put(257, 6, 'ustar\0')
    put(263, 2, '00')
    put(148, 8, `${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `)
    blocks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512))
  }
  blocks.push(new Uint8Array(1024))
  const archive = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0))
  let at = 0
  for (const block of blocks) {
    archive.set(block, at)
    at += block.length
  }
  return archive
}

// ---------------------------------------------------------------------------
// 5. Worktree builder (E1 T7)
// ---------------------------------------------------------------------------
//
// b.uqm SR-21.4's worktree: a temporary tree, made under a caller's
// `mkdtempSync` root, whose `tests/integration` holds one minimal valid script
// per real script number by default (the real file names, from the
// repository's own listing, looked up by number; SR-21.2), or a given list.
// Per script, prerequisite lines in every placement; extra badly named files;
// `test-*.sh` entries that are not regular files; duplicate numbers; a missing
// test-1; a duration table given, absent, unreadable, out of order, without a
// final line feed or with carriage returns; and `docker/Dockerfile.test` and
// `docker/Dockerfile.test.base` holding the repository's own `FROM` and
// `ARG AD_VERSION` lines, the latter empty or absent on demand. The builder
// writes only under the root it is given, and reads the repository only to
// copy real names and lines. Only the naming-rule cases type a bad name
// (`test-5.sh`, `test-05-x.sh`, `test-x-y.sh`), and they pass it here.

/** The repository root: this helper sits in `tests/test-helpers/`. */
const WORKTREE_REPO_ROOT = join(import.meta.dir, '..', '..')

/** A script file name's extension, which every valid name ends in (`SCRIPT_FILE_NAME_PATTERN`). */
const SCRIPT_EXTENSION = '.sh'

/** Refuses a name that is not one plain entry of its directory, so nothing is written outside the root. */
function assertPlainEntryName(name: string, what: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error(`${what}: ${JSON.stringify(name)} is not one entry name`)
  }
}

/** The repository's real scripts: the regular files of its `tests/integration` whose names are valid script names, in canonical order. Read afresh on each call. */
export function realScriptFileNames(): string[] {
  const entries = readdirSync(join(WORKTREE_REPO_ROOT, INTEGRATION_DIR_PATH), { withFileTypes: true })
  return sortCanonical(entries.filter((entry) => entry.isFile() && isScriptFileName(entry.name)).map((entry) => entry.name))
}

/** The repository's real script numbers, in canonical order. */
export function realScriptNumbers(): number[] {
  return realScriptFileNames().map((fileName) => fileNameNumber(fileName) as number)
}

/** The repository's real file name for script number `n`, looked up in its listing (b.uqm SR-21.2). Throws when it has none. */
export function realScriptFileName(n: number): string {
  const fileName = realScriptFileNames().find((name) => fileNameNumber(name) === n)
  if (fileName === undefined) throw new Error(`realScriptFileName: the repository has no script numbered ${n}`)
  return fileName
}

/** A second valid file name for real script number `n` (`<real name>-duplicate.sh`), for a duplicate-number worktree. */
export function duplicateScriptFileName(n: number): string {
  const real = realScriptFileName(n)
  return `${real.slice(0, -SCRIPT_EXTENSION.length)}-duplicate${SCRIPT_EXTENSION}`
}

/** The first line of the repository's real test-1, its shebang, which every built script starts with. */
function realShebang(): string {
  const text = readFileSync(join(WORKTREE_REPO_ROOT, INTEGRATION_DIR_PATH, realScriptFileName(1)), 'utf-8')
  return text.slice(0, text.indexOf('\n'))
}

/**
 * Where a prerequisite line goes in a built script (b.uqm SR-3.1):
 * - `second-line`: right after the shebang, the header block's first line;
 * - `header`: inside the header block, after its first comment line;
 * - `below-header`: after the first line that is not a comment, so below the header block;
 * - `indented`: at the end of the header block, preceded by `indent`, so its first character is not `#`.
 */
export type PrerequisitePlacement = 'second-line' | 'header' | 'below-header' | 'indented'

/** One `# ci-requires:` line of a built script. */
export interface PrerequisiteLine {
  /** The names after the colon: a number is written as its number form, a string as given. Empty for a line naming no script. */
  readonly names: readonly (number | string)[]
  /** Default `header`. */
  readonly placement?: PrerequisitePlacement
  /** Before each name, the first one included. Default one space; spaces and tabs in any mix are valid. */
  readonly separator?: string
  /** Between `#` and the keyword. Default one space. */
  readonly afterHash?: string
  /** Before `#`, for the `indented` placement only. Default two spaces. */
  readonly indent?: string
  /** After the last name. Default none. */
  readonly trailing?: string
}

/** A prerequisite line's text, `[indent]#<afterHash>ci-requires:<separator><name>…<trailing>`, without its line feed. */
export function prerequisiteLineText(line: PrerequisiteLine): string {
  const indent = line.placement === 'indented' ? (line.indent ?? '  ') : ''
  const separator = line.separator ?? ' '
  const names = line.names.map((name) => `${separator}${typeof name === 'number' ? numberFormOf(name) : name}`).join('')
  const text = `${indent}#${line.afterHash ?? ' '}${CI_REQUIRES_KEYWORD}${names}${line.trailing ?? ''}`
  if (text.includes('\n')) throw new Error('prerequisiteLineText: a prerequisite line holds a line feed')
  return text
}

/**
 * A minimal script's text: the real shebang, a header comment block of one
 * line, then `true` and `exit 0`, with each prerequisite line where its
 * placement puts it. Lines of one placement keep their given order.
 */
export function minimalScriptText(fileName: string, prerequisites: readonly PrerequisiteLine[] = []): string {
  const at = (placement: PrerequisitePlacement): string[] =>
    prerequisites.filter((line) => (line.placement ?? 'header') === placement).map(prerequisiteLineText)
  const lines = [
    realShebang(),
    ...at('second-line'),
    `# ${fileName}: a minimal script built by tests/test-helpers/ci-run.ts.`,
    ...at('header'),
    ...at('indented'),
    'true',
    ...at('below-header'),
    'exit 0',
  ]
  return `${lines.map((line) => `${line}\n`).join('')}`
}

/** One script of a built worktree. */
export interface WorktreeScript {
  readonly fileName: string
  /** Its prerequisite lines; none by default. */
  readonly prerequisites?: readonly PrerequisiteLine[]
}

/** An entry named like a script that is not a regular file (b.uqm SR-2.3). */
export type NonRegularEntry =
  | {
      /** A symbolic link; its target defaults to the first script written, by relative name (never followed by the runner). */
      readonly kind: 'symlink'
      readonly name: string
      readonly target?: string
    }
  | {
      /** An empty directory. */
      readonly kind: 'directory'
      readonly name: string
    }

/** One duration-table row: a script (a number is written as its number form) and its seconds, as given. */
export interface DurationRow {
  readonly script: number | string
  readonly seconds: number | string
}

/** The worktree's duration table (b.uqm SR-4.1). */
export type DurationTableSpec =
  | {
      /** No file at the table's path. */
      readonly kind: 'absent'
    }
  | {
      /** A directory at the table's path, so reading it fails whatever the user (root included). */
      readonly kind: 'unreadable'
    }
  | {
      /** The file's whole text, as given. */
      readonly kind: 'text'
      readonly text: string
    }
  | {
      /** A header line (none when null) and one `<script>\t<seconds>` line per row. */
      readonly kind: 'rows'
      readonly header: string | null
      readonly rows: readonly DurationRow[]
      /** `as-given` (default), `canonical`, or `reversed`: canonical order reversed, every row out of order. */
      readonly order?: 'as-given' | 'canonical' | 'reversed'
      /** Default true; false leaves the last line without its line feed. */
      readonly finalNewline?: boolean
      /** A carriage return before the line feed: on every line (true), or on these 1-based line numbers (the header is line 1). */
      readonly carriageReturns?: boolean | readonly number[]
    }

/** One duration-table line, `<number form>\t<seconds>` (b.uqm SR-4.1), without its line feed. */
export function durationTableLine(row: DurationRow): string {
  return `${typeof row.script === 'number' ? numberFormOf(row.script) : row.script}\t${row.seconds}`
}

/** A `rows` duration table's text. */
export function durationTableText(spec: Extract<DurationTableSpec, { readonly kind: 'rows' }>): string {
  const scriptName = (row: DurationRow): string => (typeof row.script === 'number' ? numberFormOf(row.script) : row.script)
  const canonical = [...spec.rows].sort((a, b) => compareCanonical(scriptName(a), scriptName(b)))
  const order = spec.order ?? 'as-given'
  const rows = order === 'canonical' ? canonical : order === 'reversed' ? canonical.reverse() : spec.rows
  const lines = [...(spec.header === null ? [] : [spec.header]), ...rows.map(durationTableLine)]
  const withCr = (line: string, index: number): string => {
    const cr = spec.carriageReturns
    return cr === true || (Array.isArray(cr) && cr.includes(index + 1)) ? `${line}\r` : line
  }
  const text = lines.map(withCr).join('\n')
  return spec.finalNewline === false || text === '' ? text : `${text}\n`
}

/** The repository's own Dockerfile lines the worktree copies (b.uqm SR-9.2): never typed. */
export interface RepositoryDockerfileLines {
  /** `docker/Dockerfile.test`'s `FROM` lines, in order. */
  readonly testFrom: readonly string[]
  /** `docker/Dockerfile.test.base`'s `FROM` and `ARG AD_VERSION` lines, in order. */
  readonly baseLines: readonly string[]
  /** Its `ARG AD_VERSION=<version>` line. */
  readonly adVersion: string
}

const DOCKERFILE_FROM_LINE = /^FROM\s/
const DOCKERFILE_AD_VERSION_LINE = /^ARG AD_VERSION(=|\s|$)/

/** The `FROM` and `ARG AD_VERSION` lines of the repository's two test Dockerfiles. */
export function repositoryDockerfileLines(): RepositoryDockerfileLines {
  const read = (path: string): string[] => readFileSync(join(WORKTREE_REPO_ROOT, path), 'utf-8').split('\n')
  const testFrom = read(TEST_DOCKERFILE_PATH).filter((line) => DOCKERFILE_FROM_LINE.test(line))
  const baseLines = read(BASE_DOCKERFILE_PATH).filter((line) => DOCKERFILE_FROM_LINE.test(line) || DOCKERFILE_AD_VERSION_LINE.test(line))
  const adVersion = baseLines.find((line) => DOCKERFILE_AD_VERSION_LINE.test(line))
  if (testFrom.length === 0 || adVersion === undefined || !adVersion.includes('=')) {
    throw new Error('repositoryDockerfileLines: the repository Dockerfiles lack a FROM line or an ARG AD_VERSION=<version> line')
  }
  return { testFrom, baseLines, adVersion }
}

/** The worktree's two Dockerfiles. */
export interface WorktreeDockerfiles {
  /** `docker/Dockerfile.test`; default `present`. */
  readonly test?: 'present' | 'absent'
  /** `docker/Dockerfile.test.base`; default `present`. */
  readonly base?: 'present' | 'absent'
  /** Its `ARG AD_VERSION` line: `real` (default); `empty`, the real line cut after its `=`; or `absent`, the line left out. */
  readonly adVersion?: 'real' | 'empty' | 'absent'
}

/** What `buildWorktree` makes. */
export interface WorktreeOptions {
  /** The scripts, replacing the default of one per real number with its real name. A string is a file name with no prerequisite line. */
  readonly scripts?: readonly (string | WorktreeScript)[]
  /** Real numbers left out of the default list: `[1]` gives a worktree with no test-1. */
  readonly without?: readonly number[]
  /** Prerequisite lines by script number, for every script of that number that carries none of its own. */
  readonly prerequisites?: Readonly<Record<number, readonly PrerequisiteLine[]>>
  /** Further regular files, written as minimal scripts under any name: bad names, and duplicate numbers (`duplicateScriptFileName`). */
  readonly extraScripts?: readonly (string | WorktreeScript)[]
  /** Entries named like scripts that are not regular files. */
  readonly nonRegular?: readonly NonRegularEntry[]
  /** Default `absent`. */
  readonly durationTable?: DurationTableSpec
  readonly dockerfiles?: WorktreeDockerfiles
}

/** A built worktree: its root (the runner's `worktreeRoot`) and the paths it holds. */
export interface BuiltWorktree {
  readonly root: string
  readonly integrationDir: string
  /** Every regular script file written, the main list then the extra ones. */
  readonly scriptFileNames: readonly string[]
  /** The duration table's path, whether or not anything is there. */
  readonly durationTablePath: string
  readonly testDockerfilePath: string
  readonly baseDockerfilePath: string
}

/** Builds a worktree in a new directory under `root` (a caller's `mkdtempSync` directory), writing only there (b.uqm SR-21.4). */
export function buildWorktree(root: string, options: WorktreeOptions = {}): BuiltWorktree {
  if (!lstatSync(root).isDirectory()) throw new Error(`buildWorktree: ${root} is not a directory`)
  const worktree = mkdtempSync(join(root, 'worktree-'))
  const integrationDir = join(worktree, INTEGRATION_DIR_PATH)
  const durationTablePath = join(worktree, DURATION_TABLE_PATH)
  const testDockerfilePath = join(worktree, TEST_DOCKERFILE_PATH)
  const baseDockerfilePath = join(worktree, BASE_DOCKERFILE_PATH)
  for (const dir of [integrationDir, dirname(durationTablePath), dirname(testDockerfilePath), dirname(baseDockerfilePath)]) mkdirSync(dir, { recursive: true })

  const without = new Set(options.without ?? [])
  const asScript = (entry: string | WorktreeScript): WorktreeScript => (typeof entry === 'string' ? { fileName: entry } : entry)
  const main = (options.scripts ?? realScriptFileNames().filter((name) => !without.has(fileNameNumber(name) as number))).map(asScript)
  const scripts = [...main, ...(options.extraScripts ?? []).map(asScript)]
  for (const script of scripts) {
    assertPlainEntryName(script.fileName, 'buildWorktree')
    const n = fileNameNumber(script.fileName)
    const prerequisites = script.prerequisites ?? (n === null ? undefined : options.prerequisites?.[n]) ?? []
    writeFileSync(join(integrationDir, script.fileName), minimalScriptText(script.fileName, prerequisites), { flag: 'wx', mode: 0o755 })
  }
  for (const entry of options.nonRegular ?? []) {
    assertPlainEntryName(entry.name, 'buildWorktree')
    const path = join(integrationDir, entry.name)
    if (entry.kind === 'directory') mkdirSync(path)
    else symlinkSync(entry.target ?? scripts[0]?.fileName ?? '.', path)
  }

  const table = options.durationTable ?? { kind: 'absent' }
  if (table.kind === 'unreadable') mkdirSync(durationTablePath)
  else if (table.kind === 'text') writeFileSync(durationTablePath, table.text)
  else if (table.kind === 'rows') writeFileSync(durationTablePath, durationTableText(table))

  const dockerfiles = options.dockerfiles ?? {}
  const real = repositoryDockerfileLines()
  const fileText = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join('')
  if ((dockerfiles.test ?? 'present') === 'present') writeFileSync(testDockerfilePath, fileText(real.testFrom))
  if ((dockerfiles.base ?? 'present') === 'present') {
    const adVersion = dockerfiles.adVersion ?? 'real'
    const baseLines = real.baseLines.flatMap((line) => {
      if (line !== real.adVersion || adVersion === 'real') return [line]
      return adVersion === 'empty' ? [line.slice(0, line.indexOf('=') + 1)] : []
    })
    writeFileSync(baseDockerfilePath, fileText(baseLines))
  }

  return {
    root: worktree,
    integrationDir,
    scriptFileNames: scripts.map((script) => script.fileName),
    durationTablePath,
    testDockerfilePath,
    baseDockerfilePath,
  }
}

// ---------------------------------------------------------------------------
// 6. Run-directory builder (E1 T7)
// ---------------------------------------------------------------------------
//
// b.uqm SR-21.4's run directories, in a constructed system temp directory:
// status files, verdicts, runner logs, results files and shard
// subdirectories; and new-style and legacy results directories of given
// sizes. Every valid file comes from the runner's own writers, serializers,
// formatters and names (section 5 of `scripts/ci-run.ts`); an invalid one is
// a valid one's text with one named change, written through the runner's own
// whole-file writer (`writeWholeFile`). No builder plants a secret value: a
// file holds only what its caller passes and the builder's fixed filler.

/** A mode as `results.json` writes it, four octal digits (`0700`). */
function modeText(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0')
}

/** Creates a directory with exactly `mode`, whatever the umask; fails when anything is at `path`. */
function makeDirWithMode(path: string, mode: number): void {
  mkdirSync(path, { mode })
  chmodSync(path, mode)
}

/** Throws a failed runner write as an error, so a builder never leaves a test with a half-built directory unnoticed. */
function assertWritten(result: WriteResult, what: string): void {
  if (!result.ok) throw new Error(`${what}: ${result.error}`)
}

/** The run directory of `runId` in a constructed system temp directory: the runner's own path rule (`runDirPath`) with `TMPDIR` set to it. Creates nothing, so it also names a run that has no directory. */
export function runDirIn(tempDir: string, runId: string): string {
  return runDirPath({ TMPDIR: tempDir }, runId)
}

/** Creates the run directory of `runId` in `tempDir`, mode 0700, as the runner's first act does (b.uqm SR-5.1); fails when anything is already there. */
export function makeRunDir(tempDir: string, runId: string): string {
  const runDir = runDirIn(tempDir, runId)
  makeDirWithMode(runDir, RUN_DIR_MODE)
  return runDir
}

/** A leftover temporary file of an interrupted whole-file write: `atomicTempFileName(fileName)` in `dir`, holding `text` (typically a builder's valid text, cut). */
export function writeLeftoverTempFile(dir: string, fileName: string, text: string): string {
  const path = join(dir, atomicTempFileName(fileName))
  writeFileSync(path, text)
  return path
}

// JSON file changes, shared by the status and results files.

/** A named change to a valid JSON file's text. */
export type JsonFileChange =
  | {
      /** The valid text cut after its first half: not JSON. */
      readonly kind: 'unparseable'
    }
  | {
      /** The `version` key set to another value. */
      readonly kind: 'version'
      readonly version: unknown
    }
  | {
      /** One top-level key removed. */
      readonly kind: 'drop-key'
      readonly key: string
    }
  | {
      /** One top-level key set to a value, or added when absent. */
      readonly kind: 'set-key'
      readonly key: string
      readonly value: unknown
    }
  | {
      /** Any other change, named by `what`. */
      readonly kind: 'edit'
      readonly what: string
      readonly edit: (valid: string) => string
    }

/** A valid JSON file's text with one named change. Throws when the change leaves the text as it was. */
export function changedJsonText(valid: string, change: JsonFileChange): string {
  const withObject = (edit: (object: Record<string, unknown>) => void): string => {
    const object = JSON.parse(valid) as Record<string, unknown>
    edit(object)
    return `${JSON.stringify(object, null, 2)}\n`
  }
  let text: string
  switch (change.kind) {
    case 'unparseable':
      text = valid.slice(0, Math.floor(valid.length / 2))
      break
    case 'version':
      text = withObject((object) => {
        object.version = change.version
      })
      break
    case 'drop-key':
      text = withObject((object) => {
        if (!Object.hasOwn(object, change.key)) throw new Error(`changedJsonText: no key ${JSON.stringify(change.key)} to drop`)
        delete object[change.key]
      })
      break
    case 'set-key':
      text = withObject((object) => {
        object[change.key] = change.value
      })
      break
    case 'edit':
      text = change.edit(valid)
      break
  }
  if (text === valid) throw new Error(`changedJsonText: the change ${change.kind === 'edit' ? change.what : change.kind} leaves the file as it was`)
  return text
}

// The status file (b.uqm SR-5.2).

/** One status file's content. */
export interface StatusSpec {
  readonly runId: string
  readonly pid: number
  /** The runner's start, epoch milliseconds. */
  readonly startMs: number
  /** The deadline's minutes from the start. */
  readonly deadlineMinutes: number
  readonly phase: StatusPhase
  /** Phase `refused` only: its kind, its reason (a whole `NOT RUN: …` line or the summary alone) and its detail lines, through `buildRefusal`. */
  readonly refusal?: {
    readonly kind: RefusalKind
    readonly reason: string
    readonly details?: readonly string[]
  }
}

/** A status, built by the runner's own `buildStatus` or `buildRefusedStatus` (b.uqm SR-5.2): every phase, and a refusal of every kind. */
export function makeStatus(spec: StatusSpec): RunStatus {
  const basis = { runId: spec.runId, pid: spec.pid, startMs: spec.startMs, deadline: statusDeadline(spec.startMs, spec.deadlineMinutes) }
  if (spec.phase !== 'refused') {
    if (spec.refusal !== undefined) throw new Error(`makeStatus: phase ${spec.phase} has no refusal`)
    return buildStatus(basis, spec.phase)
  }
  if (spec.refusal === undefined) throw new Error('makeStatus: phase refused needs a refusal')
  return buildRefusedStatus(basis, buildRefusal(spec.refusal.kind, spec.refusal.reason, spec.refusal.details ?? []))
}

/** A named change to a valid status file: a JSON change, or a valid file naming another PID. */
export type StatusFileChange =
  | JsonFileChange
  | {
      /** The same status naming another PID: still a valid file, written by the runner's writer. */
      readonly kind: 'pid'
      readonly pid: number
    }

/** Writes the run directory's status file: valid through `writeStatusFile`, or the valid text with one named change through `writeWholeFile`. Answers its path. */
export function writeStatus(runDir: string, status: RunStatus, change?: StatusFileChange): string {
  if (change === undefined || change.kind === 'pid') {
    const written: RunStatus = change === undefined ? status : { ...status, pid: change.pid }
    assertWritten(writeStatusFile(runDir, written), 'writeStatus')
  } else {
    assertWritten(writeWholeFile(runDir, STATUS_FILE_NAME, changedJsonText(serializeStatus(status), change)), 'writeStatus')
  }
  return join(runDir, STATUS_FILE_NAME)
}

// The verdict file (b.uqm SR-5.7).

/** A named change to a valid verdict file. */
export type VerdictFileChange =
  | {
      /** Its one line without the final line feed. */
      readonly kind: 'no-final-line-feed'
    }
  | {
      /** A second line after the first. */
      readonly kind: 'second-line'
      readonly line: string
    }
  | {
      /** No line at all: an empty file. */
      readonly kind: 'empty'
    }

/** Writes `verdict.txt` with any first line: valid through `writeVerdictFile`, or with one named change through `writeWholeFile`. Answers its path. */
export function writeVerdict(runDir: string, line: string, change?: VerdictFileChange): string {
  if (change === undefined) {
    assertWritten(writeVerdictFile(runDir, line), 'writeVerdict')
  } else {
    const text = change.kind === 'no-final-line-feed' ? line : change.kind === 'second-line' ? `${line}\n${change.line}\n` : ''
    assertWritten(writeWholeFile(runDir, VERDICT_FILE_NAME, text), 'writeVerdict')
  }
  return join(runDir, VERDICT_FILE_NAME)
}

// The runner log (b.uqm SR-5.4).

/** A runner log's content. */
export interface RunnerLogSpec {
  readonly runId: string
  readonly pid: number
  /** The `/ci` arguments its first line names; default none. */
  readonly args?: readonly string[]
  /** The first line: `valid` (default), written by `formatRunnerLogFirstLine`; `absent`; or the valid line with one named change. */
  readonly firstLine?:
    | 'valid'
    | 'absent'
    | {
        readonly what: string
        readonly edit: (valid: string) => string
      }
  /** The lines after the first, in order. */
  readonly lines?: readonly string[]
  /** Filler lines (`filler line <n>`) are added until the log has this many lines, the first included. */
  readonly lineCount?: number
  /** Texts placed at 1-based line numbers, replacing what is there (the first line excluded): the given values a case looks for. */
  readonly values?: Readonly<Record<number, string>>
}

/** Writes the run directory's `runner.log` through the runner's own `createRunnerLog` (b.uqm SR-5.4). Answers its path. */
export function writeRunnerLog(runDir: string, spec: RunnerLogSpec): string {
  const path = join(runDir, RUNNER_LOG_FILE_NAME)
  const valid = formatRunnerLogFirstLine(spec.runId, spec.pid, spec.args ?? [])
  const firstLine = spec.firstLine ?? 'valid'
  const first = firstLine === 'absent' ? [] : [firstLine === 'valid' ? valid : firstLine.edit(valid)]
  const lines = [...first, ...(spec.lines ?? [])]
  while (lines.length < (spec.lineCount ?? 0)) lines.push(`filler line ${lines.length + 1}`)
  for (const [at, text] of Object.entries(spec.values ?? {})) {
    const n = Number(at)
    if (!Number.isInteger(n) || n < 2 || n > lines.length) throw new Error(`writeRunnerLog: no line ${at} to hold a value (the log has ${lines.length} lines)`)
    lines[n - 1] = text
  }
  const log = createRunnerLog(path, {
    onAppendError: (error) => {
      throw new Error(`writeRunnerLog: ${error}`)
    },
  })
  if (lines.length > 0) log.childOutput(`${lines.join('\n')}\n`)
  return path
}

// results.json (b.uqm SR-16.1).

/** `results.json`'s content: the run's RUN_ID and PID, and any keys to set. */
export type ResultsSpec = Partial<Results> & Pick<Results, 'runId' | 'pid'>

/** The modes a built run directory has on disk: its own and each shard subdirectory's, as `results.json` writes them. */
export function runDirModes(runDir: string): Results['modes'] {
  const shardDirs: Record<string, string> = {}
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(SHARD_DIR_PREFIX)) shardDirs[entry.name] = modeText(lstatSync(join(runDir, entry.name)).mode)
  }
  return { runDir: modeText(lstatSync(runDir).mode), tarball: null, shardDirs }
}

/**
 * A `Results` value: `spec`'s keys over defaults that, with one exception,
 * describe one run consistently by b.uqm SR-16.1: a default full run (`/ci`
 * with no arguments, so not selective) on the real tree, `MAX_SHARDS`
 * requested and effective and, admission never having lowered it, its N
 * (`admitted`), that stopped before it packed the package (b.uqm SR-5.3,
 * SR-5.6): so no tarball, no image, no shard scheduled or started
 * (`scripts` and `shards` empty, `started` 0), no reading, no shard directory,
 * and the full run's `cap`: a boolean `peakFromKill` (false) and an empty
 * `suffix`, every peak null. The exception: such a run fails, but `verdict`
 * defaults to '' and `failures` to none. They are shape-only filler, since the
 * runner has no writer of its verdict lines yet (E10) and the helper types no
 * runner message: a test that reads either sets both. A test of another run
 * kind (a selective run's null `peakFromKill` and `suffix`, a run with shards)
 * sets those keys too. `modes` defaults to `runDir`'s modes on disk when a run
 * directory is given. `serializeResults` checks the whole shape when it is
 * written.
 */
export function makeResults(spec: ResultsSpec, runDir?: string): Results {
  const defaults: Results = {
    version: RESULTS_FORMAT_VERSION,
    runId: spec.runId,
    pid: spec.pid,
    packageSha256: null,
    images: { pinned: null, drift: null, retag: null, retagMoved: false },
    verdict: '',
    invocation: { args: [], selective: false, faults: [] },
    scripts: [],
    shards: [],
    shardCount: { requested: MAX_SHARDS, effective: MAX_SHARDS, admitted: MAX_SHARDS, started: 0, reasons: [] },
    cap: { usedBytes: SHARD_MEMORY_CAP_BYTES, peakBytes: null, peakShard: null, peakPageCacheBytes: null, peakFromKill: false, derivedBytes: null, suffix: '' },
    workingSet: { before: null, peak: null, after: null },
    failedReadings: 0,
    modes: runDir === undefined ? { runDir: modeText(RUN_DIR_MODE), tarball: null, shardDirs: {} } : runDirModes(runDir),
    failures: [],
    skippedChecks: [],
    cleanupFailures: [],
    timing: { buildSeconds: 0, baseBuildSeconds: 0, totalSeconds: 0 },
    timingSummary: [],
  }
  return { ...defaults, ...spec }
}

/** The key of `results.json`'s timing summary, the one key the reader reads besides `version` (b.uqm SR-16.1). */
const TIMING_SUMMARY_KEY: keyof Results = 'timingSummary'

/** A named change to a valid results file: a JSON change, or one of the timing-summary changes the reader tells apart (b.uqm SR-17.3). */
export type ResultsFileChange =
  | JsonFileChange
  | {
      /** The `timingSummary` key removed. */
      readonly kind: 'no-timing-summary'
    }
  | {
      /** The `timingSummary` array replaced by its lines joined into one string: no array of strings. */
      readonly kind: 'broken-timing-summary'
    }

/** Writes `results.json`: valid through `serializeResults` and the runner's whole-file writer, or that text with one named change. Answers its path. */
export function writeResults(runDir: string, results: Results, change?: ResultsFileChange): string {
  const valid = serializeResults(results)
  let text = valid
  if (change?.kind === 'no-timing-summary') text = changedJsonText(valid, { kind: 'drop-key', key: TIMING_SUMMARY_KEY })
  else if (change?.kind === 'broken-timing-summary') text = changedJsonText(valid, { kind: 'set-key', key: TIMING_SUMMARY_KEY, value: results.timingSummary.join('\n') })
  else if (change !== undefined) text = changedJsonText(valid, change)
  assertWritten(writeWholeFile(runDir, RESULTS_FILE_NAME, text), 'writeResults')
  return join(runDir, RESULTS_FILE_NAME)
}

// Shard subdirectories (b.uqm SR-11.3).

/** A named change that makes one complete result-file line of no known form. */
export type ResultLineChange =
  /** A carriage return before its line feed. */
  | 'carriage-return'
  /** Its first single space doubled. */
  | 'double-space'
  /** Its first word in uppercase. */
  | 'uppercase-word'
  /** The line emptied: an empty complete line. */
  | 'empty-line'

/** A result file's content: its events' lines, with an optional malformed line and an optional partial last line. */
export interface ResultFileSpec {
  readonly events: readonly ResultEvent[]
  /** The complete line of `events[at]` made malformed by `change`. */
  readonly malformed?: {
    readonly at: number
    readonly change: ResultLineChange
  }
  /** A last line still being written: `event`'s line without its line feed, cut to its first `length` characters when given. */
  readonly partial?: {
    readonly event: ResultEvent
    readonly length?: number
  }
}

/** One result-file line made malformed by a named change. Throws when the change leaves a line the runner still reads. */
export function malformedResultLine(event: ResultEvent, change: ResultLineChange): string {
  const valid = formatResultLine(event)
  const space = valid.indexOf(' ')
  const firstWordEnd = space < 0 ? valid.length : space
  const line =
    change === 'carriage-return'
      ? `${valid}\r`
      : change === 'double-space'
        ? space < 0
          ? valid
          : `${valid.slice(0, space)} ${valid.slice(space)}`
        : change === 'uppercase-word'
          ? `${valid.slice(0, firstWordEnd).toUpperCase()}${valid.slice(firstWordEnd)}`
          : ''
  if (parseResultLine(line) !== null) throw new Error(`malformedResultLine: ${change} leaves ${JSON.stringify(valid)} readable`)
  return line
}

/** A result file's text (b.uqm SR-11.3): the runner's own `formatResultFile` of the events, or, with a malformed line, each event's line through `formatResultLine` and that one changed; then the spec's partial line. */
export function resultFileText(spec: ResultFileSpec): string {
  const malformed = spec.malformed
  let complete: string
  if (malformed === undefined) {
    complete = formatResultFile(spec.events)
  } else {
    if (spec.events[malformed.at] === undefined) throw new Error(`resultFileText: no event ${malformed.at} to make malformed`)
    const lines = spec.events.map((event, index) => (index === malformed.at ? malformedResultLine(event, malformed.change) : formatResultLine(event)))
    complete = linesText(lines)
  }
  if (spec.partial === undefined) return complete
  const whole = formatResultLine(spec.partial.event)
  const length = spec.partial.length ?? whole.length
  if (length < 1 || length > whole.length) throw new Error(`resultFileText: a partial line of ${length} characters is not part of ${JSON.stringify(whole)}`)
  return `${complete}${whole.slice(0, length)}`
}

/** A named change that makes a hex record malformed (b.uqm SR-11.3). */
export type HexRecordChange =
  /** The value without its line feed. */
  | 'no-final-line-feed'
  /** The value in uppercase. */
  | 'uppercase'
  /** The value one character short. */
  | 'short'
  /** A second line feed after the value's. */
  | 'extra-line-feed'

/** A hex record: its value (written by `formatHexRecord`), or its value with one named change. */
export type HexRecordSpec =
  | string
  | {
      readonly value: string
      readonly change: HexRecordChange
    }

/** A deterministic hex value of `length` lowercase hexadecimal characters drawn from `seed`, for canaries, hashes and fingerprints. Never a secret. */
export function hexValue(seed: string, length: number): string {
  let hex = ''
  for (let round = 0; hex.length < length; round += 1) hex += createHash('sha256').update(`${seed}:${round}`).digest('hex')
  return hex.slice(0, length)
}

/** A hex record's text: valid through `formatHexRecord`, or that text with one named change. Throws when the change leaves the record valid. */
export function hexRecordText(spec: HexRecordSpec, length: number): string {
  if (typeof spec === 'string') return formatHexRecord(spec, length)
  const valid = formatHexRecord(spec.value, length)
  const text =
    spec.change === 'no-final-line-feed'
      ? spec.value
      : spec.change === 'uppercase'
        ? valid.toUpperCase()
        : spec.change === 'short'
          ? `${spec.value.slice(0, -1)}\n`
          : `${valid}\n`
  if (text === valid) throw new Error(`hexRecordText: ${spec.change} leaves the record valid`)
  return text
}

/** One shard subdirectory's content; each file is written only when given. */
export interface ShardDirSpec {
  /** The shard number k: the subdirectory is `shard-<k>`. */
  readonly shard: number
  /** `result.txt`: its events, or a result-file spec with a malformed or partial line. */
  readonly resultFile?: readonly ResultEvent[] | ResultFileSpec
  /** `canary.txt`, `CANARY_LENGTH` characters. */
  readonly canary?: HexRecordSpec
  /** `package.sha256`, `SHA256_HEX_LENGTH` characters. */
  readonly packageSha256?: HexRecordSpec
  /** `dependency-fingerprint.txt`, `SHA256_HEX_LENGTH` characters. */
  readonly dependencyFingerprint?: HexRecordSpec
  /** Script logs, by script file name: each written as `<file name>.log`. */
  readonly scriptLogs?: Readonly<Record<string, string>>
  /** `docker.log`. */
  readonly dockerLog?: string
  /** Files the runner does not write, by name. */
  readonly foreignFiles?: Readonly<Record<string, string>>
}

/** Creates `shard-<k>` (mode 0700) in the run directory with the spec's files, and answers its path. */
export function writeShardDir(runDir: string, spec: ShardDirSpec): string {
  if (!Number.isSafeInteger(spec.shard) || spec.shard < 1) throw new Error(`writeShardDir: ${spec.shard} is no shard number`)
  const shardDir = join(runDir, `${SHARD_DIR_PREFIX}${spec.shard}`)
  makeDirWithMode(shardDir, RUN_DIR_MODE)
  const write = (name: string, text: string): void => {
    assertPlainEntryName(name, 'writeShardDir')
    writeFileSync(join(shardDir, name), text, { flag: 'wx' })
  }
  if (spec.resultFile !== undefined) {
    const resultFile = Array.isArray(spec.resultFile) ? { events: spec.resultFile } : (spec.resultFile as ResultFileSpec)
    write(RESULT_FILE_NAME, resultFileText(resultFile))
  }
  if (spec.canary !== undefined) write(CANARY_FILE_NAME, hexRecordText(spec.canary, CANARY_LENGTH))
  if (spec.packageSha256 !== undefined) write(PACKAGE_SHA256_FILE_NAME, hexRecordText(spec.packageSha256, SHA256_HEX_LENGTH))
  if (spec.dependencyFingerprint !== undefined) write(DEPENDENCY_FINGERPRINT_FILE_NAME, hexRecordText(spec.dependencyFingerprint, SHA256_HEX_LENGTH))
  for (const [fileName, text] of Object.entries(spec.scriptLogs ?? {})) write(`${fileName}${SCRIPT_LOG_SUFFIX}`, text)
  if (spec.dockerLog !== undefined) write(DOCKER_LOG_FILE_NAME, spec.dockerLog)
  for (const [name, text] of Object.entries(spec.foreignFiles ?? {})) write(name, text)
  return shardDir
}

// A whole run directory.

/** A run directory's content; each file is written only when given. */
export interface RunDirectorySpec {
  readonly runId: string
  readonly status?:
    | RunStatus
    | {
        readonly status: RunStatus
        readonly change: StatusFileChange
      }
  readonly runnerLog?: Omit<RunnerLogSpec, 'runId'>
  readonly shards?: readonly ShardDirSpec[]
  /** Written after the shard subdirectories, so its default `modes` names them. */
  readonly results?:
    | ResultsSpec
    | {
        readonly results: ResultsSpec
        readonly change: ResultsFileChange
      }
  readonly verdict?:
    | string
    | {
        readonly line: string
        readonly change: VerdictFileChange
      }
}

/** Builds a run directory in a constructed system temp directory (b.uqm SR-21.4): the directory (0700), then its status file, runner log, shard subdirectories, results file and verdict, as given. Answers its path. */
export function buildRunDirectory(tempDir: string, spec: RunDirectorySpec): string {
  const runDir = makeRunDir(tempDir, spec.runId)
  if (spec.status !== undefined) {
    if ('change' in spec.status) writeStatus(runDir, spec.status.status, spec.status.change)
    else writeStatus(runDir, spec.status)
  }
  if (spec.runnerLog !== undefined) writeRunnerLog(runDir, { ...spec.runnerLog, runId: spec.runId })
  for (const shard of spec.shards ?? []) writeShardDir(runDir, shard)
  if (spec.results !== undefined) {
    if ('change' in spec.results && 'results' in spec.results) writeResults(runDir, makeResults(spec.results.results, runDir), spec.results.change)
    else writeResults(runDir, makeResults(spec.results as ResultsSpec, runDir))
  }
  if (spec.verdict !== undefined) {
    if (typeof spec.verdict === 'string') writeVerdict(runDir, spec.verdict)
    else writeVerdict(runDir, spec.verdict.line, spec.verdict.change)
  }
  return runDir
}

// Results directories in the system temp directory (b.uqm SR-6.8).

/** One `/ci` results directory for the disk refusal's listing. */
export interface ResultsDirSpec {
  /** `new`: `cscb-ci-<RUN_ID>` (b.uqm SR-5.1); `legacy`: `cscb-ci-<digits>-<six>`, made by the skill of 946be79. */
  readonly style: 'new' | 'legacy'
  /** New style: its RUN_ID. */
  readonly runId?: string
  /** Legacy style: its digits; default `1759912345`. */
  readonly digits?: string
  /** Legacy style: its six letters or digits; default `a1b2c3`. */
  readonly six?: string
  /** The bytes of the files under it: sparse files whose apparent sizes add up to this, one of them in a subdirectory (see `makeResultsDir`). */
  readonly bytes: number
  /** `directory` (default), or `symlink`: a link of the results directory's name to a directory of that size elsewhere under the temp directory, which the listing must leave out. */
  readonly kind?: 'directory' | 'symlink'
  /** A symbolic link inside it to this target, which its size must not count. */
  readonly linkOut?: string
}

/** The name a results directory spec gives. */
export function resultsDirName(spec: ResultsDirSpec): string {
  if (spec.style === 'new') {
    if (spec.runId === undefined) throw new Error('resultsDirName: a new-style results directory needs a RUN_ID')
    return basename(runDirIn('/', spec.runId))
  }
  return `${RUN_DIR_PREFIX}${spec.digits ?? '1759912345'}-${spec.six ?? 'a1b2c3'}`
}

/** Fills `dir` with sparse files whose apparent sizes add up to `bytes` (see `makeResultsDir`): half directly in it, the rest one level down. */
function fillWithBytes(dir: string, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`makeResultsDir: ${bytes} is no byte count`)
  const top = Math.floor(bytes / 2)
  const nested = join(dir, 'nested')
  mkdirSync(nested)
  writeFileSync(join(dir, 'data'), '')
  truncateSync(join(dir, 'data'), top)
  writeFileSync(join(nested, 'data'), '')
  truncateSync(join(nested, 'data'), bytes - top)
}

/**
 * Makes one results directory of a given size in a constructed system temp
 * directory, and answers its path (b.uqm SR-6.8). Sparse files keep a large
 * size cheap: its size, `spec.bytes`, is the sum of its regular files'
 * apparent sizes (about 0 bytes allocated), and excludes the sizes of
 * directories and links themselves, so E6 must size a results directory as
 * the sum of its regular files' sizes, never by blocks or `du`.
 */
export function makeResultsDir(tempDir: string, spec: ResultsDirSpec): string {
  const path = join(tempDir, resultsDirName(spec))
  let dir = path
  if (spec.kind === 'symlink') {
    dir = join(tempDir, 'link-targets', resultsDirName(spec))
    mkdirSync(dir, { recursive: true })
    symlinkSync(dir, path)
  } else {
    makeDirWithMode(dir, RUN_DIR_MODE)
  }
  fillWithBytes(dir, spec.bytes)
  if (spec.linkOut !== undefined) symlinkSync(spec.linkOut, join(dir, 'link-out'))
  return path
}

// ---------------------------------------------------------------------------
// 7. Reader additions (E3)
// ---------------------------------------------------------------------------
//
// The run-directory cases the verdict reader (`scripts/ci-verdict.ts`) needs
// beyond section 6's (b.uqm SR-21.4): a symbolic link inside a run directory
// that points out of it (the removal of b.uqm SR-16.3 must remove the link,
// never its target), and a results file whose `version` and `timingSummary`
// are valid while its other keys depart from b.uqm SR-16.1's shape (the
// reader reads only those two keys, SR-17.3), and something other than a
// directory at the run-directory path (a regular file, or a symbolic link to
// a run directory elsewhere: no run directory, never removed, SR-17.3,
// SR-16.3). Each starts from a valid run directory or file and makes one
// stated change; section 6's builders are used read-only. Later E3 Subtasks
// add any further reader case here.

/** Whether `path` lies strictly below `dir`, judged on the resolved paths. */
function isBelowPath(path: string, dir: string): boolean {
  const base = resolve(dir)
  return resolve(path).startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * Plants a symbolic link named `name` (test data, default `link-out`) inside
 * the run directory, pointing at `target`, a path outside it the caller made
 * (a directory or a file elsewhere under the case's own root). The stated
 * change: one link added to a valid run directory. Answers the link's path.
 * Throws when `target` lies inside the run directory, when it does not exist
 * (so a leak check of the root never meets a dangling link), or when `name`
 * is not one plain entry name.
 */
export function linkOutOfRunDir(runDir: string, target: string, name = 'link-out'): string {
  if (resolve(target) === resolve(runDir) || isBelowPath(target, runDir)) throw new Error(`linkOutOfRunDir: ${target} is not outside ${runDir}`)
  if (!existsSync(target)) throw new Error(`linkOutOfRunDir: ${target} does not exist`)
  assertPlainEntryName(name, 'linkOutOfRunDir')
  const link = join(runDir, name)
  symlinkSync(target, link)
  return link
}

/** The keys `results.json` keeps valid in an off-shape file: the two the reader reads (b.uqm SR-16.1, SR-17.3). */
const READER_RESULTS_KEYS: readonly (keyof Results)[] = ['version', 'timingSummary']

/** A key b.uqm SR-16.1 does not have, added by the off-shape change: test data. */
const FOREIGN_RESULTS_KEY = 'unexpectedKey'

/**
 * `results.json`'s valid text (`serializeResults`) with one stated change:
 * every key but `version` and `timingSummary` departs from b.uqm SR-16.1's
 * shape. Of the others, the first is removed, the second given a value of
 * the wrong type (a string), and a foreign key is added; `version` and
 * `timingSummary` keep their valid values. Throws unless the runner's strict
 * parser then refuses the text while those two keys still read back as
 * written, so the case stays what it claims.
 */
export function offShapeResultsText(results: Results): string {
  const valid = serializeResults(results)
  const others = Object.keys(JSON.parse(valid) as Record<string, unknown>).filter((key) => !READER_RESULTS_KEYS.includes(key as keyof Results))
  const [dropped, retyped] = others
  if (dropped === undefined || retyped === undefined) throw new Error('offShapeResultsText: results.json has too few other keys to change')
  const text = changedJsonText(valid, {
    kind: 'edit',
    what: `every key but ${READER_RESULTS_KEYS.join(' and ')} off shape: ${dropped} removed, ${retyped} retyped, ${FOREIGN_RESULTS_KEY} added`,
    edit: (validText) => {
      const object = JSON.parse(validText) as Record<string, unknown>
      delete object[dropped]
      object[retyped] = String(object[retyped])
      object[FOREIGN_RESULTS_KEY] = true
      return `${JSON.stringify(object, null, 2)}\n`
    },
  })
  if (parseResults(text).ok) throw new Error('offShapeResultsText: the runner still reads the changed file as valid')
  const read = JSON.parse(text) as Record<string, unknown>
  for (const key of READER_RESULTS_KEYS) {
    if (JSON.stringify(read[key]) !== JSON.stringify(results[key])) throw new Error(`offShapeResultsText: ${key} changed`)
  }
  return text
}

/** Writes `offShapeResultsText(results)` as the run directory's `results.json`, through the runner's whole-file writer. Answers its path. */
export function writeOffShapeResults(runDir: string, results: Results): string {
  assertWritten(writeWholeFile(runDir, RESULTS_FILE_NAME, offShapeResultsText(results)), 'writeOffShapeResults')
  return join(runDir, RESULTS_FILE_NAME)
}

/** What `plantNonDirectoryAtRunDir` puts at the run-directory path: a regular file, or a symbolic link to a valid run directory built from `run` in `elsewhere`. */
export type NonDirectoryAtRunDir =
  | { readonly kind: 'file' }
  | {
      readonly kind: 'link'
      /** A directory this creates, outside the run directory's parent. */
      readonly elsewhere: string
      readonly run: RunDirectorySpec
    }

/** Whether anything, a dangling symbolic link included, is at `path`. */
function entryAt(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Plants what is not a run directory at the run-directory path `runDir`
 * (the reader counts it as no run directory and never removes it, b.uqm
 * SR-17.3, SR-16.3): a regular file (test data), or a symbolic link to a
 * valid run directory that section 6's `buildRunDirectory` builds from
 * `at.run` in `at.elsewhere`. The stated change: one entry that is not a
 * directory where the run directory would be. Answers the directory holding
 * what must stay untouched: `at.elsewhere` for a link, `runDir`'s parent for
 * a file. Throws when anything is already at `runDir`, or when `at.elsewhere`
 * is `runDir`'s parent or lies below it.
 */
export function plantNonDirectoryAtRunDir(runDir: string, at: NonDirectoryAtRunDir): string {
  if (entryAt(runDir)) throw new Error(`plantNonDirectoryAtRunDir: ${runDir} already exists`)
  const parent = dirname(runDir)
  if (at.kind === 'file') {
    writeFileSync(runDir, 'not a run directory\n')
    return parent
  }
  if (resolve(at.elsewhere) === resolve(parent) || isBelowPath(at.elsewhere, parent)) throw new Error(`plantNonDirectoryAtRunDir: ${at.elsewhere} is not outside ${parent}`)
  mkdirSync(at.elsewhere)
  symlinkSync(buildRunDirectory(at.elsewhere, at.run), runDir)
  return at.elsewhere
}

// ---------------------------------------------------------------------------
// 8. Lock directory and password file (E5)
// ---------------------------------------------------------------------------
//
// b.uqm SR-21.4's lock directories and password files, for the E5 region of
// `tests/ci-run-admission.test.ts`. Everything is built under the caller's own
// `mkdtempSync` root; nothing here reads or writes a real home, the real lock
// directory or the host's password file, and nothing starts a child process.
//
// - **Lock directory** (`buildLockDir`): a constructed account home holding
//   the runner's lock directory (`admissionLockDir`), a bare lock directory, or
//   a home without one. In it, as asked: the lock file, its holder record
//   written in place through the runner's own lock-file primitive
//   (`openLockFile`, `formatLockHolder`) or that record with one named change,
//   with or without an exclusive flock held in process on a second descriptor
//   (which really blocks the runner's take until `release()`);
//   reservations written through the runner's writer (`writeReservation`), or
//   a valid one's text with one named change through `writeWholeFile`;
//   a reservation that vanishes between the runner's listing and its read; and
//   unrelated entries. Owners named by RUN_ID and liveness are added to the
//   caller's fake process table (section 2) as a live or gone `/ci` runner.
// - **Password file** (`passwordFileCases`): one text per b.uqm SR-21.4 case
//   for any user ID and home, each row labelled by what it is and naming what
//   the password-file rule gives for it. `writePasswordFile` and
//   `writeUnreadablePasswordFile` put a text, or an entry that cannot be read
//   as a file, under the caller's root; `passwordFileReader` is the runner's
//   `readPasswordFile` dependency over such a path.

// Section 8's runner imports (an ES import is hoisted; kept here so this lane writes only under its banner).
import {
  admissionLockDir,
  admissionLockPath,
  buildReservation,
  formatLockHolder,
  openLockFile,
  parseLockHolder,
  RESERVATION_FILE_SUFFIX,
  reservationFileName,
  reservationOwnerFromFileName,
  reservationTempFileName,
  serializeReservation,
  writeReservation,
  type AccountHomeFailure,
  type Owner,
  type OwnerLivenessProbe,
  type RunKind,
} from '../../scripts/ci-run.ts'
import { rmSync } from 'node:fs'

// The lock directory (b.uqm SR-6.1, SR-6.2).

/** An owner for the lock directory: by RUN_ID and liveness (a `/ci` runner added to the spec's process table, live or gone, on a PID the table picks), or exactly as given (no process added). */
export type LockDirOwnerSpec =
  | {
      readonly runId: string
      readonly alive: boolean
    }
  | {
      readonly owner: Owner
    }

/** A named change to a valid holder record. */
export type LockRecordChange =
  /** The valid record cut after its first half. */
  | 'cut'
  /** No text at all: an empty lock file. */
  | 'empty'
  /** The valid record twice: a second line after the first. */
  | 'second-line'
  /** Any other change, named by `what`. */
  | {
      readonly what: string
      readonly edit: (valid: string) => string
    }

/** The lock file: its holder, its record (valid by default, or with one named change), and whether a flock is held on it. */
export interface LockFileSpec {
  readonly holder: LockDirOwnerSpec
  readonly change?: LockRecordChange
  /** An exclusive flock held in process on a second descriptor until `release()` (default false). */
  readonly held?: boolean
}

/** A named change to a valid reservation file: a JSON change (unparseable, another `version`, another shape), a valid reservation of another owner under this owner's name, or a symbolic link at the name to a missing file. */
export type ReservationFileChange =
  | JsonFileChange
  | {
      /** The valid reservation of `owner` (written by the runner's serializer) under this owner's file name. */
      readonly kind: 'owner'
      readonly owner: Owner
    }
  | {
      /** No file: a symbolic link at the reservation name to a missing file, which the runner reads as not a regular file. */
      readonly kind: 'dangling-link'
    }

/** One reservation: its owner, what it records (N default 1, the cap default `SHARD_MEMORY_CAP_BYTES`, kind default `full`), and an optional named change. */
export interface LockDirReservationSpec {
  readonly owner: LockDirOwnerSpec
  readonly shards?: number
  readonly memoryCapBytes?: number
  readonly kind?: RunKind
  readonly change?: ReservationFileChange
}

/** An entry in the lock directory that is no reservation and not the lock file; each name is checked to be no reservation name. */
export type UnrelatedEntrySpec =
  | {
      /** A plain file (default name `notes.txt`, default text empty). */
      readonly kind: 'file'
      readonly name?: string
      readonly text?: string
    }
  | {
      /** A file named `<stem>` plus the reservation suffix whose stem is no owner (default `not-an-owner`); it holds `owner`'s valid reservation text when one is given, else nothing. */
      readonly kind: 'json-no-owner'
      readonly stem?: string
      readonly owner?: LockDirOwnerSpec
    }
  | {
      /** A leftover temporary file of `owner`'s reservation write (`reservationTempFileName`), holding its valid reservation text. */
      readonly kind: 'reservation-temp'
      readonly owner: LockDirOwnerSpec
    }
  | {
      /** A subdirectory (default name `subdir`). */
      readonly kind: 'directory'
      readonly name?: string
    }

/** What to build under the caller's root. */
export interface LockDirSpec {
  /** `home` (default): a constructed account home holding the lock directory; `bare`: a lock directory alone; `home-only`: the home without its lock directory (nothing else may be asked), for the runner to create. */
  readonly layout?: 'home' | 'bare' | 'home-only'
  /** The home's (or bare lock directory's) entry name under the root; default `account-home` (or `lock-dir`). */
  readonly name?: string
  /** The fake process table owners by RUN_ID and liveness are added to. */
  readonly processes?: FakeProcessTable
  /** The lock file; none when absent. */
  readonly lockFile?: LockFileSpec
  readonly reservations?: readonly LockDirReservationSpec[]
  /** A reservation that vanishes between the runner's listing and its read (see `VanishingReservation`); its name must sort after one of `reservations`. */
  readonly vanishing?: LockDirReservationSpec
  readonly unrelated?: readonly UnrelatedEntrySpec[]
}

/** One reservation as built. */
export interface BuiltReservation {
  readonly owner: Owner
  readonly fileName: string
  readonly path: string
  /** The text written; null for a symbolic link. */
  readonly text: string | null
}

/**
 * A reservation listed by a directory read that is gone when the runner reads
 * it. The runner lists the lock directory once and then, in file-name order,
 * reads each reservation-named entry and probes its owner's liveness; so the
 * wrapped probe's first call (made for an entry sorting before this one)
 * removes this file, and the runner's read of it then finds nothing.
 */
export interface VanishingReservation extends BuiltReservation {
  /** Removes the file now; later calls do nothing. */
  vanish(): void
  /** `inner` with one change: its first call of either member removes the file first. */
  probe(inner: OwnerLivenessProbe): OwnerLivenessProbe
}

/** A built lock directory. */
export interface BuiltLockDir {
  /** The constructed account home; null for a bare lock directory. */
  readonly home: string | null
  /** The lock directory to inject (`RunnerDeps.lockDir`); not created for `home-only`. */
  readonly lockDir: string
  /** The lock file's path (`admissionLockPath`), whether or not it was written. */
  readonly lockPath: string
  /** The holder the lock file names; null when there is no lock file. */
  readonly holder: Owner | null
  /** The record written in the lock file; null when there is none. */
  readonly lockText: string | null
  /** Whether a flock is held on the lock file. */
  readonly held: boolean
  readonly reservations: readonly BuiltReservation[]
  readonly vanishing: VanishingReservation | null
  /** The unrelated entries' paths, in spec order. */
  readonly unrelated: readonly string[]
  /** Releases the held flock (call it in `afterEach`); later calls, and calls with none held, do nothing. */
  release(): void
}

/** An owner's `Owner`: as given, or a live or gone `/ci` runner added to the table. */
function lockDirOwner(spec: LockDirOwnerSpec, processes: FakeProcessTable | undefined): Owner {
  if ('owner' in spec) return spec.owner
  if (processes === undefined) throw new Error('buildLockDir: an owner given by RUN_ID and liveness needs the spec\'s process table')
  const pid = processes.add(ciRunnerProcess(spec.runId, { alive: spec.alive }))
  return { runId: spec.runId, pid }
}

/** A valid holder record with one named change. Throws when the change leaves a record the runner still reads. */
function changedLockRecord(valid: string, change: LockRecordChange): string {
  const text = change === 'cut' ? valid.slice(0, Math.floor(valid.length / 2)) : change === 'empty' ? '' : change === 'second-line' ? `${valid}${valid}` : change.edit(valid)
  if (parseLockHolder(text) !== null) throw new Error(`buildLockDir: the change ${typeof change === 'string' ? change : change.what} leaves a holder record the runner reads`)
  return text
}

/** Writes the lock file's record in place through the runner's own lock-file primitive, then closes it. */
function writeLockRecord(path: string, text: string): void {
  const opened = openLockFile(path)
  if (!opened.ok) throw new Error(`buildLockDir: ${opened.error}`)
  try {
    const written = opened.value.writeText(text)
    if (!written.ok) throw new Error(`buildLockDir: ${written.error}`)
  } finally {
    opened.value.release()
  }
}

/** Takes an exclusive flock on the lock file on a second descriptor through the runner's primitive, and checks that a fresh descriptor finds it held. Answers its release. */
function holdLockFile(path: string): () => void {
  const opened = openLockFile(path)
  if (!opened.ok) throw new Error(`buildLockDir: ${opened.error}`)
  const file = opened.value
  const attempt = file.tryLock()
  if (attempt.kind !== 'taken') {
    file.release()
    throw new Error(`buildLockDir: the flock on ${path} could not be taken: ${attempt.kind === 'error' ? attempt.error : 'already held'}`)
  }
  if (probeFlock(path) !== 'held') {
    file.release()
    throw new Error(`buildLockDir: the flock on ${path} is not seen as held`)
  }
  return () => file.release()
}

/** Writes one reservation into the lock directory: valid through `writeReservation`, or with one named change. */
function writeLockDirReservation(lockDir: string, spec: LockDirReservationSpec, processes: FakeProcessTable | undefined): BuiltReservation {
  const owner = lockDirOwner(spec.owner, processes)
  const request = { owner, shards: spec.shards ?? 1, memoryCapBytes: spec.memoryCapBytes ?? SHARD_MEMORY_CAP_BYTES, kind: spec.kind ?? ('full' as RunKind) }
  const fileName = reservationFileName(owner)
  const path = join(lockDir, fileName)
  const change = spec.change
  if (change === undefined) {
    assertWritten(writeReservation(lockDir, request), 'buildLockDir')
  } else if (change.kind === 'dangling-link') {
    symlinkSync(join(lockDir, `${fileName}.missing`), path)
    return { owner, fileName, path, text: null }
  } else if (change.kind === 'owner') {
    if (change.owner.runId === owner.runId && change.owner.pid === owner.pid) throw new Error('buildLockDir: the owner change names the file name\'s own owner')
    assertWritten(writeWholeFile(lockDir, fileName, serializeReservation(buildReservation({ ...request, owner: change.owner }))), 'buildLockDir')
  } else {
    assertWritten(writeWholeFile(lockDir, fileName, changedJsonText(serializeReservation(buildReservation(request)), change)), 'buildLockDir')
  }
  return { owner, fileName, path, text: readFileSync(path, 'utf-8') }
}

/** Writes one unrelated entry and answers its path; throws for a name the runner would read as a reservation or as the lock file. */
function writeUnrelatedEntry(lockDir: string, spec: UnrelatedEntrySpec, processes: FakeProcessTable | undefined): string {
  const validText = (owner: Owner): string => serializeReservation(buildReservation({ owner, shards: 1, memoryCapBytes: SHARD_MEMORY_CAP_BYTES, kind: 'full' }))
  let name: string
  let text: string | null = null
  switch (spec.kind) {
    case 'file':
      name = spec.name ?? 'notes.txt'
      text = spec.text ?? ''
      break
    case 'json-no-owner':
      name = `${spec.stem ?? 'not-an-owner'}${RESERVATION_FILE_SUFFIX}`
      text = spec.owner === undefined ? '' : validText(lockDirOwner(spec.owner, processes))
      break
    case 'reservation-temp': {
      const owner = lockDirOwner(spec.owner, processes)
      name = reservationTempFileName(owner)
      text = validText(owner)
      break
    }
    case 'directory':
      name = spec.name ?? 'subdir'
      break
  }
  assertPlainEntryName(name, 'buildLockDir')
  const path = join(lockDir, name)
  if (reservationOwnerFromFileName(name) !== null || path === admissionLockPath(lockDir)) throw new Error(`buildLockDir: ${JSON.stringify(name)} is no unrelated name`)
  if (text === null) mkdirSync(path)
  else writeFileSync(path, text, { flag: 'wx' })
  return path
}

/**
 * Builds a lock directory under the caller's own temporary root (b.uqm
 * SR-21.4): the directories, then the lock file (its record written, then its
 * flock taken when asked), the reservations, the vanishing reservation and the
 * unrelated entries, in that order, each owner given by RUN_ID and liveness
 * added to `spec.processes` in that order too. A held flock blocks the
 * runner's take until `release()`.
 */
export function buildLockDir(root: string, spec: LockDirSpec = {}): BuiltLockDir {
  if (!isAbsolute(root) || !lstatSync(root).isDirectory()) throw new Error(`buildLockDir: ${root} is not the caller's temporary root`)
  const layout = spec.layout ?? 'home'
  const name = spec.name ?? (layout === 'bare' ? 'lock-dir' : 'account-home')
  assertPlainEntryName(name, 'buildLockDir')
  const home = layout === 'bare' ? null : join(root, name)
  const lockDir = home === null ? join(root, name) : admissionLockDir(home)
  const lockPath = admissionLockPath(lockDir)
  if (home !== null) mkdirSync(home)
  if (layout === 'home-only') {
    if (spec.lockFile !== undefined || spec.reservations !== undefined || spec.vanishing !== undefined || spec.unrelated !== undefined) {
      throw new Error('buildLockDir: a home without its lock directory holds nothing')
    }
  } else {
    mkdirSync(lockDir, { recursive: true, mode: RUN_DIR_MODE })
    chmodSync(lockDir, RUN_DIR_MODE)
  }

  let holder: Owner | null = null
  let lockText: string | null = null
  let releaseFlock: (() => void) | null = null
  if (spec.lockFile !== undefined) {
    holder = lockDirOwner(spec.lockFile.holder, spec.processes)
    const valid = formatLockHolder(holder)
    const parsed = parseLockHolder(valid)
    if (parsed === null || parsed.runId !== holder.runId || parsed.pid !== holder.pid) throw new Error(`buildLockDir: ${JSON.stringify(valid)} is no holder record`)
    lockText = spec.lockFile.change === undefined ? valid : changedLockRecord(valid, spec.lockFile.change)
    writeLockRecord(lockPath, lockText)
    if (spec.lockFile.held === true) releaseFlock = holdLockFile(lockPath)
  }

  const reservations = (spec.reservations ?? []).map((reservation) => writeLockDirReservation(lockDir, reservation, spec.processes))

  let vanishing: VanishingReservation | null = null
  if (spec.vanishing !== undefined) {
    const built = writeLockDirReservation(lockDir, spec.vanishing, spec.processes)
    if (!reservations.some((reservation) => reservation.fileName < built.fileName)) {
      throw new Error(`buildLockDir: the vanishing reservation ${built.fileName} needs a reservation whose name sorts before it, whose read probes an owner first`)
    }
    let gone = false
    const vanish = (): void => {
      if (gone) return
      gone = true
      rmSync(built.path, { force: true })
    }
    vanishing = {
      ...built,
      vanish,
      probe: (inner) => ({
        isPidAlive: (pid) => {
          vanish()
          return inner.isPidAlive(pid)
        },
        readProcCmdline: (pid) => {
          vanish()
          return inner.readProcCmdline(pid)
        },
      }),
    }
  }

  const unrelated = (spec.unrelated ?? []).map((entry) => writeUnrelatedEntry(lockDir, entry, spec.processes))

  return {
    home,
    lockDir,
    lockPath,
    holder,
    lockText,
    held: releaseFlock !== null,
    reservations,
    vanishing,
    unrelated,
    release() {
      const release = releaseFlock
      releaseFlock = null
      release?.()
    },
  }
}

// The password file (b.uqm SR-6.1, SR-21.4).

/** The b.uqm SR-21.4 password-file cases, by what the runner's user ID has in the file. */
export type PasswordFileCase =
  /** A first matching line that gives the home. */
  | 'first-match'
  /** That first matching line, and a later one for the same user ID giving another home. */
  | 'later-match'
  /** A first matching line of six fields (its shell dropped), its home still absolute. */
  | 'fewer-fields'
  /** A first matching line whose home field is empty. */
  | 'empty-home'
  /** A first matching line whose home is relative (the home without its leading slashes). */
  | 'relative-home'
  /** A first matching line of six fields, then a valid line for the same user ID giving the home. */
  | 'later-line-after-malformed'
  /** Its only line has the user ID with a leading zero. */
  | 'uid-leading-zero'
  /** Its only line has the user ID after a space. */
  | 'uid-leading-space'
  /** Its only line has the user ID before a space. */
  | 'uid-trailing-space'
  /** No line for the user ID at all. */
  | 'no-line'

/** What the password-file rule finds for a case: the home, no line for the user ID, or a first such line that gives no home. */
export type PasswordFileFinding = 'home' | Exclude<AccountHomeFailure['kind'], 'unreadable'>

/** One password-file case for a user ID and home. */
export interface PasswordFileRow {
  readonly name: PasswordFileCase
  /** What the case is, for a table's row label. */
  readonly label: string
  readonly text: string
  /** The home the rule gives: the given home, or undefined. */
  readonly home: string | undefined
  readonly finding: PasswordFileFinding
}

/** Test data: the account names, the shell and the other homes' suffixes of the constructed password files. */
const PASSWORD_ACCOUNT_NAME = 'ci-account'
const PASSWORD_OTHER_BEFORE_NAME = 'other-before'
const PASSWORD_OTHER_AFTER_NAME = 'other-after'
const PASSWORD_SHELL = '/bin/sh'
const LATER_MATCH_HOME_SUFFIX = '-later'

/** One password-file line: name, password, user ID, group ID, comment, home, shell (passwd(5)). */
function passwordFields(name: string, uidField: string, gid: number, home: string): string[] {
  return [name, 'x', uidField, String(gid), '', home, PASSWORD_SHELL]
}

/**
 * Every b.uqm SR-21.4 password-file case for `uid` and `home`, by name. Each
 * text holds, around the case's lines, a line before for the user ID `<uid>0`
 * (which is not `uid`) and a line after for `uid + 1`, each with its own home.
 * A malformed case is the first-match line with one named change.
 */
export function passwordFileCases(uid: number, home: string): Readonly<Record<PasswordFileCase, PasswordFileRow>> {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(uid + 1)) throw new Error(`passwordFileCases: ${uid} is no user ID`)
  const relativeHome = home.replace(/^\/+/, '')
  if (!isAbsolute(home) || relativeHome === '' || /[:\n\r]/.test(home)) throw new Error(`passwordFileCases: ${JSON.stringify(home)} is no home a password-file line can give`)
  const own = String(uid)
  const valid = passwordFields(PASSWORD_ACCOUNT_NAME, own, uid, home)
  const line = (fields: readonly string[]): string => fields.join(':')
  const withField = (index: number, value: string): string[] => valid.map((field, at) => (at === index ? value : field))
  const sixFields = valid.slice(0, -1)
  const text = (...lines: string[]): string =>
    linesText([
      line(passwordFields(PASSWORD_OTHER_BEFORE_NAME, `${own}0`, uid, `${home}-${PASSWORD_OTHER_BEFORE_NAME}`)),
      ...lines,
      line(passwordFields(PASSWORD_OTHER_AFTER_NAME, String(uid + 1), uid, `${home}-${PASSWORD_OTHER_AFTER_NAME}`)),
    ])
  // The field positions of passwd(5): the user ID third, the home sixth.
  const UID_FIELD = 2
  const HOME_FIELD = 5
  const rows: readonly Omit<PasswordFileRow, 'home'>[] = [
    { name: 'first-match', label: 'a first matching line giving the home', text: text(line(valid)), finding: 'home' },
    {
      name: 'later-match',
      label: 'a first matching line, then a later one giving another home',
      text: text(line(valid), line(withField(HOME_FIELD, `${home}${LATER_MATCH_HOME_SUFFIX}`))),
      finding: 'home',
    },
    { name: 'fewer-fields', label: 'a first matching line of fewer than seven fields', text: text(line(sixFields)), finding: 'no-home' },
    { name: 'empty-home', label: 'a first matching line with an empty home', text: text(line(withField(HOME_FIELD, ''))), finding: 'no-home' },
    { name: 'relative-home', label: 'a first matching line with a relative home', text: text(line(withField(HOME_FIELD, relativeHome))), finding: 'no-home' },
    {
      name: 'later-line-after-malformed',
      label: 'a first matching line of fewer than seven fields, then a valid one',
      text: text(line(sixFields), line(valid)),
      finding: 'no-home',
    },
    { name: 'uid-leading-zero', label: 'a user-ID field with a leading zero', text: text(line(withField(UID_FIELD, `0${own}`))), finding: 'no-entry' },
    { name: 'uid-leading-space', label: 'a user-ID field with a leading space', text: text(line(withField(UID_FIELD, ` ${own}`))), finding: 'no-entry' },
    { name: 'uid-trailing-space', label: 'a user-ID field with a trailing space', text: text(line(withField(UID_FIELD, `${own} `))), finding: 'no-entry' },
    { name: 'no-line', label: 'no line for the user ID', text: text(), finding: 'no-entry' },
  ]
  return Object.fromEntries(rows.map((row) => [row.name, { ...row, home: row.finding === 'home' ? home : undefined }])) as Record<PasswordFileCase, PasswordFileRow>
}

/** Writes a password-file text under the caller's root (default name `passwd`) and answers its path. */
export function writePasswordFile(root: string, text: string, name = 'passwd'): string {
  assertPlainEntryName(name, 'writePasswordFile')
  const path = join(root, name)
  writeFileSync(path, text, { flag: 'wx' })
  return path
}

/** A password file that cannot be read: a directory at its path under the caller's root (default name `passwd-unreadable`), which fails a file read whatever the user, root included. Answers its path. */
export function writeUnreadablePasswordFile(root: string, name = 'passwd-unreadable'): string {
  assertPlainEntryName(name, 'writeUnreadablePasswordFile')
  const path = join(root, name)
  mkdirSync(path)
  return path
}

/** The runner's `readPasswordFile` dependency over a constructed password file: its text, or the read's failure on one line. */
export function passwordFileReader(path: string): RunnerDeps['readPasswordFile'] {
  return () => {
    try {
      return { ok: true, value: readFileSync(path, 'utf-8') }
    } catch (err) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)).replace(/\s*[\r\n]+\s*/g, ' ').trim() }
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Cgroups, /ci-live and readings (E6)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. Sample sequences (E7)
// ---------------------------------------------------------------------------
