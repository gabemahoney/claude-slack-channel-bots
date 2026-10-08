#!/usr/bin/env bun
/**
 * scripts/ci-run.ts — the `/ci` host runner: it runs the integration scripts
 * in up to six capped, isolated shards from one pinned image, admitted under
 * the host's memory, disk and CPU lines, and merges the shards' results into
 * one verdict (b.uqm).
 *
 * Usage:  bun scripts/ci-run.ts <RUN_ID> [the /ci arguments]...
 *
 * Import safety (b.uqm SR-1.3). Importing this file runs nothing: no process,
 * no file read or write, no lock, no signal handler. Its top level holds only
 * imports, declarations and exports; there is no top-level call, `new` or
 * `await` outside the one entry block at the very end of the file, which acts
 * only when the file is run as the main module. Every input and side effect
 * goes through one injected dependency object, `RunnerDeps`, whose real
 * bindings are built only by `createRealRunnerDeps`, which only that entry
 * block calls. Component tests drive every branch in process through fakes;
 * there is no test-only option or environment variable. At run time the file
 * loads only `node:` built-ins, `bun` and `bun:ffi`, so all of the runner's
 * code lives in this one file, and the verdict reader (`scripts/ci-verdict.ts`)
 * imports the shared rules from it.
 *
 * Section map. Each section has one owning Epic of Plan b.t6s and is written
 * only by it (and by the Epics its body lists under "Contributes to"); a code
 * Task writes under its own sub-banner, so parallel lanes write disjoint lines:
 *
 *    1. entry and dependencies (E1)
 *    2. constants (E1)
 *    3. data model (E1)
 *    4. shared rules (E1)
 *    5. file formats (E1)
 *    6. docker layer (E1)
 *    7. validation (E2)
 *    8. scheduling (E4)
 *    9. lock, reservations and sweep (E5)
 *   10. admission readings and fit (E6)
 *   11. memory guard (E7)
 *   12. images (E8)
 *   13. shard containers (E9)
 *   14. outcomes, verdict and results (E10)
 *   15. integrity and secret-scan (E11)
 *   16. faults (E12)
 *   17. run lifecycle (E1 steps 1–2, E13 the rest)
 *   18. main entry (E1)
 *
 * Not in `package.json` `files`: never shipped.
 *
 * SPDX-License-Identifier: MIT
 */

import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import { readFileSync, readlinkSync, realpathSync, statfsSync, writeSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 1. Entry and dependencies (E1)
// ---------------------------------------------------------------------------
//
// The injected-dependency interface (b.uqm SR-1.3) and the one factory that
// builds its real bindings. Two inputs SR-1.3 lists have no member of their
// own, by design:
//
// - The run directory and the system temp directory are derived from the
//   injected environment (`RunnerDeps.env`) by the run-directory path rule
//   (section 4, T3): `$TMPDIR` when set and not empty, else `/tmp`. A test
//   injects them by setting `TMPDIR` in the environment it passes.
// - The account's home is derived from the password file's text
//   (`RunnerDeps.readPasswordFile`) by E5's rule (b.uqm SR-6.1), never from
//   `$HOME`, `os.homedir()` or `os.userInfo()`.

/** A dependency's answer: its value, or a failure with its error on one line. */
export type DepRead<T> =
  | {
      readonly ok: true
      readonly value: T
    }
  | {
      readonly ok: false
      readonly error: string
    }

/** A `/proc` read for one PID: its value, the PID gone, or another failure on one line. */
export type ProcRead<T> =
  | {
      readonly kind: 'value'
      readonly value: T
    }
  | {
      readonly kind: 'gone'
    }
  | {
      readonly kind: 'unreadable'
      readonly error: string
    }

/** One child process to start (b.uqm SR-1.3, SR-15.4). */
export interface SpawnRequest {
  /** The program and its arguments; `argv[0]` is looked up on the environment's `PATH`. */
  readonly argv: readonly string[]
  /** The child's whole environment: nothing else reaches it (b.uqm SR-15.4). */
  readonly env: Readonly<Record<string, string>>
  /** The child's working directory. */
  readonly cwd: string
  /** Start the child in a new process group of its own, apart from the runner's (b.uqm SR-5.6). */
  readonly ownProcessGroup: boolean
  /** Text written to the child's standard input, then closed; none when absent. */
  readonly stdin?: string
  /** Receives each line of standard output and standard error as it arrives, without its line feed (build output). */
  readonly onOutputLine?: (line: string) => void
}

/** How a child ended. */
export interface SpawnResult {
  /** Its exit status; 128 + the signal number when a signal ended it; 127 when it could not be started. */
  readonly exitCode: number
  /** Its standard output as bytes, binary-safe (a `docker cp` archive). */
  readonly stdout: Uint8Array
  /** Its standard error as text; for a child that could not be started, why. */
  readonly stderr: string
}

/** A started child: signal it through `RunnerDeps.sendSignal`, await `result`. */
export interface SpawnedChild {
  /** Its PID; null when it could not be started. */
  readonly pid: number | null
  /** Its process group when it was started in its own (equal to its PID); null otherwise. */
  readonly processGroup: number | null
  /** Settles when the child has ended and its output is read; never rejects. */
  readonly result: Promise<SpawnResult>
}

/** Starts one child process. */
export type SpawnFn = (request: SpawnRequest) => SpawnedChild

/** The clock and timers. A `createFakeClock()` value satisfies it with no cast. */
export interface RunnerClock {
  /** Current time in epoch milliseconds. */
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

/** The volume holding a path (b.uqm SR-6.5). */
export interface VolumeReading {
  /** The mount point of the volume holding the path. */
  readonly mountPoint: string
  /** Its size minus its free bytes. */
  readonly usedBytes: number
  /** The bytes available to the runner. */
  readonly availableBytes: number
}

/** The signals the runner traps (b.uqm SR-5.4). */
export type TrappedSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'

/** The signals the runner sends: SIGKILL to a build's process group (b.uqm SR-5.6); SIGTERM, then SIGKILL, by the reader's stop verb (b.uqm SR-17.6). */
export type SentSignal = 'SIGTERM' | 'SIGKILL'

/** Where a signal goes: one PID, or every process of one process group. */
export type SignalTarget =
  | {
      readonly kind: 'pid'
      readonly pid: number
    }
  | {
      readonly kind: 'group'
      readonly processGroup: number
    }

/** What sending a signal found: delivered, no such process, or a process the runner may not signal. */
export type SignalOutcome = 'delivered' | 'no-such-process' | 'not-permitted'

/**
 * Every input and side effect of the runner (b.uqm SR-1.3), one member per
 * line. Only `createRealRunnerDeps` binds the real ones.
 */
export interface RunnerDeps {
  /** Starts a child process (docker, git, npm, gh, the base-build step) with its own environment and process group. */
  readonly spawn: SpawnFn
  /** The runner's own environment; children get it through the child-environment rule (b.uqm SR-15.4). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The runner's PID. */
  readonly pid: number
  /** The runner's user ID. */
  readonly uid: number
  /** The worktree root: by default, the tree that holds this file. */
  readonly worktreeRoot: string
  /** The admission lock's directory. Tests set it; the real binding leaves it unset and E13 binds it at step 6 from E5's account-home rule. */
  readonly lockDir?: string
  /** The password file's text (`/etc/passwd` in the real binding), or a failure (b.uqm SR-6.1). */
  readonly readPasswordFile: () => DepRead<string>
  /** One file of one cgroup, by its path below the cgroup-namespace root as `/proc/<pid>/cgroup` gives it (`/` for the root itself); one read per file. */
  readonly readCgroupFile: (cgroupPath: string, fileName: string) => DepRead<string>
  /** A PID's command line as its argument list. */
  readonly readProcCmdline: (pid: number) => ProcRead<readonly string[]>
  /** A PID's working-directory link. */
  readonly readProcCwd: (pid: number) => ProcRead<string>
  /** A PID's cgroup membership line (`0::<path>`). */
  readonly readProcCgroup: (pid: number) => ProcRead<string>
  /** The volume holding a path: its mount point, used and available bytes (b.uqm SR-6.5). */
  readonly readVolume: (path: string) => DepRead<VolumeReading>
  /** The clock and timers. */
  readonly clock: RunnerClock
  /** `count` random bytes (each shard's canary, b.uqm SR-11.3). */
  readonly randomBytes: (count: number) => Uint8Array
  /** Sends a signal to a PID or to a whole process group. */
  readonly sendSignal: (target: SignalTarget, signal: SentSignal) => SignalOutcome
  /** Registers a handler for SIGINT, SIGTERM or SIGHUP; answers its remover. Only E13's traps call it (b.uqm SR-5.4). */
  readonly onSignal: (signal: TrappedSignal, handler: (signal: TrappedSignal) => void) => () => void
  /** Whether a PID is a live process (b.uqm SR-6.3). */
  readonly isPidAlive: (pid: number) => boolean
  /** Writes text to standard error, so main can be driven in process. */
  readonly writeStderr: (text: string) => void
}

/** The cgroup-namespace root in the real binding (b.uqm SR-7.1). */
const REAL_CGROUP_ROOT = '/sys/fs/cgroup'
/** The password file in the real binding; E5's refusal names it (b.uqm SR-6.1). */
export const REAL_PASSWORD_FILE = '/etc/passwd'
/** The `/proc` root in the real binding. */
const REAL_PROC_ROOT = '/proc'
/** The runner's own mount table in the real binding, read for a volume's mount point. */
const REAL_MOUNTINFO_FILE = '/proc/self/mountinfo'
/** The exit status `SpawnResult` gives a child that could not be started (its PID null), as a shell gives one it cannot find; the spawn recorder imitates it (b.uqm SR-21.4). */
export const SPAWN_FAILED_EXIT_STATUS = 127
/** The exit status base for a child a signal ended, as a shell reports it (SIGKILL: 137). */
const SIGNAL_EXIT_STATUS_BASE = 128
/** The cgroup v2 membership line's prefix in `/proc/<pid>/cgroup`. */
const CGROUP_V2_LINE_PREFIX = '0::'

/**
 * Builds the real bindings from `node:` built-ins and `bun`. Called only by
 * the main-module entry block (section 18); never at import.
 */
export function createRealRunnerDeps(): RunnerDeps {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('ci-run: this platform gives no user ID')
  return {
    spawn: spawnChild,
    env: { ...process.env },
    pid: process.pid,
    uid,
    worktreeRoot: resolve(import.meta.dir, '..'),
    readPasswordFile: () => readTextFile(REAL_PASSWORD_FILE),
    readCgroupFile: readRealCgroupFile,
    readProcCmdline: (pid) => readProc(pid, 'cmdline', cmdlineArguments),
    readProcCwd: (pid) => readProcLink(pid, 'cwd'),
    readProcCgroup: (pid) => readProcCgroupLine(pid),
    readVolume: readRealVolume,
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    randomBytes: (count) => cryptoRandomBytes(count),
    sendSignal: sendRealSignal,
    onSignal: (signal, handler) => {
      const listener = (): void => handler(signal)
      process.on(signal, listener)
      return () => {
        process.off(signal, listener)
      }
    },
    isPidAlive: isRealPidAlive,
    writeStderr: (text) => {
      writeSync(2, text)
    },
  }
}

/** A thrown value's message on one line. */
function dependencyErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/** A thrown value's errno code, when it has one. */
function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** A file's whole text, or a failure. */
function readTextFile(path: string): DepRead<string> {
  try {
    return { ok: true, value: readFileSync(path, 'utf-8') }
  } catch (err) {
    return { ok: false, error: dependencyErrorText(err) }
  }
}

/** A cgroup path below the namespace root that stays below it: absolute, with no `.` or `..` segment. */
function isContainedCgroupPath(cgroupPath: string): boolean {
  return cgroupPath.startsWith('/') && !cgroupPath.split('/').some((segment) => segment === '.' || segment === '..')
}

function readRealCgroupFile(cgroupPath: string, fileName: string): DepRead<string> {
  if (!isContainedCgroupPath(cgroupPath)) return { ok: false, error: `not a cgroup path below the namespace root: ${cgroupPath}` }
  if (fileName === '' || fileName.includes('/') || fileName === '.' || fileName === '..') {
    return { ok: false, error: `not a cgroup file name: ${fileName}` }
  }
  return readTextFile(join(REAL_CGROUP_ROOT, cgroupPath, fileName))
}

/** Whether a value can name a process: a whole number above 0. */
function isProcessId(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0
}

/** A failed `/proc` read: gone when the PID's entry no longer exists. */
function procFailure<T>(err: unknown): ProcRead<T> {
  const code = errnoCode(err)
  if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'gone' }
  return { kind: 'unreadable', error: dependencyErrorText(err) }
}

function readProc<T>(pid: number, entry: string, parse: (raw: string) => T): ProcRead<T> {
  if (!isProcessId(pid)) return { kind: 'unreadable', error: `not a PID: ${pid}` }
  try {
    return { kind: 'value', value: parse(readFileSync(join(REAL_PROC_ROOT, String(pid), entry), 'utf-8')) }
  } catch (err) {
    return procFailure(err)
  }
}

/** `/proc/<pid>/cmdline`'s NUL-terminated arguments as a list; empty for a process with none (a zombie). */
function cmdlineArguments(raw: string): readonly string[] {
  if (raw === '') return []
  const parts = raw.split('\0')
  return raw.endsWith('\0') ? parts.slice(0, -1) : parts
}

function readProcLink(pid: number, entry: string): ProcRead<string> {
  if (!isProcessId(pid)) return { kind: 'unreadable', error: `not a PID: ${pid}` }
  try {
    return { kind: 'value', value: readlinkSync(join(REAL_PROC_ROOT, String(pid), entry)) }
  } catch (err) {
    return procFailure(err)
  }
}

function readProcCgroupLine(pid: number): ProcRead<string> {
  const read = readProc(pid, 'cgroup', (raw) => raw.split('\n').find((line) => line.startsWith(CGROUP_V2_LINE_PREFIX)))
  if (read.kind !== 'value') return read
  if (read.value === undefined) return { kind: 'unreadable', error: `no cgroup v2 line for PID ${pid}` }
  return { kind: 'value', value: read.value }
}

/** A mountinfo field with its octal escapes (`\040` for a space) decoded. */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

/** The mount point holding `path` (a resolved absolute path): the longest mountinfo mount point that contains it, the last mounted on a tie. */
function mountPointOf(path: string, mountinfo: string): string {
  let best = '/'
  for (const line of mountinfo.split('\n')) {
    const field = line.split(' ')[4]
    if (field === undefined) continue
    const mountPoint = unescapeMountField(field)
    const contains = mountPoint === '/' || path === mountPoint || path.startsWith(`${mountPoint}/`)
    if (contains && mountPoint.length >= best.length) best = mountPoint
  }
  return best
}

function readRealVolume(path: string): DepRead<VolumeReading> {
  try {
    const target = realpathSync(path)
    const stats = statfsSync(target)
    return {
      ok: true,
      value: {
        mountPoint: mountPointOf(target, readFileSync(REAL_MOUNTINFO_FILE, 'utf-8')),
        usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
        availableBytes: stats.bavail * stats.bsize,
      },
    }
  } catch (err) {
    return { ok: false, error: dependencyErrorText(err) }
  }
}

function sendRealSignal(target: SignalTarget, signal: SentSignal): SignalOutcome {
  const id = target.kind === 'pid' ? target.pid : target.processGroup
  // Never 0 or a negative ID: those reach the runner's own group or every process.
  if (!isProcessId(id)) return 'no-such-process'
  try {
    process.kill(target.kind === 'pid' ? id : -id, signal)
    return 'delivered'
  } catch (err) {
    return errnoCode(err) === 'EPERM' ? 'not-permitted' : 'no-such-process'
  }
}

function isRealPidAlive(pid: number): boolean {
  if (!isProcessId(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists, as another user's.
    return errnoCode(err) === 'EPERM'
  }
}

/** A child stream's bytes as read, and why its reading stopped early (null when it was read to its end). */
interface CollectedStream {
  readonly bytes: Uint8Array
  readonly readError: string | null
}

/** Hands one line to the output sink; a sink that throws loses that line only, and the stream keeps draining. */
function deliverLine(onLine: (line: string) => void, line: string): void {
  try {
    onLine(line)
  } catch {
    // The sink's own failure is not the child's: drop the line, keep reading.
  }
}

/**
 * Reads a child's stream to its end as bytes, handing each complete text line
 * to `onLine` as it arrives. Never rejects: a throwing `onLine` costs only its
 * line and the stream keeps draining, so the child never blocks on a full
 * pipe; a read error ends the read, cancels the stream so the pipe closes, and
 * answers the bytes read so far with the error on one line.
 */
async function collectStream(stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void): Promise<CollectedStream> {
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  let pending = ''
  let readError: string | null = null
  const reader = stream.getReader()
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      chunks.push(next.value)
      if (onLine === undefined) continue
      const lines = (pending + decoder.decode(next.value, { stream: true })).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) deliverLine(onLine, line)
    }
  } catch (err) {
    readError = dependencyErrorText(err)
    await reader.cancel().catch(() => undefined)
  }
  if (onLine !== undefined) {
    const rest = pending + decoder.decode()
    if (rest !== '') deliverLine(onLine, rest)
  }
  return { bytes: Buffer.concat(chunks), readError }
}

/** A child's standard error as text, with a note on one line for each of its streams whose reading failed. */
function childStderrText(stdout: CollectedStream, stderr: CollectedStream): string {
  let text = new TextDecoder().decode(stderr.bytes)
  for (const [name, collected] of [
    ['standard output', stdout],
    ['standard error', stderr],
  ] as const) {
    if (collected.readError === null) continue
    if (text !== '' && !text.endsWith('\n')) text += '\n'
    text += `ci-run: reading the child's ${name} failed: ${collected.readError}\n`
  }
  return text
}

/** `Bun.spawn` for one request, its output piped; throws when the child cannot be started. */
function startChild(request: SpawnRequest) {
  return Bun.spawn([...request.argv], {
    cwd: request.cwd,
    env: { ...request.env },
    detached: request.ownProcessGroup,
    stdin: request.stdin === undefined ? 'ignore' : new TextEncoder().encode(request.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function spawnChild(request: SpawnRequest): SpawnedChild {
  let child: ReturnType<typeof startChild>
  try {
    child = startChild(request)
  } catch (err) {
    return {
      pid: null,
      processGroup: null,
      result: Promise.resolve({
        exitCode: SPAWN_FAILED_EXIT_STATUS,
        stdout: new Uint8Array(0),
        stderr: `could not start ${request.argv[0] ?? '(no program)'}: ${dependencyErrorText(err)}`,
      }),
    }
  }
  const started = child
  const result = Promise.all([
    collectStream(started.stdout, request.onOutputLine),
    collectStream(started.stderr, request.onOutputLine),
    started.exited,
  ]).then(([stdout, stderr, exited]) => ({
    exitCode: started.signalCode === null ? exited : SIGNAL_EXIT_STATUS_BASE + (osConstants.signals[started.signalCode] ?? 0),
    stdout: stdout.bytes,
    stderr: childStderrText(stdout, stderr),
  }))
  return {
    pid: started.pid,
    processGroup: request.ownProcessGroup ? started.pid : null,
    result,
  }
}

// ---------------------------------------------------------------------------
// 2. Constants (E1)
// ---------------------------------------------------------------------------
//
// Every numeric bound and fixed name of the runner (b.uqm SR-21.5), each
// under one name; tests import them, and one pin case per constant types its
// value. E3 adds the reader's constants in its own file, E5 the password-file
// pin, E6 the `/ci-live` copies. Every value is a literal, a regex literal or
// arithmetic over literals and other constants.

// --- Memory ---

/** One GiB, 2^30 bytes; every byte figure is built from it (b.uqm Terms). */
export const GIB_BYTES = 2 ** 30
/** The per-shard memory cap: it starts at 2 GiB and changes only by hand, as a committed change (b.uqm SR-8.1, SR-23.2). */
export const SHARD_MEMORY_CAP_BYTES = 2 * GIB_BYTES
/** The cap rule's minimum, 2 GiB (b.uqm SR-8.1, SR-8.3). */
export const MIN_SHARD_MEMORY_CAP_BYTES = 2 * GIB_BYTES
/** The cap rule's margin over the highest anon peak, 1 GiB (b.uqm SR-8.3). */
export const CAP_MARGIN_BYTES = GIB_BYTES
/** The cap rule rounds up to a multiple of 0.5 GiB (b.uqm SR-8.3). */
export const CAP_ROUNDING_STEP_BYTES = GIB_BYTES / 2
/** The memory fit's admission margin, 1 GiB (b.uqm SR-6.7). */
export const ADMISSION_MARGIN_BYTES = GIB_BYTES
/** The ceiling C as a percentage of the pod limit L, the sysadmin monitor's warn line (b.uqm SR-7.1). */
export const MEMORY_CEILING_PERCENT = 85
/** `/ci`'s own disk line, as a percentage of the volume (b.uqm SR-6.7). */
export const DISK_LINE_PERCENT = 85
/** The disk check's allowance for the run's own files, 1 GiB (b.uqm SR-6.7, SR-6.8). */
export const DISK_CHECK_ALLOWANCE_BYTES = GIB_BYTES
/** The stop line sits this far below the ceiling, 0.5 GiB (b.uqm SR-7.4). */
export const STOP_LINE_OFFSET_BYTES = GIB_BYTES / 2
/** The allowance for a `/ci-live` run's own runner in its 13 GiB commitment, 1 GiB (b.uqm SR-6.6). */
export const CI_LIVE_RUNNER_ALLOWANCE_BYTES = GIB_BYTES

// --- CPUs and ranges ---

/** The CPUs all `/ci` runs share, 12 (b.uqm SR-6.6). */
export const CI_CPUS = 12
/** The CPUs each shard takes, its `--cpus` (b.uqm SR-6.6, SR-10.2). */
export const CPUS_PER_SHARD = 2
/** The lower bound of the `--shards` and `--shard-timeout` ranges (b.uqm SR-2.2). */
export const OPTION_RANGE_MIN = 1
/** The maximum N, `--shards`' upper bound; also the requested N when `--shards` is not given (b.uqm SR-2.2, SR-3.4). */
export const MAX_SHARDS = 6
/** `--shard-timeout`'s upper bound, in minutes (b.uqm SR-2.2). */
export const MAX_SHARD_TIMEOUT_MINUTES = 720

// --- Timing ---

/** The memory watchdog's sample interval, 30 s (b.uqm SR-7.3). */
export const SAMPLE_INTERVAL_MS = 30_000
/** A due `timeout:` or `kill:` fault's result-file poll, at least every 1 s (b.uqm SR-14.2). */
export const FAULT_POLL_INTERVAL_MS = 1_000
/** The inspection read's one retry, 1 s after a failed read (b.uqm SR-10.5). */
export const INSPECTION_REREAD_DELAY_MS = 1_000
/** Retries of a prune Docker refuses as already running, so at most 4 tries (b.uqm SR-9.3). */
export const PRUNE_RETRIES = 3
/** The wait before each prune retry, 1 s (b.uqm SR-9.3). */
export const PRUNE_RETRY_INTERVAL_MS = 1_000
/** Docker's refusal of an image prune while another runs (b.uqm SR-9.3, SR-23.6). */
export const PRUNE_ALREADY_RUNNING_TEXT = 'a prune operation is already running'
/** The longest wait for the admission lock, 30 s (b.uqm SR-6.1). */
export const LOCK_WAIT_MS = 30_000
/** A script's estimate when the duration table gives none, 2400 s (b.uqm SR-4.1). */
export const DEFAULT_ESTIMATE_SECONDS = 2400
/** A shard limit's factor on its expected total (b.uqm SR-4.3). */
export const LIMIT_FACTOR = 2
/** A shard limit's addend, 15 min (b.uqm SR-4.3). */
export const LIMIT_ADDEND_MINUTES = 15
/** A shard limit's floor, 30 min (b.uqm SR-4.3). */
export const LIMIT_FLOOR_MINUTES = 30
/** A script slower than this many times its estimate gets a `slow:` line (b.uqm SR-4.4). */
export const SLOW_FACTOR = 1.5
/** The run deadline's build allowance B, 30 min (b.uqm SR-5.5). */
export const BUILD_ALLOWANCE_MINUTES = 30
/** The run deadline's addition once the base image is found missing, 60 min (b.uqm SR-5.5). */
export const BASE_BUILD_ALLOWANCE_MINUTES = 60
/** The run deadline's allowance after the largest shard limit, 15 min (b.uqm SR-5.5). */
export const MERGE_ALLOWANCE_MINUTES = 15

// --- Shard figures ---

/** A secret credential shorter than this is a bad credential (b.uqm SR-15.1). */
export const SECRET_MIN_LENGTH = 8
/** Each shard's `--pids-limit` (b.uqm SR-10.2). */
export const SHARD_PIDS_LIMIT = 2048
/** A shard canary's length in lowercase hexadecimal characters (b.uqm SR-11.2, SR-11.3). */
export const CANARY_LENGTH = 32

// --- Run-directory names ---

/** The run directory's name prefix, `cscb-ci-<RUN_ID>` (b.uqm SR-5.1). */
export const RUN_DIR_PREFIX = 'cscb-ci-'
/** The status file (b.uqm SR-5.2). */
export const STATUS_FILE_NAME = 'status.json'
/** The runner log (b.uqm SR-5.4). */
export const RUNNER_LOG_FILE_NAME = 'runner.log'
/** The run-private directory holding the tarball (b.uqm SR-5.9, SR-9.1). */
export const PACKAGE_DIR_NAME = 'package'
/** The results file (b.uqm SR-16.1). */
export const RESULTS_FILE_NAME = 'results.json'
/** The human-readable summary (b.uqm SR-16.2). */
export const SUMMARY_FILE_NAME = 'summary.txt'
/** The verdict file (b.uqm SR-5.7). */
export const VERDICT_FILE_NAME = 'verdict.txt'
/** A shard subdirectory's name prefix, `shard-<k>` (b.uqm Terms, SR-5.9). */
export const SHARD_DIR_PREFIX = 'shard-'

// --- In-shard names and words ---

/** The shard's canary file (b.uqm SR-11.3, SR-11.5). */
export const CANARY_FILE_NAME = 'canary.txt'
/** The shard's tarball hash file (b.uqm SR-11.3, SR-11.5). */
export const PACKAGE_SHA256_FILE_NAME = 'package.sha256'
/** The shard's result file (b.uqm SR-11.3, SR-11.5). */
export const RESULT_FILE_NAME = 'result.txt'
/** The shard's dependency fingerprint file (b.uqm SR-11.3, SR-11.5). */
export const DEPENDENCY_FINGERPRINT_FILE_NAME = 'dependency-fingerprint.txt'
/** The shard container's saved Docker logs (b.uqm SR-5.7, SR-11.5). */
export const DOCKER_LOG_FILE_NAME = 'docker.log'
/** A script log's suffix, `<file name>.log` (b.uqm SR-11.3). */
export const SCRIPT_LOG_SUFFIX = '.log'
/** The result-file word before each script (b.uqm SR-11.3, SR-11.5). */
export const RESULT_WORD_START = 'start'
/** The result-file word after each script (b.uqm SR-11.3, SR-11.5). */
export const RESULT_WORD_END = 'end'
/** The result-file word for a passed script (b.uqm SR-11.3, SR-11.5). */
export const RESULT_WORD_PASS = 'pass'
/** The result-file word for a failed script (b.uqm SR-11.3, SR-11.5). */
export const RESULT_WORD_FAIL = 'fail'
/** The result-file word for a script not reached (b.uqm SR-11.3, SR-11.5). */
export const RESULT_WORD_NOTRUN = 'notrun'
/** The result file's end marker line (b.uqm SR-11.3, SR-11.5). */
export const RESULT_WORD_DONE = 'done'

// --- Fixed texts ---

/** The injected-failure line's fixed text, `FAIL: <file name>: injected failure` (b.uqm SR-11.3, SR-14.2). */
export const INJECTED_FAILURE_TEXT = 'injected failure'
/** The in-container runner's image-marker refusal line, verbatim from `tests/runner.sh` at 946be79 (b.uqm SR-11.2, SR-11.5, SR-12.1). */
export const MARKER_REFUSAL_LINE = 'runner.sh: /etc/cscb-ci-image is absent: this runner runs only in a cscb-ci image (/ci); refusing to run'
/** The in-container runner's exit status after its image-marker refusal line, verbatim from `tests/runner.sh` at 946be79; not `REFUSAL_EXIT_STATUS`, the host runner's refused-run status (b.uqm SR-11.2). */
export const MARKER_REFUSAL_EXIT_STATUS = 2
/** A usage line's prefix (b.uqm SR-5.1, SR-11.2, SR-11.5). */
export const USAGE_PREFIX = 'usage: '
/** A refusal's prefix (b.uqm SR-5.8). */
export const NOT_RUN_PREFIX = 'NOT RUN: '
/** A failure line's prefix (b.uqm SR-12.4). */
export const FAIL_PREFIX = 'FAIL: '
/** What replaces a secret value in a written line (b.uqm SR-15.3). */
export const REDACTION_PLACEHOLDER = '<redacted>'

// --- Labels and tags ---

/** The label every `/ci` container carries, as `cscb-ci=1` (b.uqm SR-6.4, SR-10.1). */
export const CI_LABEL = 'cscb-ci'
/** The `cscb-ci` label's value (b.uqm SR-6.4, SR-10.1). */
export const CI_LABEL_VALUE = '1'
/** The owner label, `cscb-ci-owner=<RUN_ID>-<PID>` (b.uqm Terms, SR-9.3, SR-10.1). */
export const OWNER_LABEL = 'cscb-ci-owner'
/** The label a fault's drift or retag image carries (b.uqm SR-14.2). */
export const FAULT_LABEL = 'cscb-ci-fault'
/** The fault label's values, `cscb-ci-fault=drift` and `cscb-ci-fault=retag` (b.uqm SR-14.2). */
export const FAULT_LABEL_VALUES = ['drift', 'retag'] as const
/** The run-private tag repository, `cscb-ci-run:<RUN_ID>-<PID>-<role>` (b.uqm SR-9.3). */
export const RUN_TAG_REPOSITORY = 'cscb-ci-run'
/** The run-private tag roles (b.uqm SR-6.4, SR-9.3). */
export const RUN_TAG_ROLES = ['test', 'drift', 'retag'] as const

// --- Formats and exits ---

/** The status file's format version (b.uqm SR-5.2). */
export const STATUS_FORMAT_VERSION = 1
/** A reservation's format version (b.uqm SR-6.2). */
export const RESERVATION_FORMAT_VERSION = 1
/** The results file's format version (b.uqm SR-16.1). */
export const RESULTS_FORMAT_VERSION = 1
/** The word a reading that could not be read records (b.uqm SR-10.6, SR-16.1). */
export const UNREADABLE_READING = 'unreadable'
/** The runner-path suffix a live owner's command line holds, followed by its RUN_ID (b.uqm SR-6.3). */
export const RUNNER_PATH_SUFFIX = 'scripts/ci-run.ts'
/** The exit status of a runner whose first argument is not a RUN_ID (b.uqm SR-5.1). */
export const USAGE_EXIT_STATUS = 64
/** The exit status of a refused run. The SRD gives none and nothing reads it: the reader judges a run by its files (b.uqm SR-5.8). */
export const REFUSAL_EXIT_STATUS = 2

// --- Name patterns ---

/** A script's file name, `test-<n>-<slug>.sh`; group 1 is n (b.uqm Terms, SR-2.2, SR-2.3). */
export const SCRIPT_FILE_NAME_PATTERN = /^test-(0|[1-9][0-9]*)-[a-z0-9-]+\.sh$/
/** A script's number form, `test-<n>`; group 1 is n (b.uqm Terms, SR-2.2, SR-2.3). */
export const NUMBER_FORM_PATTERN = /^test-(0|[1-9][0-9]*)$/

// ---------------------------------------------------------------------------
// 3. Data model (E1)
// ---------------------------------------------------------------------------
//
// Every structure the sections exchange. One field per line, so an Epic that
// needs a new field adds it on its own line (and says so in its Task report).
// Where b.uqm SR-16.1 names a `results.json` key, the field carries that name.
// Read-only wherever a value is never mutated. This section emits no runtime
// code.

// --- Invocation and run kind ---

/** A `/ci` invocation, parsed (b.uqm SR-2.1, SR-2.2). */
export interface Invocation {
  /** The `/ci` arguments as given. */
  readonly args: readonly string[]
  /** The SCRIPT arguments, in order. */
  readonly scripts: readonly string[]
  /** `--shards`' value when given. */
  readonly shards: number | null
  /** `--shard-timeout`'s value in minutes when given. */
  readonly shardTimeoutMinutes: number | null
  /** The faults, normalized and de-duplicated, in first-occurrence order (b.uqm SR-2.4). */
  readonly faults: readonly Fault[]
}

/** A run's kind, as a reservation records it: a full run selects no script (b.uqm SR-2.5, SR-6.2). */
export type RunKind = 'full' | 'selective'

// --- Scripts, units and assignment ---

/** One integration script (b.uqm Terms). */
export interface Script {
  /** `test-<n>-<slug>.sh`. */
  readonly fileName: string
  /** n. */
  readonly number: number
  /** `test-<n>`. */
  readonly numberForm: string
}

/** A scheduling unit: one connected group of the prerequisite graph, test-1 excluded (b.uqm SR-3.4). */
export interface SchedulingUnit {
  /** Its scripts, in canonical order. */
  readonly scripts: readonly Script[]
}

/** One shard's assignment (b.uqm SR-4.2, SR-4.3, SR-16.1). */
export interface ShardAssignment {
  /** k, from 1. */
  readonly shard: number
  /** File names in run order, test-1 first. */
  readonly assigned: readonly string[]
  /** The sum of its scripts' estimates. */
  readonly expectedSeconds: number
  /** Its wall-time limit in minutes. */
  readonly limitMinutes: number
}

/** A run's assignment: one entry per shard, in shard order. */
export type Assignment = readonly ShardAssignment[]

// --- Faults ---

/** A fault's kind (b.uqm SR-2.4). */
export type FaultKind = 'fail' | 'timeout' | 'leak' | 'image-drift' | 'kill' | 'retag'

/** `fail:<script>`, its script as a number form. */
export interface FailFault {
  readonly kind: 'fail'
  readonly script: string
}

/** `timeout:<script>`, its script as a number form. */
export interface TimeoutFault {
  readonly kind: 'timeout'
  readonly script: string
}

/** `leak:<k>,<j>`: shard k's subdirectory mounted into shard j. */
export interface LeakFault {
  readonly kind: 'leak'
  /** k. */
  readonly sourceShard: number
  /** j. */
  readonly targetShard: number
}

/** `image-drift:<k>`. */
export interface ImageDriftFault {
  readonly kind: 'image-drift'
  readonly shard: number
}

/** `kill:<k>`. */
export interface KillFault {
  readonly kind: 'kill'
  readonly shard: number
}

/** `retag`. */
export interface RetagFault {
  readonly kind: 'retag'
}

/** One fault, normalized (b.uqm SR-2.4). */
export type Fault = FailFault | TimeoutFault | LeakFault | ImageDriftFault | KillFault | RetagFault

/** Where a fault stands (b.uqm SR-14.2, SR-14.3). */
export type FiringState = 'due' | 'fired' | 'not-fired'

/** One fault's firing record (b.uqm SR-14.2, SR-14.3). */
export interface FiringRecord {
  readonly fault: Fault
  /** The shard it acts on, once known; null for `retag`. */
  readonly shard: number | null
  /** A `leak:` fault's source shard k; null for every other fault. */
  readonly leakSourceShard: number | null
  readonly state: FiringState
  /** Why it did not fire; null unless `not-fired`. */
  readonly reason: string | null
}

/** A `timeout:` or `kill:` firing, handed to the one handler that stops its shard (b.uqm SR-14.2). */
export interface FaultDecision {
  readonly shard: number
  readonly fault: TimeoutFault | KillFault
  /** The cause it fixes for the shard before the stop (b.uqm SR-12.1). */
  readonly cause: ShardCause
}

// --- Owners and reservations ---

/** An owner, `<RUN_ID>-<PID>` (b.uqm Terms, SR-6.3). */
export interface Owner {
  readonly runId: string
  readonly pid: number
}

/** A reservation, exactly b.uqm SR-6.2's keys. */
export interface Reservation {
  readonly version: typeof RESERVATION_FORMAT_VERSION
  readonly runId: string
  readonly pid: number
  /** N. */
  readonly shards: number
  /** N × the cap. */
  readonly memoryBytes: number
  /** 2 × N. */
  readonly cpus: number
  readonly kind: RunKind
}

/** A valid reservation beside the lock, with its owner's liveness. */
export interface ListedReservation {
  readonly fileName: string
  readonly reservation: Reservation
  readonly ownerAlive: boolean
}

/** A reservation file that cannot be used (b.uqm SR-6.2). */
export interface BadReservationFile {
  readonly fileName: string
  /** Its owner's liveness, read from its file name. */
  readonly ownerAlive: boolean
  readonly reason: string
}

/** The reservations beside the lock, as E5's reader lists them. */
export interface ReservationListingRead {
  readonly kind: 'listed'
  readonly valid: readonly ListedReservation[]
  readonly bad: readonly BadReservationFile[]
}

/** A listing of the reservations that failed. */
export interface ReservationListingFailure {
  readonly kind: 'failed'
  readonly error: string
}

/** What E5's reservation reader returns. */
export type ReservationListing = ReservationListingRead | ReservationListingFailure

// --- Status and refusal ---

/** The status file's phases (b.uqm SR-5.2). */
export type StatusPhase = 'build' | 'shards' | 'merge' | 'refused'

/** The status file's deadline object, exactly its keys (b.uqm SR-5.2). */
export interface StatusDeadline {
  /** A UTC time. */
  readonly utc: string
  /** The same moment in whole seconds since the epoch, rounded down. */
  readonly epochSeconds: number
  /** The deadline's minutes from the start, rounded as b.uqm SR-5.5 rounds. */
  readonly minutes: number
}

/** A refusal's kind; null for every refusal but memory, disk and CPU (b.uqm SR-5.8). */
export type RefusalKind = 'memory' | 'disk' | 'cpu' | null

/** A refusal, exactly the status file's `refusal` keys (b.uqm SR-5.2, SR-5.8). */
export interface Refusal {
  readonly kind: RefusalKind
  /** The reason after `NOT RUN: `, without its `<kind>: ` when it has a kind. */
  readonly summary: string
  /** The detail lines in print order, none holding a line break. */
  readonly details: readonly string[]
}

/** The keys every status file holds (b.uqm SR-5.2). */
export interface StatusCommon {
  readonly version: typeof STATUS_FORMAT_VERSION
  readonly runId: string
  readonly pid: number
  /** The runner's start, a UTC time. */
  readonly startedAt: string
  readonly deadline: StatusDeadline
}

/** A status file in phase `build`, `shards` or `merge`: no `refusal`. */
export interface ActiveStatus extends StatusCommon {
  readonly phase: 'build' | 'shards' | 'merge'
  readonly refusal?: never
}

/** A status file in phase `refused`, with its `refusal`. */
export interface RefusedStatus extends StatusCommon {
  readonly phase: 'refused'
  readonly refusal: Refusal
}

/** The status file, exactly b.uqm SR-5.2's keys. */
export type RunStatus = ActiveStatus | RefusedStatus

// --- Result files ---

/** A script's result in a result file (b.uqm SR-11.3). */
export type ScriptResult = 'pass' | 'fail'

/** `start <file name>`. */
export interface StartEvent {
  readonly kind: 'start'
  readonly fileName: string
}

/** `end <file name> pass|fail <seconds>`. */
export interface EndEvent {
  readonly kind: 'end'
  readonly fileName: string
  readonly result: ScriptResult
  readonly seconds: number
}

/** `notrun <file name>`. */
export interface NotRunEvent {
  readonly kind: 'notrun'
  readonly fileName: string
}

/** The end marker line, `done`. */
export interface DoneEvent {
  readonly kind: 'done'
}

/** One complete result-file line (b.uqm SR-11.3). */
export type ResultEvent = StartEvent | EndEvent | NotRunEvent | DoneEvent

/** A result file as read (b.uqm SR-11.3, SR-12.1). */
export type ResultFileRead =
  | {
      readonly kind: 'events'
      readonly events: readonly ResultEvent[]
    }
  | {
      readonly kind: 'missing'
    }
  | {
      readonly kind: 'unreadable'
      readonly error: string
    }

// --- Shard causes ---

/** How a run-level stop names itself in a shard cause (b.uqm SR-12.1). */
export type StopKind = 'interrupt' | 'memory-watchdog' | 'run-deadline'

/** `wall-time limit of <m> min exceeded`: its limit or a `timeout:` fault. */
export interface WallTimeLimitCause {
  readonly kind: 'wall-time-limit'
  /** The minutes the line names. */
  readonly minutes: number
  readonly fixedByRunner: true
}

/** `container exited <code>`. */
export interface ContainerExitedCause {
  readonly kind: 'container-exited'
  readonly code: number
  readonly fixedByRunner: false
}

/** `killed`: a `kill:` fault. */
export interface KilledCause {
  readonly kind: 'killed'
  readonly fixedByRunner: true
}

/** `stopped by interrupt`, `stopped by memory watchdog` or `stopped by run deadline`. */
export interface StoppedCause {
  readonly kind: 'stopped'
  readonly by: StopKind
  readonly fixedByRunner: true
}

/** `container failed to start: <detail>`. */
export interface FailedToStartCause {
  readonly kind: 'failed-to-start'
  /** One line. */
  readonly detail: string
  readonly fixedByRunner: false
}

/** `image marker missing`. */
export interface ImageMarkerMissingCause {
  readonly kind: 'image-marker-missing'
  readonly fixedByRunner: false
}

/** `no result file`. */
export interface NoResultFileCause {
  readonly kind: 'no-result-file'
  readonly fixedByRunner: false
}

/** `result file unreadable`. */
export interface ResultFileUnreadableCause {
  readonly kind: 'result-file-unreadable'
  readonly fixedByRunner: false
}

/** A shard's end cause as a value; only E10 renders its text (b.uqm SR-12.1). */
export type ShardCause =
  | WallTimeLimitCause
  | ContainerExitedCause
  | KilledCause
  | StoppedCause
  | FailedToStartCause
  | ImageMarkerMissingCause
  | NoResultFileCause
  | ResultFileUnreadableCause

// --- Shard start and inspection ---

/** One bind mount (b.uqm SR-10.3, SR-10.5). */
export interface ShardMount {
  readonly source: string
  readonly target: string
  readonly readOnly: boolean
}

/** What every shard-start outcome records (b.uqm SR-10.1, SR-10.3, SR-13.2). */
export interface ShardStartCommon {
  readonly shard: number
  /** The image ID it was started from: the pinned ID, or the drift image's. */
  readonly imageId: string
  /** The mounts applied, leak mounts included. */
  readonly mounts: readonly ShardMount[]
  /** Whether its name was in use when it started. */
  readonly nameInUse: boolean
  /** Its canary. */
  readonly canary: string
}

/** A shard whose container started. */
export interface ShardStarted extends ShardStartCommon {
  readonly kind: 'started'
  /** The container's start time, epoch milliseconds. */
  readonly startedAtMs: number
}

/** A shard whose container failed to start. */
export interface ShardStartFailed extends ShardStartCommon {
  readonly kind: 'failed-to-start'
  /** One line. */
  readonly detail: string
}

/** A shard's start outcome. */
export type ShardStart = ShardStarted | ShardStartFailed

/** A shard container's inspection data: b.uqm SR-10.5's fields only, never an environment. */
export interface InspectionData {
  readonly name: string
  readonly imageId: string
  readonly mounts: readonly ShardMount[]
  readonly networkMode: string
  readonly pidMode: string
  readonly ipcMode: string
  readonly privileged: boolean
  readonly memoryBytes: number
  readonly memorySwapBytes: number
  readonly pidsLimit: number | null
  /** The CPU limit in billionths of a CPU, as Docker holds `--cpus`. */
  readonly nanoCpus: number
  readonly labels: Readonly<Record<string, string>>
  /** The self-removal setting (`--rm`). */
  readonly autoRemove: boolean
}

// --- Readings, samples and the final reading ---

/** A reading that could not be read. */
export type Unreadable = typeof UNREADABLE_READING

/** One reading's value, or `unreadable`. */
export type Reading<T> = T | Unreadable

/** W with its parts (b.uqm SR-7.1, SR-16.1 `workingSet`). */
export interface WorkingSetReading {
  readonly bytes: number
  readonly anonBytes: number
  readonly activeFileBytes: number
}

/** One active `/ci-live` run as admission or a sample saw it (b.uqm SR-6.6). */
export interface CiLiveRunSeen {
  readonly via: 'real-run-lock' | 'dry-run-lock' | 'container'
  /** The lock file's path or the container's name. */
  readonly what: string
  readonly pid: number | null
}

/** One reading that failed during the run (b.uqm SR-7.3). */
export interface FailedReading {
  /** The shard it was for; null for a run-wide reading. */
  readonly shard: number | null
  readonly what: string
  readonly error: string
}

/** One running shard in a sample (b.uqm SR-7.3). */
export interface ShardSample {
  readonly shard: number
  readonly memoryBytes: Reading<number>
  readonly anonBytes: Reading<number>
  readonly pageCacheBytes: Reading<number>
  readonly pidCount: Reading<number>
  /** Docker's `State.OOMKilled`. */
  readonly oomKilled: Reading<boolean>
  /** `oom_kill` from its `memory.events`. */
  readonly oomKillCount: Reading<number>
  readonly resultFile: ResultFileRead
}

/** One sample, every 30 s (b.uqm SR-7.3). */
export interface Sample {
  /** When it was taken, epoch milliseconds. */
  readonly atMs: number
  readonly workingSet: Reading<WorkingSetReading>
  /** The active `/ci-live` runs; empty when none. */
  readonly ciLive: readonly CiLiveRunSeen[]
  readonly shards: readonly ShardSample[]
  readonly failedReadings: readonly FailedReading[]
}

/** A shard's one final reading (b.uqm SR-10.6). */
export interface FinalReading {
  readonly oomKilled: Reading<boolean>
  readonly oomKillCount: Reading<number>
  readonly anonBytes: Reading<number>
  readonly fileBytes: Reading<number>
}

// --- Failures and run-level stops ---

/** The integrity checks, by name (b.uqm SR-13.2). */
export type IntegrityCheck =
  | 'fault-fired'
  | 'schedule-coverage'
  | 'isolation-mounts'
  | 'isolation-config'
  | 'results-canary'
  | 'results-ownership'
  | 'image-drift'
  | 'name-collision'
  | 'result-coverage'
  | 'package-hash'
  | 'dependency-set'
  | 'secret-scan'

/** A failure's class, so E10 ranks without parsing text (b.uqm SR-12.4). */
export type FailureClass =
  | {
      readonly kind: 'run-level-stop'
    }
  | {
      readonly kind: 'image-build'
    }
  | {
      readonly kind: 'integrity'
      readonly check: IntegrityCheck
    }
  | {
      readonly kind: 'out-of-memory'
    }
  | {
      readonly kind: 'shard'
    }
  | {
      readonly kind: 'script'
      readonly fileName: string
    }

/** One failure (b.uqm SR-12.4, SR-16.1 `failures`). */
export interface Failure {
  readonly line: string
  /** Its shard; null for none. */
  readonly shard: number | null
  readonly failureClass: FailureClass
}

/** A run-level stop (b.uqm SR-5.6). */
export type RunLevelStop =
  | {
      readonly kind: 'interrupt'
      readonly signal: TrappedSignal
    }
  | {
      readonly kind: 'memory-watchdog'
      readonly line: string
    }
  | {
      readonly kind: 'run-deadline'
      readonly line: string
    }

/** A run's state; later Epics add fields on their own lines. */
export interface RunState {
  /** The first run-level stop; later ones change nothing (b.uqm SR-5.6). */
  firstStop: RunLevelStop | null
  /** Each cleanup failure's line (b.uqm SR-9.3). */
  readonly cleanupFailures: string[]
}

// --- Images ---

/** A run-private tag's role (b.uqm SR-9.3). */
export type RunTagRole = (typeof RUN_TAG_ROLES)[number]

/** A fault label's value (b.uqm SR-14.2). */
export type FaultLabelValue = (typeof FAULT_LABEL_VALUES)[number]

/** One role's build outcome (b.uqm SR-5.6, SR-9.3, SR-14.2). */
export type BuildOutcome =
  | {
      readonly kind: 'built'
      readonly imageId: string
    }
  | {
      readonly kind: 'failed'
      readonly exitCode: number
    }
  | {
      readonly kind: 'stopped'
    }
  | {
      readonly kind: 'not-built'
    }

/** The build outcome of each role. */
export interface RoleBuildOutcomes {
  readonly test: BuildOutcome
  readonly drift: BuildOutcome
  readonly retag: BuildOutcome
}

/** The `-test` tag's move by `retag` (b.uqm SR-14.2). */
export type TagMoveOutcome =
  | {
      readonly kind: 'moved'
    }
  | {
      readonly kind: 'failed'
      readonly exitCode: number
    }
  | {
      readonly kind: 'not-tried'
    }

/** The run's images, as E8 fills it (b.uqm SR-9.3, SR-16.1 `images`). */
export interface ImageState {
  readonly pinnedId: string | null
  readonly driftId: string | null
  readonly retagId: string | null
  readonly builds: RoleBuildOutcomes
  /** True only when the `retag` fault moved the `-test` tag. */
  readonly retagMoved: boolean
}

// --- results.json (b.uqm SR-16.1) ---

/** `images`. */
export interface ResultsImages {
  readonly pinned: string | null
  readonly drift: string | null
  readonly retag: string | null
  readonly retagMoved: boolean
}

/** `invocation`. */
export interface ResultsInvocation {
  /** The `/ci` arguments as given. */
  readonly args: readonly string[]
  readonly selective: boolean
  /** The normalized faults in order, as their text. */
  readonly faults: readonly string[]
}

/** One `scripts` entry. */
export interface ResultsScript {
  /** Its file name. */
  readonly script: string
  readonly shard: number
  readonly result: ScriptResult | 'notrun'
  readonly seconds: number | null
  readonly failLine: string | null
}

/** A shard's `anonPeak`. */
export interface ResultsAnonPeak {
  readonly bytes: number | null
  readonly pageCacheBytes: number | null
  readonly mark: null | 'partial' | 'unknown'
}

/** A shard's `final`. */
export interface ResultsFinal {
  readonly oomKilled: Reading<boolean>
  readonly oomKillCount: Reading<number>
}

/** One `shards` entry. */
export interface ResultsShard {
  readonly shard: number
  readonly assigned: readonly string[]
  readonly expectedSeconds: number
  readonly limitMinutes: number
  readonly endedNormally: boolean
  /** Its out-of-memory line, else its end line, else `normal`. */
  readonly end: string
  readonly seconds: number | null
  readonly anonPeak: ResultsAnonPeak
  readonly peakPids: number | null
  readonly final: ResultsFinal
  readonly failedReadings: number
  readonly packageSha256: string | null
  readonly dependencyFingerprint: string | null
  readonly imageId: string | null
  readonly inspection: InspectionData | null
  readonly inspectionError: string | null
}

/** `shardCount`. */
export interface ResultsShardCount {
  readonly requested: number
  readonly effective: number
  /** The run's N, the shard-count line's n. */
  readonly admitted: number
  readonly started: number
  readonly reasons: readonly string[]
}

/** `cap`; in a selective run every key but `usedBytes` is null. */
export interface ResultsCap {
  readonly usedBytes: number
  readonly peakBytes: number | null
  readonly peakShard: number | null
  readonly peakPageCacheBytes: number | null
  readonly peakFromKill: boolean | null
  readonly derivedBytes: number | null
  readonly suffix: string | null
}

/** `workingSet`. */
export interface ResultsWorkingSet {
  readonly before: WorkingSetReading | null
  readonly peak: WorkingSetReading | null
  readonly after: WorkingSetReading | null
}

/** `modes`: four-digit octal strings such as `0700`. */
export interface ResultsModes {
  readonly runDir: string
  /** Null when no tarball was packed. */
  readonly tarball: string | null
  /** Each shard subdirectory's name to its mode. */
  readonly shardDirs: Readonly<Record<string, string>>
}

/** One `failures` entry. */
export interface ResultsFailure {
  readonly line: string
  readonly shard: number | null
}

/** `timing`. */
export interface ResultsTiming {
  readonly buildSeconds: number
  readonly baseBuildSeconds: number
  readonly totalSeconds: number
}

/** `results.json`, exactly b.uqm SR-16.1's keys and nesting. */
export interface Results {
  readonly version: typeof RESULTS_FORMAT_VERSION
  readonly runId: string
  readonly pid: number
  readonly packageSha256: string | null
  readonly images: ResultsImages
  /** The verdict line, redacted. */
  readonly verdict: string
  readonly invocation: ResultsInvocation
  readonly scripts: readonly ResultsScript[]
  readonly shards: readonly ResultsShard[]
  readonly shardCount: ResultsShardCount
  readonly cap: ResultsCap
  readonly workingSet: ResultsWorkingSet
  readonly failedReadings: number
  readonly modes: ResultsModes
  readonly failures: readonly ResultsFailure[]
  readonly skippedChecks: readonly string[]
  readonly cleanupFailures: readonly string[]
  readonly timing: ResultsTiming
  readonly timingSummary: readonly string[]
}

// --- Shard evidence ---

/** Everything the run knows of one shard: its `results.json` fields, and what they are judged from (b.uqm SR-12, SR-13). */
export interface ShardEvidence extends ResultsShard {
  /** Its start outcome; null when its container was never created. */
  readonly start: ShardStart | null
  readonly canary: string
  readonly resultFile: ResultFileRead
  /** The cause the runner fixed itself before a stop it made (b.uqm SR-12.1). */
  readonly fixedCause: ShardCause | null
  /** Its container's exit code, when it exited. */
  readonly exitCode: number | null
  /** Its out-of-memory line (b.uqm SR-12.2). */
  readonly oomLine: string | null
}

// --- Runner log ---

/** Takes one runner-log line (b.uqm SR-5.4). */
export type RunnerLogSink = (line: string) => void

// ---------------------------------------------------------------------------
// 4. Shared rules (E1)
// ---------------------------------------------------------------------------
//
// The rules the runner and the reader share, defined once (b.uqm SR-1.3).

// --- 4/T2 (E1 T2): arguments and run kinds, name forms, faults, canonical order, secrets and token lookup, child environments ---

// --- 4/T3 (E1 T3): RUN_ID and its time, the run-directory path, the status file, owners and liveness ---

// ---------------------------------------------------------------------------
// 5. File formats (E1)
// ---------------------------------------------------------------------------

// --- 5/T3 (E1 T3): reservation and results formats, verdict write, result-file reading, in-shard records, runner log ---

// ---------------------------------------------------------------------------
// 6. Docker layer (E1)
// ---------------------------------------------------------------------------

// --- 6/T4 (E1 T4): one fixed argument form per docker operation; docker run lists logged ---

// ---------------------------------------------------------------------------
// 7. Validation (E2)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. Scheduling (E4)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 9. Lock, reservations and sweep (E5)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. Admission readings and fit (E6)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 11. Memory guard (E7)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 12. Images (E8)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 13. Shard containers (E9)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 14. Outcomes, verdict and results (E10)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 15. Integrity and secret-scan (E11)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 16. Faults (E12)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 17. Run lifecycle (E1 steps 1–2, E13 the rest)
// ---------------------------------------------------------------------------

// --- 17/T5 (E1 T5): run-sequence steps 1–2: the run directory, the status file, the log's first line, the argument stage ---

// --- 17/E13: the rest of the run sequence, stops and the end of run ---

// ---------------------------------------------------------------------------
// 18. Main entry (E1)
// ---------------------------------------------------------------------------

// --- 18/T5 (E1 T5): main, the refusal recorder and error capture ---

// The one main-module entry block: the only top-level statement that is not
// a declaration, import or export, and the last thing in the file, so every
// declaration it reaches is already initialised. T5 builds the real
// dependencies here with `createRealRunnerDeps`, runs main and exits.
if (import.meta.main) {
}
