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
// E1 T3's file writes: whole-file replacement and the runner log.
import { appendFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
// E1 T5's step 1: the run directory, created exclusively, mode 0700.
import { chmodSync, mkdirSync } from 'node:fs'
// E11 T2's secret-scan: a walk that never follows a link, and each file read
// in chunks through a descriptor opened without following a link. Aliased so
// another lane's own `node:fs` import of the same names cannot collide.
import {
  closeSync as closeScannedFile,
  constants as scanFsConstants,
  fstatSync as statScannedFile,
  openSync as openScannedFile,
  readSync as readScannedFile,
  readdirSync as listScannedDir,
  type Dirent as ScannedDirEntry,
} from 'node:fs'
// E11 T1's evidence reader: listings and entry types that never follow a
// link. Aliased so another lane's own `node:fs` import cannot collide.
import { lstatSync as lstatEvidenceEntry, readdirSync as listEvidenceDir } from 'node:fs'

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
/** The exit status of a runner that finds something at its run directory's path, meets an error, or (until E13) stops after validation (b.uqm SR-5.1, SR-5.4). */
export const FAILURE_EXIT_STATUS = 1

// --- Name patterns ---

/** A script's file name, `test-<n>-<slug>.sh`; group 1 is n (b.uqm Terms, SR-2.2, SR-2.3). */
export const SCRIPT_FILE_NAME_PATTERN = /^test-(0|[1-9][0-9]*)-[a-z0-9-]+\.sh$/
/** A script's number form, `test-<n>`; group 1 is n (b.uqm Terms, SR-2.2, SR-2.3). */
export const NUMBER_FORM_PATTERN = /^test-(0|[1-9][0-9]*)$/

// --- Files and owners (E1 T3) ---

/** A RUN_ID, `<YYYYMMDD>t<HHMMSS>z-<suffix>`: groups 1–6 are its UTC year, month, day, hour, minute and second, then 8 lowercase letters or digits (b.uqm SR-5.1). */
export const RUN_ID_PATTERN = /^([0-9]{4})([0-9]{2})([0-9]{2})t([0-9]{2})([0-9]{2})([0-9]{2})z-[a-z0-9]{8}$/
/** The system temp directory when `$TMPDIR` is unset or empty (b.uqm SR-5.1). */
export const DEFAULT_TEMP_DIR = '/tmp'
/** A reservation file's suffix, `<RUN_ID>-<PID>.json` (b.uqm SR-6.2). */
export const RESERVATION_FILE_SUFFIX = '.json'
/** A SHA-256's length in lowercase hexadecimal characters: the tarball hash and the dependency fingerprint (b.uqm SR-11.3, SR-16.1). */
export const SHA256_HEX_LENGTH = 64
/** A script's seconds in a result file: digits with no leading zero but a lone `0`, a point, exactly three digits (b.uqm SR-11.3). */
export const RESULT_SECONDS_PATTERN = /^(0|[1-9][0-9]*)\.[0-9]{3}$/

// --- Credential lookup (E1 T2) ---

/** The base-build token lookup's command, run first with `GH_CONFIG_DIR` set, then plain (b.uqm SR-15.1). */
export const GH_AUTH_TOKEN_ARGV = ['gh', 'auth', 'token'] as const
/** The first token lookup's `GH_CONFIG_DIR`, relative to the environment's `HOME`: `<$HOME>/.config/gh-personal` (b.uqm SR-15.1, SR-15.4). */
export const GH_PERSONAL_CONFIG_SUBPATH = '.config/gh-personal'

// --- Docker answers (E1 T4) ---

/** The text in Docker's answer to an image inspect naming an image it does not have: the image is missing (b.uqm SR-9.2, SR-23.6). */
export const DOCKER_NO_SUCH_IMAGE_TEXT = 'No such image'
/** The text in Docker's answer to a container inspect naming a container it does not have: the container is gone (b.uqm SR-6.4, SR-6.5). */
export const DOCKER_NO_SUCH_CONTAINER_TEXT = 'No such container'

// --- Worktree paths and the prerequisite keyword (E1 T7) ---

/** The directory holding the scripts, relative to the worktree root (b.uqm Terms, SR-2.3). */
export const INTEGRATION_DIR_PATH = 'tests/integration'
/** The duration table, relative to the worktree root (b.uqm SR-4.1). */
export const DURATION_TABLE_PATH = 'tests/ci-durations.tsv'
/** The test image's Dockerfile, relative to the worktree root; its `FROM` line names the base image (b.uqm SR-9.2, SR-9.3). */
export const TEST_DOCKERFILE_PATH = 'docker/Dockerfile.test'
/** The base image's Dockerfile, relative to the worktree root; it sets `ARG AD_VERSION` (b.uqm SR-9.2). */
export const BASE_DOCKERFILE_PATH = 'docker/Dockerfile.test.base'
/** A prerequisite line's keyword, lowercase, after the `#` and its optional spaces or tabs: the bare keyword, not a `# ci-requires:` prefix (b.uqm SR-3.1). */
export const CI_REQUIRES_KEYWORD = 'ci-requires:'

// --- Modes and child exits (E1 T3, T5) ---

/** The mode of the run directory and of each shard directory, owner-only (b.uqm SR-5.1, SR-5.9). */
export const RUN_DIR_MODE = 0o700
/** The mode of a file the runner writes whole or appends to, when it creates it, owner-only (b.uqm SR-5.1). */
export const WRITTEN_FILE_MODE = 0o600
/** The exit status base for a child a signal ended, as a shell reports it: 128 + the signal number (SIGKILL: 137) (b.uqm SR-5.6). */
export const SIGNAL_EXIT_STATUS_BASE = 128

// --- Credentials (E2 T3) ---

/** The Anthropic raw key's prefix: while `ANTHROPIC_BASE_URL` is unset, an `ANTHROPIC_API_KEY` not beginning with it is a missing credential (b.uqm SR-15.1). */
export const RAW_KEY_PREFIX = 'sk-ant-'

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
  /** Every parsed `--inject` value as typed, in argument order, before normalization drops a repeat; E2's stage 7 names a wrong script or shard from it as typed (b.uqm SR-2.3, SR-2.4). */
  readonly givenFaults: readonly GivenFault[]
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

/** One parsed `--inject` value with its place in the `/ci` arguments (b.uqm SR-2.4). */
export interface GivenFault {
  /** The `--inject` option's index in the `/ci` arguments. */
  readonly position: number
  /** The value as typed: a script's file name or a shard's digits as given, never normalized. */
  readonly value: string
  /** The value parsed, its `<script>` normalized to its number form. */
  readonly fault: Fault
}

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

// Script-name forms (b.uqm Terms, SR-2.2, SR-2.3). These only classify and
// convert names; matching them against the worktree's scripts is E2's.

/** A whole number: decimal digits, with no sign, no point and no leading zero (b.uqm SR-2.2). */
const WHOLE_NUMBER_PATTERN = /^(0|[1-9][0-9]*)$/

/** Whether `text` is a whole number (b.uqm SR-2.2): `0`, `7` and `720` are; `07`, `+7`, `7.0`, `-1` and the empty string are not. */
export function isWholeNumber(text: string): boolean {
  return WHOLE_NUMBER_PATTERN.test(text)
}

/** Whether `text` is a number form, `test-<n>` with n a whole number. */
export function isNumberForm(text: string): boolean {
  return NUMBER_FORM_PATTERN.test(text)
}

/** Whether `text` is a valid script file name, `test-<n>-<slug>.sh`; `test-5.sh`, `test-05-x.sh` and `test-x-y.sh` are not. */
export function isScriptFileName(text: string): boolean {
  return SCRIPT_FILE_NAME_PATTERN.test(text)
}

/** The number form of the script numbered n, `test-<n>`. */
export function numberFormOf(n: number): string {
  return `test-${n}`
}

/**
 * The number form built from a whole number's digits as typed, `test-<digits>`.
 * Every number form a name gives is built this way, never from the digits'
 * `Number`, so a number past 2^53 keeps its exact spelling (a whole number has
 * one spelling, so equal digits are the equal number).
 */
function numberFormOfDigits(digits: string): string {
  return `test-${digits}`
}

/** A valid file name's number as typed, its digits; null for any other text. */
function fileNameDigits(fileName: string): string | null {
  return SCRIPT_FILE_NAME_PATTERN.exec(fileName)?.[1] ?? null
}

/** A valid file name's number, read whole (`test-20-x.sh` gives 20, never 2); null for any other text. */
export function fileNameNumber(fileName: string): number | null {
  const digits = fileNameDigits(fileName)
  return digits === null ? null : Number(digits)
}

/** A valid file name's number form (`test-20-x.sh` gives `test-20`), built from its digits as typed; null for any other text. */
export function fileNameNumberForm(fileName: string): string | null {
  const digits = fileNameDigits(fileName)
  return digits === null ? null : numberFormOfDigits(digits)
}

/** A SCRIPT argument (or a fault's `<script>`) classified: a number form, a file name, or neither (b.uqm SR-2.3). */
export type ScriptNameForm =
  | {
      readonly kind: 'number-form'
      readonly number: number
      readonly numberForm: string
    }
  | {
      readonly kind: 'file-name'
      readonly fileName: string
      readonly number: number
      readonly numberForm: string
    }
  | {
      readonly kind: 'neither'
    }

/** Classifies a name as a number form, a valid file name or neither; its number form is built from its digits as typed. */
export function classifyScriptName(name: string): ScriptNameForm {
  const numberFormDigits = NUMBER_FORM_PATTERN.exec(name)?.[1]
  if (numberFormDigits !== undefined) {
    return { kind: 'number-form', number: Number(numberFormDigits), numberForm: numberFormOfDigits(numberFormDigits) }
  }
  const digits = fileNameDigits(name)
  if (digits !== null) return { kind: 'file-name', fileName: name, number: Number(digits), numberForm: numberFormOfDigits(digits) }
  return { kind: 'neither' }
}

/** A number form's or a file name's number; null for any other text. */
export function scriptNameNumber(name: string): number | null {
  const form = classifyScriptName(name)
  return form.kind === 'neither' ? null : form.number
}

// Bad arguments (b.uqm SR-2.2, SR-2.4; stage 1 of SR-2.6). Every reason
// names the argument and the rule it breaks, and comes from an exported
// builder below, so tests import the text rather than type it.

/** One bad argument (b.uqm SR-2.2, SR-2.4). */
export interface ArgumentFailure {
  /** The index in the `/ci` arguments of the argument it names (an option's own index when its value is bad); failures are given in this order. */
  readonly position: number
  /** The refusal's reason, its text after `NOT RUN: `, on one line. */
  readonly reason: string
}

/** The `/ci` options (b.uqm SR-2.1). */
const SHARDS_OPTION = '--shards'
const SHARD_TIMEOUT_OPTION = '--shard-timeout'
const INJECT_OPTION = '--inject'
const OPTION_NAMES: readonly string[] = [SHARDS_OPTION, SHARD_TIMEOUT_OPTION, INJECT_OPTION]

/** A control character, which an argument shown in a one-line reason must not carry raw. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

/** An argument as a reason shows it: as given, or JSON-quoted when it is empty or holds a control character, so the reason stays one readable line. */
function shownArgument(arg: string): string {
  return arg === '' || CONTROL_CHARACTER_PATTERN.test(arg) ? JSON.stringify(arg) : arg
}

/** The rule of a numeric option's value: `N must be a whole number from 1 to 6`, `MINUTES must be a whole number from 1 to 720`. */
export function optionValueRule(option: '--shards' | '--shard-timeout'): string {
  return option === SHARDS_OPTION
    ? `N must be a whole number from ${OPTION_RANGE_MIN} to ${MAX_SHARDS}`
    : `MINUTES must be a whole number from ${OPTION_RANGE_MIN} to ${MAX_SHARD_TIMEOUT_MINUTES}`
}

/** `--shards 7 is out of range: N must be a whole number from 1 to 6` (b.uqm SR-2.2). */
export function outOfRangeReason(option: '--shards' | '--shard-timeout', value: string): string {
  return `${option} ${shownArgument(value)} is out of range: ${optionValueRule(option)}`
}

/** `--shards 03 is not a whole number: N must be a whole number from 1 to 6`. */
export function notWholeNumberReason(option: '--shards' | '--shard-timeout', value: string): string {
  return `${option} ${shownArgument(value)} is not a whole number: ${optionValueRule(option)}`
}

/** `--shards 3 is a second --shards: --shards may be given only once`, even with the same value. */
export function repeatedOptionReason(option: '--shards' | '--shard-timeout', value: string): string {
  return `${option} ${shownArgument(value)} is a second ${option}: ${option} may be given only once`
}

/** `--shards is given no value: --shards takes its value as the next argument` (an option given last). */
export function optionWithoutValueReason(option: string): string {
  return `${option} is given no value: ${option} takes its value as the next argument`
}

/** `--shards=3 joins its value with =: --shards takes its value as the next argument`. */
export function optionEqualsFormReason(arg: string, option: string): string {
  return `${shownArgument(arg)} joins its value with =: ${option} takes its value as the next argument`
}

/** `--foo is an unknown option: the options are --shards, --shard-timeout and --inject`. */
export function unknownOptionReason(arg: string): string {
  return `${shownArgument(arg)} is an unknown option: the options are ${SHARDS_OPTION}, ${SHARD_TIMEOUT_OPTION} and ${INJECT_OPTION}`
}

/** `-x is not an option: an argument beginning - must be --shards, --shard-timeout or --inject`. */
export function notAnOptionReason(arg: string): string {
  return `${shownArgument(arg)} is not an option: an argument beginning - must be ${SHARDS_OPTION}, ${SHARD_TIMEOUT_OPTION} or ${INJECT_OPTION}`
}

// Faults (b.uqm SR-2.4): their forms, normalization, de-duplication and the
// faults that are bad arguments. Whether a fault's script exists and its
// shard number is in range is E2's stage 7, never checked here.

/** Every fault's form, as a bad fault name's reason lists them. */
const FAULT_FORMS_TEXT = 'fail:<script>, timeout:<script>, leak:<k>,<j>, image-drift:<k>, kill:<k> or retag'

/** Each fault's written form, as a malformed fault's reason gives it. */
const FAULT_FORM_RULES: Readonly<Record<FaultKind, string>> = {
  fail: 'fail must be written fail:<script>, <script> a number form test-<n> or a file name test-<n>-<slug>.sh',
  timeout: 'timeout must be written timeout:<script>, <script> a number form test-<n> or a file name test-<n>-<slug>.sh',
  leak: 'leak must be written leak:<k>,<j>, k and j whole numbers',
  'image-drift': 'image-drift must be written image-drift:<k>, k a whole number',
  kill: 'kill must be written kill:<k>, k a whole number',
  retag: 'retag must be written retag, with no value',
}

/** `--inject bogus:1 names an unknown fault: FAULT must be one of fail:<script>, …`. */
export function unknownFaultReason(value: string): string {
  return `${INJECT_OPTION} ${shownArgument(value)} names an unknown fault: FAULT must be one of ${FAULT_FORMS_TEXT}`
}

/** `--inject kill:x is malformed: kill must be written kill:<k>, k a whole number`. */
export function malformedFaultReason(value: string, kind: FaultKind): string {
  return `${INJECT_OPTION} ${shownArgument(value)} is malformed: ${FAULT_FORM_RULES[kind]}`
}

/** `--inject leak:2,2 leaks a shard into itself: leak:<k>,<j> must name two different shards`. */
export function sameShardLeakReason(value: string): string {
  return `${INJECT_OPTION} ${shownArgument(value)} leaks a shard into itself: leak:<k>,<j> must name two different shards`
}

/**
 * `--inject fail:test-5 and --inject timeout:test-5 name the same script, test-5: fail and timeout may not name the same script`.
 * `first` and `second` are the two `--inject` values as given, in argument order.
 */
export function failTimeoutConflictReason(first: string, second: string, numberForm: string): string {
  return `${INJECT_OPTION} ${shownArgument(first)} and ${INJECT_OPTION} ${shownArgument(second)} name the same script, ${numberForm}: fail and timeout may not name the same script`
}

/** One `--inject` value parsed: a fault, its `<script>` normalized to its number form, or the reason it is a bad argument. */
export type FaultParse =
  | {
      readonly ok: true
      readonly fault: Fault
    }
  | {
      readonly ok: false
      readonly reason: string
    }

/** Parses one `--inject` value (b.uqm SR-2.4). Bad: an unknown fault name, a malformed fault, `leak:<k>,<k>`. */
export function parseFault(value: string): FaultParse {
  const colon = value.indexOf(':')
  const name = colon === -1 ? value : value.slice(0, colon)
  const rest = colon === -1 ? null : value.slice(colon + 1)
  const malformed = (kind: FaultKind): FaultParse => ({ ok: false, reason: malformedFaultReason(value, kind) })
  switch (name) {
    case 'retag':
      return rest === null ? { ok: true, fault: { kind: 'retag' } } : malformed('retag')
    case 'fail':
    case 'timeout': {
      const form = rest === null ? null : classifyScriptName(rest)
      if (form === null || form.kind === 'neither') return malformed(name)
      return { ok: true, fault: name === 'fail' ? { kind: 'fail', script: form.numberForm } : { kind: 'timeout', script: form.numberForm } }
    }
    case 'leak': {
      const shards = rest === null ? [] : rest.split(',')
      const [source, target] = shards
      if (shards.length !== 2 || source === undefined || target === undefined || !isWholeNumber(source) || !isWholeNumber(target)) {
        return malformed('leak')
      }
      // Compared as typed digits: a whole number has one spelling, and two
      // numbers past 2^53 may share one Number.
      if (source === target) return { ok: false, reason: sameShardLeakReason(value) }
      return { ok: true, fault: { kind: 'leak', sourceShard: Number(source), targetShard: Number(target) } }
    }
    case 'image-drift':
    case 'kill': {
      if (rest === null || !isWholeNumber(rest)) return malformed(name)
      const shard = Number(rest)
      return { ok: true, fault: name === 'kill' ? { kind: 'kill', shard } : { kind: 'image-drift', shard } }
    }
    default:
      return { ok: false, reason: unknownFaultReason(value) }
  }
}

/**
 * A fault's normalized text: `fail:test-3`, `timeout:test-3`, `leak:1,2`,
 * `image-drift:2`, `kill:2` or `retag`. A shard number past 2^53 is no longer
 * its typed digits here; such a fault is out of range and refused at stage 7
 * from `Invocation.givenFaults`, so it never reaches the wrapper.
 */
export function faultText(fault: Fault): string {
  switch (fault.kind) {
    case 'fail':
    case 'timeout':
      return `${fault.kind}:${fault.script}`
    case 'leak':
      return `leak:${fault.sourceShard},${fault.targetShard}`
    case 'image-drift':
    case 'kill':
      return `${fault.kind}:${fault.shard}`
    case 'retag':
      return 'retag'
  }
}

/** Faults normalized and de-duplicated, and the bad arguments that leaves. */
export interface NormalizedFaults {
  /** In first-occurrence order (b.uqm SR-2.4). */
  readonly faults: readonly Fault[]
  /** One per script that both a `fail:` and a `timeout:` name, at the later one's position. */
  readonly failures: readonly ArgumentFailure[]
}

/**
 * A given fault's normalized text from its typed digits, so two shard numbers
 * past 2^53 that share one Number stay apart: a script fault's text (its
 * number form is built from its digits), else the value as typed, which a
 * well-formed `leak:`, `image-drift:`, `kill:` or `retag` already is, a whole
 * number having one spelling.
 */
function givenFaultText(entry: GivenFault): string {
  return entry.fault.kind === 'fail' || entry.fault.kind === 'timeout' ? faultText(entry.fault) : entry.value
}

/**
 * De-duplicates parsed faults, given in argument order: a fault equal in its
 * normalized form to an earlier one is dropped, the first keeping its place
 * (b.uqm SR-2.4). Equality is judged on the typed digits. `fail:` and
 * `timeout:` naming the same script, in either form, are a bad argument naming
 * both.
 */
export function normalizeFaults(given: readonly GivenFault[]): NormalizedFaults {
  const seen = new Set<string>()
  const faults: Fault[] = []
  const failures: ArgumentFailure[] = []
  const scriptFaults = new Map<string, GivenFault>()
  for (const entry of given) {
    const text = givenFaultText(entry)
    if (seen.has(text)) continue
    seen.add(text)
    faults.push(entry.fault)
    if (entry.fault.kind !== 'fail' && entry.fault.kind !== 'timeout') continue
    // After de-duplication a script has at most one fail: and one timeout:,
    // so the second of the two to arrive meets the first here, exactly once.
    const earlier = scriptFaults.get(entry.fault.script)
    if (earlier === undefined) {
      scriptFaults.set(entry.fault.script, entry)
    } else {
      failures.push({ position: entry.position, reason: failTimeoutConflictReason(earlier.value, entry.value, entry.fault.script) })
    }
  }
  return { faults, failures }
}

/** The `INJECTED (<faults>)` wrapper's fault text: the normalized faults in order, separated by single spaces (b.uqm SR-2.4). */
export function injectedFaultsText(faults: readonly Fault[]): string {
  return faults.map(faultText).join(' ')
}

/** The injected verdict's prefix, `INJECTED (<faults>): ` (b.uqm SR-2.4, SR-12.5, SR-17.2). */
export function injectedVerdictPrefix(faults: readonly Fault[]): string {
  return `INJECTED (${injectedFaultsText(faults)}): `
}

// The `/ci` arguments (b.uqm SR-2.1, SR-2.2) and run kinds (b.uqm SR-2.5).
// Only the arguments decide: no environment variable or file sets a run
// option.

/** The `/ci` arguments parsed: an invocation, or every bad argument in argument order. */
export type ArgumentParse =
  | {
      readonly ok: true
      readonly invocation: Invocation
    }
  | {
      readonly ok: false
      readonly failures: readonly ArgumentFailure[]
    }

/** A numeric option's value, or the reason it is bad. */
function optionValue(option: '--shards' | '--shard-timeout', value: string): { readonly ok: true; readonly n: number } | { readonly ok: false; readonly reason: string } {
  if (!isWholeNumber(value)) return { ok: false, reason: notWholeNumberReason(option, value) }
  const n = Number(value)
  const max = option === SHARDS_OPTION ? MAX_SHARDS : MAX_SHARD_TIMEOUT_MINUTES
  if (n < OPTION_RANGE_MIN || n > max) return { ok: false, reason: outOfRangeReason(option, value) }
  return { ok: true, n }
}

/**
 * Parses the `/ci` arguments (b.uqm SR-2.1, SR-2.2, SR-2.4): options and
 * SCRIPT names in any order, each option taking the next argument as its
 * value, `--inject` repeatable. Gives the invocation, or every bad argument
 * in argument order. SCRIPT arguments are kept as given; whether they name
 * scripts is E2's.
 */
export function parseCiArguments(args: readonly string[]): ArgumentParse {
  const failures: ArgumentFailure[] = []
  const scripts: string[] = []
  const given: GivenFault[] = []
  let shards: number | null = null
  let shardTimeoutMinutes: number | null = null
  let shardsSeen = false
  let shardTimeoutSeen = false
  for (let position = 0; position < args.length; position++) {
    const arg = args[position] as string
    if (!arg.startsWith('-')) {
      scripts.push(arg)
      continue
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const option = arg.slice(0, arg.indexOf('='))
      const reason = OPTION_NAMES.includes(option) ? optionEqualsFormReason(arg, option) : unknownOptionReason(arg)
      failures.push({ position, reason })
      continue
    }
    if (!OPTION_NAMES.includes(arg)) {
      failures.push({ position, reason: arg.startsWith('--') ? unknownOptionReason(arg) : notAnOptionReason(arg) })
      continue
    }
    if (position + 1 >= args.length) {
      failures.push({ position, reason: optionWithoutValueReason(arg) })
      continue
    }
    const optionPosition = position
    position++
    const value = args[position] as string
    if (arg === INJECT_OPTION) {
      const parsed = parseFault(value)
      if (parsed.ok) given.push({ position: optionPosition, value, fault: parsed.fault })
      else failures.push({ position: optionPosition, reason: parsed.reason })
      continue
    }
    const option = arg === SHARDS_OPTION ? SHARDS_OPTION : SHARD_TIMEOUT_OPTION
    const seen = option === SHARDS_OPTION ? shardsSeen : shardTimeoutSeen
    if (option === SHARDS_OPTION) shardsSeen = true
    else shardTimeoutSeen = true
    if (seen) {
      failures.push({ position: optionPosition, reason: repeatedOptionReason(option, value) })
      continue
    }
    const parsed = optionValue(option, value)
    if (!parsed.ok) {
      failures.push({ position: optionPosition, reason: parsed.reason })
      continue
    }
    if (option === SHARDS_OPTION) shards = parsed.n
    else shardTimeoutMinutes = parsed.n
  }
  const normalized = normalizeFaults(given)
  const allFailures = [...failures, ...normalized.failures].sort((a, b) => a.position - b.position)
  if (allFailures.length > 0) return { ok: false, failures: allFailures }
  return {
    ok: true,
    invocation: {
      args: [...args],
      scripts,
      shards,
      shardTimeoutMinutes,
      faults: normalized.faults,
      givenFaults: given,
    },
  }
}

/** A full run: no SCRIPT argument (b.uqm Terms). */
export function isFullRun(invocation: Invocation): boolean {
  return invocation.scripts.length === 0
}

/** A selective run: at least one SCRIPT argument (b.uqm Terms). */
export function isSelectiveRun(invocation: Invocation): boolean {
  return invocation.scripts.length > 0
}

/** An injected run: at least one `--inject` (b.uqm Terms). */
export function isInjectedRun(invocation: Invocation): boolean {
  return invocation.faults.length > 0
}

/** A default full run: `/ci` with no arguments at all (b.uqm Terms). */
export function isDefaultFullRun(invocation: Invocation): boolean {
  return invocation.args.length === 0
}

/** Gate-eligible: a full run without `--inject`, with or without `--shards` or `--shard-timeout` (b.uqm SR-2.5). */
export function isGateEligible(invocation: Invocation): boolean {
  return isFullRun(invocation) && !isInjectedRun(invocation)
}

/** Only a default full run can be a cap source (b.uqm SR-2.5, SR-8.4). */
export function isCapSourceEligible(invocation: Invocation): boolean {
  return isDefaultFullRun(invocation)
}

/** The run's kind as a reservation records it (b.uqm SR-6.2). */
export function runKindOf(invocation: Invocation): RunKind {
  return isSelectiveRun(invocation) ? 'selective' : 'full'
}

// Canonical order (b.uqm SR-3.3): test-1; then test-2, test-3 and test-4,
// each when present; then every other script by ascending number, so test-0
// follows test-4. Numbers are compared, never text.

/** A script number's place group: 0 for test-1, 1 for test-2 to test-4, 2 for every other. */
function canonicalGroup(n: number): number {
  if (n === 1) return 0
  return n >= 2 && n <= 4 ? 1 : 2
}

/** Compares two script numbers in canonical order. */
export function compareCanonicalNumbers(a: number, b: number): number {
  const group = canonicalGroup(a) - canonicalGroup(b)
  if (group !== 0) return group
  return a < b ? -1 : a > b ? 1 : 0
}

/** Compares two script names, number forms and file names alike, in canonical order by their numbers. A name that is neither sorts after every script name, and two such names compare equal. */
export function compareCanonical(a: string, b: string): number {
  const na = scriptNameNumber(a)
  const nb = scriptNameNumber(b)
  if (na === null || nb === null) return (na === null ? 1 : 0) - (nb === null ? 1 : 0)
  return compareCanonicalNumbers(na, nb)
}

/** A new list of the names in canonical order (a stable sort). */
export function sortCanonical<T extends string>(names: readonly T[]): T[] {
  return [...names].sort(compareCanonical)
}

// Credentials and child environments (b.uqm SR-15.1, SR-15.4). No value
// handled here is written to any sink.

/** The environment a child is given, or the runner's own as `RunnerDeps.env` holds it. */
export type ChildEnvironmentSource = Readonly<Record<string, string | undefined>>

/** The variables that are never secret, whatever they hold (b.uqm SR-15.1). */
const NON_SECRET_VARIABLES: readonly string[] = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']

/** A child's environment: the given one, unchanged, its unset entries left out (b.uqm SR-15.4). */
export function childEnvironment(env: ChildEnvironmentSource): Record<string, string> {
  const child: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) child[name] = value
  }
  return child
}

/** `<$HOME>/.config/gh-personal`, `<$HOME>` being `HOME` in the given environment, as the base-build step forms it (b.uqm SR-15.4). */
export function ghPersonalConfigDir(env: ChildEnvironmentSource): string {
  return `${env.HOME ?? ''}/${GH_PERSONAL_CONFIG_SUBPATH}`
}

/** The first `gh auth token` lookup's environment: the child environment plus `GH_CONFIG_DIR` (b.uqm SR-15.4), its one exception. */
export function firstTokenLookupEnvironment(env: ChildEnvironmentSource): Record<string, string> {
  return { ...childEnvironment(env), GH_CONFIG_DIR: ghPersonalConfigDir(env) }
}

/** One `gh auth token` run: its output without trailing line feeds, or null when it fails or gives nothing. */
async function runTokenLookup(spawn: SpawnFn, env: Record<string, string>, cwd: string): Promise<string | null> {
  let result: SpawnResult
  try {
    result = await spawn({ argv: [...GH_AUTH_TOKEN_ARGV], env, cwd, ownProcessGroup: false }).result
  } catch {
    // A spawn that throws is a failing gh: no credential.
    return null
  }
  if (result.exitCode !== 0) return null
  const token = new TextDecoder().decode(result.stdout).replace(/\n+$/, '')
  return token === '' ? null : token
}

/**
 * The base-build token, found as the base-build step finds it (b.uqm
 * SR-15.1): `gh auth token` with `GH_CONFIG_DIR` at `<$HOME>/.config/gh-personal`,
 * then, only when that fails or gives nothing, plain `gh auth token`. Each
 * runs through the given spawn function with the environment derived from
 * `env` (b.uqm SR-15.4), in `cwd`; null when neither gives a credential.
 *
 * `cwd` is the worktree root the base-build step runs in, because `gh` may
 * pick its token from the working directory (a `gh` wrapper that routes by
 * the checkout's git origin): a lookup from elsewhere could miss the token
 * the step finds. The runner passes `RunnerDeps.worktreeRoot`; the reader
 * (E3) passes its own worktree root and runs it through its own spawn seam.
 */
export async function lookUpBaseBuildToken(spawn: SpawnFn, env: ChildEnvironmentSource, cwd: string): Promise<string | null> {
  const first = await runTokenLookup(spawn, firstTokenLookupEnvironment(env), cwd)
  if (first !== null) return first
  return runTokenLookup(spawn, childEnvironment(env), cwd)
}

/** What joins the secret set beside the environment's own credentials. */
export interface SecretSetExtras {
  /** The base-build token, when step 4 looked one up (b.uqm SR-9.2); null or absent otherwise. */
  readonly baseBuildToken?: string | null
  /** Variables later passed to a shard that hold a key or token, by name; `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` are skipped. */
  readonly shardVariables?: Readonly<Record<string, string | undefined>>
}

/**
 * The secret credentials' values (b.uqm SR-15.1): `ANTHROPIC_API_KEY`;
 * `GH_TOKEN` when set; the base-build token when one was looked up; and the
 * extra shard variables' values. Never an empty string, and never the value
 * of `ANTHROPIC_BASE_URL` or `ANTHROPIC_MODEL` as such.
 */
export function secretCredentialSet(env: ChildEnvironmentSource, extras: SecretSetExtras = {}): ReadonlySet<string> {
  const values = new Set<string>()
  const add = (value: string | null | undefined): void => {
    if (value !== undefined && value !== null && value !== '') values.add(value)
  }
  add(env.ANTHROPIC_API_KEY)
  add(env.GH_TOKEN)
  add(extras.baseBuildToken)
  for (const [name, value] of Object.entries(extras.shardVariables ?? {})) {
    if (!NON_SECRET_VARIABLES.includes(name)) add(value)
  }
  return values
}

// --- 4/T3 (E1 T3): RUN_ID and its time, the run-directory path, the status file, owners and liveness ---

const MS_PER_SECOND = 1_000
const MS_PER_MINUTE = 60_000

/** A UTC time, `YYYY-MM-DDTHH:MM:SSZ`; groups 1–6 are its fields (b.uqm Terms). */
const UTC_TIME_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/

/** A line break, which no one-line text may hold. */
const LINE_BREAK_PATTERN = /[\r\n]/

/** A whole number above 0 written in decimal digits, as a PID is written in names and labels. */
const PID_TEXT_PATTERN = /^[1-9][0-9]*$/

/** The epoch milliseconds of a UTC calendar moment, or null when the fields name no real moment (February 30, month 13, hour 24, second 60). */
function calendarMomentMs(fields: readonly string[]): number | null {
  const [year, month, day, hour, minute, second] = fields.map(Number)
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  const real =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  return real ? date.getTime() : null
}

/**
 * The RUN_ID's time in epoch milliseconds (b.uqm SR-5.1), or null when
 * `value` is no RUN_ID: not of `RUN_ID_PATTERN`'s shape, or naming no real
 * moment of the calendar.
 */
export function runIdTimeMs(value: string): number | null {
  const match = RUN_ID_PATTERN.exec(value)
  return match === null ? null : calendarMomentMs(match.slice(1, 7))
}

/** Whether `value` is a RUN_ID (b.uqm SR-5.1). */
export function isRunId(value: string): boolean {
  return runIdTimeMs(value) !== null
}

/** A moment as a UTC time, `YYYY-MM-DDTHH:MM:SSZ`, in whole seconds rounded down (b.uqm Terms). Throws for a moment that is no date. */
export function formatUtcTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) throw new Error(`formatUtcTime: not a moment: ${epochMs}`)
  const wholeSecondsMs = Math.floor(epochMs / MS_PER_SECOND) * MS_PER_SECOND
  return new Date(wholeSecondsMs).toISOString().replace(/\.000Z$/, 'Z')
}

/** A UTC time's epoch milliseconds, or null when `text` is no UTC time (b.uqm Terms). */
export function parseUtcTimeMs(text: string): number | null {
  const match = UTC_TIME_PATTERN.exec(text)
  return match === null ? null : calendarMomentMs(match.slice(1, 7))
}

/**
 * The system temp directory: `$TMPDIR` when it is set and not empty, else
 * `/tmp`, a trailing slash ignored (b.uqm SR-5.1). SR-5.1's rule only; not
 * /ci-live's (SR-6.6).
 */
export function systemTempDir(env: Readonly<Record<string, string | undefined>>): string {
  const value = env.TMPDIR
  if (value === undefined || value === '') return DEFAULT_TEMP_DIR
  const trimmed = value.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * The run directory, `cscb-ci-<RUN_ID>` in the system temp directory (b.uqm
 * SR-5.1), joined with one `/` and never normalized (`TMPDIR=/a/../b` keeps
 * its `..`), so the skill, the runner and the reader derive the same text.
 * Throws for a `runId` that is no RUN_ID, so no other name can reach the path.
 */
export function runDirPath(env: Readonly<Record<string, string | undefined>>, runId: string): string {
  if (!isRunId(runId)) throw new Error(`runDirPath: not a RUN_ID: ${JSON.stringify(runId)}`)
  const dir = systemTempDir(env)
  return `${dir === '/' ? '' : dir}/${RUN_DIR_PREFIX}${runId}`
}

/** Minutes rounded to the nearest whole minute, halves up: 138.4 gives 138, 84.5 gives 85 (b.uqm SR-4.3, SR-5.5). */
export function roundMinutesHalfUp(minutes: number): number {
  return Math.floor(minutes + 0.5)
}

// The JSON shapes behind the run's strict parsers and ordered serializers:
// the status file here, the reservation and `results.json` in section 5. One
// shape gives both the exact keys and types a parser accepts and the key order
// a serializer writes, so the two never drift apart.

/** One JSON value's shape. */
type JsonShape =
  | {
      readonly kind: 'string'
      readonly what: string
      readonly test: ((value: string) => boolean) | null
    }
  | {
      readonly kind: 'number'
      readonly what: string
      readonly whole: boolean
      readonly min: number | null
    }
  | {
      readonly kind: 'boolean'
    }
  | {
      readonly kind: 'literal'
      readonly value: string | number | null
    }
  | {
      readonly kind: 'one-of'
      readonly options: readonly JsonShape[]
    }
  | {
      readonly kind: 'array'
      readonly item: JsonShape
    }
  | {
      /** Exactly these keys, written in this order. */
      readonly kind: 'object'
      readonly fields: Readonly<Record<string, JsonShape>>
    }
  | {
      /** Any keys, each holding `value`, written in sorted key order. */
      readonly kind: 'record'
      readonly value: JsonShape
    }

/** A strict parse: the value, or why the text is not one. */
export type ParseResult<T> =
  | {
      readonly ok: true
      readonly value: T
    }
  | {
      readonly ok: false
      readonly error: string
    }

function stringShape(what = 'a string', test: ((value: string) => boolean) | null = null): JsonShape {
  return { kind: 'string', what, test }
}

function lineShape(): JsonShape {
  return stringShape('a string without a line break', (value) => !LINE_BREAK_PATTERN.test(value))
}

function wholeShape(min = 0): JsonShape {
  return { kind: 'number', what: min === 0 ? 'a whole number' : `a whole number of at least ${min}`, whole: true, min }
}

function integerShape(): JsonShape {
  return { kind: 'number', what: 'an integer', whole: true, min: null }
}

function nonNegativeShape(): JsonShape {
  return { kind: 'number', what: 'a number of at least 0', whole: false, min: 0 }
}

function booleanShape(): JsonShape {
  return { kind: 'boolean' }
}

function literalShape(value: string | number | null): JsonShape {
  return { kind: 'literal', value }
}

function oneOfShape(...options: JsonShape[]): JsonShape {
  return { kind: 'one-of', options }
}

function literalsShape(values: readonly (string | number | null)[]): JsonShape {
  return oneOfShape(...values.map(literalShape))
}

function nullableShape(shape: JsonShape): JsonShape {
  return oneOfShape(shape, literalShape(null))
}

function arrayShape(item: JsonShape): JsonShape {
  return { kind: 'array', item }
}

function objectShape(fields: Readonly<Record<string, JsonShape>>): JsonShape {
  return { kind: 'object', fields }
}

function recordShape(value: JsonShape): JsonShape {
  return { kind: 'record', value }
}

function runIdShape(): JsonShape {
  return stringShape('a RUN_ID', isRunId)
}

function utcTimeShape(): JsonShape {
  return stringShape('a UTC time', (value) => parseUtcTimeMs(value) !== null)
}

/** Whether a JSON value is an object: not null, not an array. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A JSON value's type, as a shape's base type names it. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** The JSON type a shape's values have, or null for a choice of shapes. */
function shapeJsonType(shape: JsonShape): string | null {
  switch (shape.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'array':
      return shape.kind
    case 'literal':
      return jsonTypeOf(shape.value)
    case 'object':
    case 'record':
      return 'object'
    case 'one-of':
      return null
  }
}

function describeShape(shape: JsonShape): string {
  switch (shape.kind) {
    case 'string':
    case 'number':
      return shape.what
    case 'boolean':
      return 'a boolean'
    case 'literal':
      return JSON.stringify(shape.value)
    case 'one-of':
      return shape.options.map(describeShape).join(' or ')
    case 'array':
      return 'an array'
    case 'object':
    case 'record':
      return 'an object'
  }
}

function shapePath(path: string): string {
  return path === '' ? 'the content' : path
}

/** Why `value` departs from `shape`, naming the first place it does; null when it matches. */
function shapeMismatch(value: unknown, shape: JsonShape, path: string): string | null {
  const where = shapePath(path)
  switch (shape.kind) {
    case 'string':
      return typeof value === 'string' && (shape.test === null || shape.test(value)) ? null : `${where} is not ${shape.what}`
    case 'number': {
      const fits =
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (!shape.whole || Number.isSafeInteger(value)) &&
        (shape.min === null || value >= shape.min)
      return fits ? null : `${where} is not ${shape.what}`
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${where} is not a boolean`
    case 'literal':
      return value === shape.value ? null : `${where} is not ${JSON.stringify(shape.value)}`
    case 'one-of': {
      if (shape.options.some((option) => shapeMismatch(value, option, path) === null)) return null
      // Name the inner mismatch of the one option of the value's own JSON type.
      const sameType = shape.options.filter((option) => shapeJsonType(option) === jsonTypeOf(value))
      const only = sameType.length === 1 ? sameType[0] : undefined
      return only === undefined ? `${where} is not ${describeShape(shape)}` : shapeMismatch(value, only, path)
    }
    case 'array': {
      if (!Array.isArray(value)) return `${where} is not an array`
      for (const [index, item] of value.entries()) {
        const mismatch = shapeMismatch(item, shape.item, `${path}[${index}]`)
        if (mismatch !== null) return mismatch
      }
      return null
    }
    case 'object': {
      if (!isJsonObject(value)) return `${where} is not an object`
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape.fields, key)) return `${where} has an unexpected key ${JSON.stringify(key)}`
      }
      for (const [key, field] of Object.entries(shape.fields)) {
        if (!Object.hasOwn(value, key)) return `${where} has no key ${JSON.stringify(key)}`
        const mismatch = shapeMismatch(value[key], field, path === '' ? key : `${path}.${key}`)
        if (mismatch !== null) return mismatch
      }
      return null
    }
    case 'record': {
      if (!isJsonObject(value)) return `${where} is not an object`
      for (const [key, item] of Object.entries(value)) {
        const mismatch = shapeMismatch(item, shape.value, `${path}[${JSON.stringify(key)}]`)
        if (mismatch !== null) return mismatch
      }
      return null
    }
  }
}

/** A matching value rebuilt in its shape's key order, records' keys sorted, so serialized output is deterministic. */
function orderedByShape(value: unknown, shape: JsonShape): unknown {
  switch (shape.kind) {
    case 'one-of': {
      const option = shape.options.find((candidate) => shapeMismatch(value, candidate, '') === null)
      return option === undefined ? value : orderedByShape(value, option)
    }
    case 'array':
      return Array.isArray(value) ? value.map((item) => orderedByShape(item, shape.item)) : value
    case 'object':
      if (!isJsonObject(value)) return value
      return Object.fromEntries(Object.entries(shape.fields).map(([key, field]) => [key, orderedByShape(value[key], field)]))
    case 'record':
      if (!isJsonObject(value)) return value
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, orderedByShape(value[key], shape.value)]),
      )
    default:
      return value
  }
}

/** A value as its file's text: checked against its shape (throwing on a mismatch, so no writer writes a file its parser refuses), in the shape's key order, with a final line feed. */
function serializeShaped(what: string, value: unknown, shape: JsonShape): string {
  const mismatch = shapeMismatch(value, shape, '')
  if (mismatch !== null) throw new Error(`${what}: ${mismatch}`)
  return `${JSON.stringify(orderedByShape(value, shape), null, 2)}\n`
}

/** A file's text as JSON, or why it is not JSON. */
function parseJsonText(text: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (err) {
    return { ok: false, error: `not JSON: ${dependencyErrorText(err)}` }
  }
}

/** A JSON value as `T` when it matches `shape` exactly. */
function checkedShape<T>(value: unknown, shape: JsonShape): ParseResult<T> {
  const mismatch = shapeMismatch(value, shape, '')
  return mismatch === null ? { ok: true, value: value as T } : { ok: false, error: mismatch }
}

// The status file (b.uqm SR-5.2).

/** What every status write of one run shares: who, since when, and the current deadline. */
export interface StatusBasis {
  readonly runId: string
  readonly pid: number
  /** The runner's start, epoch milliseconds. */
  readonly startMs: number
  readonly deadline: StatusDeadline
}

/** The deadline `minutes` after the start: its UTC time and epoch seconds, both rounded down to whole seconds, and its minutes rounded halves up (b.uqm SR-5.2, SR-5.5). */
export function statusDeadline(startMs: number, minutes: number): StatusDeadline {
  const atMs = startMs + minutes * MS_PER_MINUTE
  return {
    utc: formatUtcTime(atMs),
    epochSeconds: Math.floor(atMs / MS_PER_SECOND),
    minutes: roundMinutesHalfUp(minutes),
  }
}

/** The status of a run in phase `build`, `shards` or `merge`: no `refusal` (b.uqm SR-5.2). */
export function buildStatus(basis: StatusBasis, phase: ActiveStatus['phase']): ActiveStatus {
  return {
    version: STATUS_FORMAT_VERSION,
    runId: basis.runId,
    pid: basis.pid,
    startedAt: formatUtcTime(basis.startMs),
    phase,
    deadline: basis.deadline,
  }
}

/** The status of a refused run, phase `refused` with its refusal (b.uqm SR-5.2, SR-5.8). */
export function buildRefusedStatus(basis: StatusBasis, refusal: Refusal): RefusedStatus {
  return {
    version: STATUS_FORMAT_VERSION,
    runId: basis.runId,
    pid: basis.pid,
    startedAt: formatUtcTime(basis.startMs),
    phase: 'refused',
    deadline: basis.deadline,
    refusal,
  }
}

/**
 * A refusal (b.uqm SR-5.2, SR-5.8). `reason` may be the refusal's whole first
 * line: its `NOT RUN: ` is dropped and, when there is a kind, its `<kind>: `.
 * Throws when the summary or a detail holds a line break: a caller renders an
 * argument on one line before it reaches a refusal.
 */
export function buildRefusal(kind: RefusalKind, reason: string, details: readonly string[] = []): Refusal {
  let summary = reason.startsWith(NOT_RUN_PREFIX) ? reason.slice(NOT_RUN_PREFIX.length) : reason
  const kindPrefix = kind === null ? null : `${kind}: `
  if (kindPrefix !== null && summary.startsWith(kindPrefix)) summary = summary.slice(kindPrefix.length)
  if (LINE_BREAK_PATTERN.test(summary)) throw new Error('buildRefusal: the summary holds a line break')
  for (const [index, detail] of details.entries()) {
    if (LINE_BREAK_PATTERN.test(detail)) throw new Error(`buildRefusal: detail ${index + 1} holds a line break`)
  }
  return { kind, summary, details: [...details] }
}

/** A refusal's first line, `NOT RUN: <reason>`, the reason being `<kind>: <summary>` when it has a kind (b.uqm SR-5.8). */
export function refusalLine(refusal: Refusal): string {
  return `${NOT_RUN_PREFIX}${refusal.kind === null ? '' : `${refusal.kind}: `}${refusal.summary}`
}

/** The status file's shape for one phase group: exactly b.uqm SR-5.2's keys, in its order. */
function statusShape(refused: boolean): JsonShape {
  const activePhases: readonly ActiveStatus['phase'][] = ['build', 'shards', 'merge']
  const refusalKinds: readonly RefusalKind[] = ['memory', 'disk', 'cpu', null]
  const refusedPhase: RefusedStatus['phase'] = 'refused'
  const deadline = objectShape({
    utc: utcTimeShape(),
    epochSeconds: wholeShape(),
    minutes: wholeShape(),
  })
  const common = {
    version: literalShape(STATUS_FORMAT_VERSION),
    runId: runIdShape(),
    pid: wholeShape(1),
    startedAt: utcTimeShape(),
  }
  if (!refused) return objectShape({ ...common, phase: literalsShape(activePhases), deadline })
  return objectShape({
    ...common,
    phase: literalShape(refusedPhase),
    deadline,
    refusal: objectShape({
      kind: literalsShape(refusalKinds),
      summary: lineShape(),
      details: arrayShape(lineShape()),
    }),
  })
}

/** Why a status object departs from b.uqm SR-5.2, or null when it does not. */
function statusMismatch(value: unknown): string | null {
  const refused = isJsonObject(value) && value.phase === 'refused'
  const mismatch = shapeMismatch(value, statusShape(refused), '')
  if (mismatch !== null) return mismatch
  const deadline = (value as RunStatus).deadline
  if (parseUtcTimeMs(deadline.utc) !== deadline.epochSeconds * MS_PER_SECOND) return 'deadline.utc and deadline.epochSeconds name different moments'
  return null
}

/** The status file's text: exactly its keys in b.uqm SR-5.2's order. Throws for a status that departs from that shape. */
export function serializeStatus(status: RunStatus): string {
  const mismatch = statusMismatch(status)
  if (mismatch !== null) throw new Error(`serializeStatus: ${mismatch}`)
  return `${JSON.stringify(orderedByShape(status, statusShape(status.phase === 'refused')), null, 2)}\n`
}

/** A status file's text, parsed strictly: exact keys, `version` 1, the types and the phase values (b.uqm SR-5.2). Anything else counts as no status file. */
export function parseStatus(text: string): ParseResult<RunStatus> {
  const json = parseJsonText(text)
  if (!json.ok) return json
  const mismatch = statusMismatch(json.value)
  return mismatch === null ? { ok: true, value: json.value as RunStatus } : { ok: false, error: mismatch }
}

/** Replaces the run directory's status file whole: a temporary file in the run directory, then a rename (b.uqm SR-5.2). A failed write leaves the previous file as it was. */
export function writeStatusFile(runDir: string, status: RunStatus): WriteResult {
  let text: string
  try {
    text = serializeStatus(status)
  } catch (err) {
    return { ok: false, error: dependencyErrorText(err) }
  }
  return writeWholeFile(runDir, STATUS_FILE_NAME, text)
}

/** The run directory's status file, or null for no status file: missing, unreadable, unparseable or of another shape (b.uqm SR-5.2). */
export function readStatusFile(runDir: string): RunStatus | null {
  const read = readFileText(join(runDir, STATUS_FILE_NAME))
  if (read.kind !== 'text') return null
  const parsed = parseStatus(read.text)
  return parsed.ok ? parsed.value : null
}

// Owners and liveness (b.uqm Terms, SR-6.3).

/** An owner's text, `<RUN_ID>-<PID>`. */
export function formatOwner(owner: Owner): string {
  return `${owner.runId}-${owner.pid}`
}

/** An owner parsed from the right of `<RUN_ID>-<PID>`, so the RUN_ID's own hyphen never confuses the PID; null when malformed (b.uqm SR-6.3). */
export function parseOwner(text: string): Owner | null {
  const at = text.lastIndexOf('-')
  if (at < 0) return null
  const runId = text.slice(0, at)
  const pidText = text.slice(at + 1)
  if (!isRunId(runId) || !PID_TEXT_PATTERN.test(pidText)) return null
  const pid = Number(pidText)
  return Number.isSafeInteger(pid) ? { runId, pid } : null
}

/** The owner label as a `--label` argument and a filter, `cscb-ci-owner=<RUN_ID>-<PID>` (b.uqm Terms). */
export function ownerLabel(owner: Owner): string {
  return `${OWNER_LABEL}=${formatOwner(owner)}`
}

/** What liveness needs: the PID liveness test and the `/proc` command-line read. `RunnerDeps` satisfies it, and so can the reader's own seam. */
export type OwnerLivenessProbe = Pick<RunnerDeps, 'isPidAlive' | 'readProcCmdline'>

/** Whether a command line holds an argument ending in `scripts/ci-run.ts` followed immediately by `runId` (b.uqm SR-6.3). */
export function isRunnerCommandLine(args: readonly string[], runId: string): boolean {
  return args.some((arg, index) => arg.endsWith(RUNNER_PATH_SUFFIX) && args[index + 1] === runId)
}

/**
 * Whether an owner is alive (b.uqm SR-6.3): only when its PID is a live
 * process whose command line holds an argument ending in `scripts/ci-run.ts`
 * followed immediately by its RUN_ID. Every other owner is dead: a gone PID, a
 * PID reused by another program or by a `/ci` runner with another RUN_ID, and
 * a PID whose command line cannot be read.
 */
export function isOwnerAlive(owner: Owner, probe: OwnerLivenessProbe): boolean {
  if (!probe.isPidAlive(owner.pid)) return false
  const cmdline = probe.readProcCmdline(owner.pid)
  return cmdline.kind === 'value' && isRunnerCommandLine(cmdline.value, owner.runId)
}

/** An owner read from labels: alive, dead (its owner null when the label is missing or malformed), or no run's at all. */
export type LabelledOwner =
  | {
      readonly kind: 'alive'
      readonly owner: Owner
    }
  | {
      readonly kind: 'dead'
      readonly owner: Owner | null
    }
  | {
      readonly kind: 'no-run'
    }

function judgedLabelOwner(value: string | undefined, probe: OwnerLivenessProbe): LabelledOwner {
  const owner = value === undefined ? null : parseOwner(value)
  if (owner === null) return { kind: 'dead', owner: null }
  return isOwnerAlive(owner, probe) ? { kind: 'alive', owner } : { kind: 'dead', owner }
}

function labelValue(labels: Readonly<Record<string, string>> | null, name: string): string | undefined {
  return labels !== null && Object.hasOwn(labels, name) ? labels[name] : undefined
}

/** A container's owner from its labels (b.uqm SR-6.3): a `cscb-ci=1` container whose owner label is missing, empty or malformed has a dead owner; a container without `cscb-ci=1` is no run's. */
export function containerLabelOwner(labels: Readonly<Record<string, string>> | null, probe: OwnerLivenessProbe): LabelledOwner {
  if (labelValue(labels, CI_LABEL) !== CI_LABEL_VALUE) return { kind: 'no-run' }
  return judgedLabelOwner(labelValue(labels, OWNER_LABEL), probe)
}

/** An image's owner from its labels (b.uqm SR-6.3): a malformed owner label is a dead owner; an image without one belongs to no run. */
export function imageLabelOwner(labels: Readonly<Record<string, string>> | null, probe: OwnerLivenessProbe): LabelledOwner {
  const value = labelValue(labels, OWNER_LABEL)
  if (value === undefined) return { kind: 'no-run' }
  return judgedLabelOwner(value, probe)
}

/** A run-private tag's owner and role. */
export interface RunTag {
  readonly owner: Owner
  readonly role: RunTagRole
}

/** A run-private tag, `cscb-ci-run:<RUN_ID>-<PID>-<role>` (b.uqm SR-9.3). */
export function formatRunTag(owner: Owner, role: RunTagRole): string {
  return `${RUN_TAG_REPOSITORY}:${formatOwner(owner)}-${role}`
}

/** A run-private tag's owner and role, or null for a tag of any other shape, such as `cscb-ci:latest`, `cscb-ci-base:v6` or `cscb-ci-l5:m5` (b.uqm SR-6.4, SR-9.3). */
export function parseRunTag(tag: string): RunTag | null {
  const prefix = `${RUN_TAG_REPOSITORY}:`
  if (!tag.startsWith(prefix)) return null
  const rest = tag.slice(prefix.length)
  const at = rest.lastIndexOf('-')
  if (at < 0) return null
  const roleText = rest.slice(at + 1)
  const role = RUN_TAG_ROLES.find((candidate) => candidate === roleText)
  if (role === undefined) return null
  const owner = parseOwner(rest.slice(0, at))
  return owner === null ? null : { owner, role }
}

// ---------------------------------------------------------------------------
// 5. File formats (E1)
// ---------------------------------------------------------------------------

// --- 5/T3 (E1 T3): reservation and results formats, verdict write, result-file reading, in-shard records, runner log ---

/** A write's outcome: done, or failed with its error on one line. */
export type WriteResult =
  | {
      readonly ok: true
    }
  | {
      readonly ok: false
      readonly error: string
    }

/** A file's text read read-only: its content, missing, or unreadable with the error on one line. */
export type FileTextRead =
  | {
      readonly kind: 'text'
      readonly text: string
    }
  | {
      readonly kind: 'missing'
    }
  | {
      readonly kind: 'unreadable'
      readonly error: string
    }

/** A file's text, read-only. Missing only when the path does not exist; any other failure is unreadable. */
export function readFileText(path: string): FileTextRead {
  try {
    return { kind: 'text', text: readFileSync(path, 'utf-8') }
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', error: dependencyErrorText(err) }
  }
}

/** The temporary file a whole-file write of `fileName` goes through: a dot name, never a reservation name. */
export function atomicTempFileName(fileName: string): string {
  return `.${fileName}.tmp`
}

/**
 * Replaces `dir/fileName` whole: writes a temporary file in the same
 * directory, then renames it over the target, so a reader sees the old file
 * or the new one and never a partial one. A failed write removes its
 * temporary file where it can and leaves the previous file as it was. The
 * status file, the verdict, the reservation and a rewrite of the results and
 * summary all go through it (b.uqm SR-5.2, SR-5.6, SR-5.7, SR-6.2).
 * A temporary file left by an interrupted write, or a link planted at its
 * name, is removed first (the link itself, never what it points to), and the
 * temporary file is then created exclusively, so the file written is always a
 * new one at `WRITTEN_FILE_MODE` and a link there is never followed.
 * The runner cannot use `src/atomic-write.ts`: SR-1.3 forbids it loading `src/`.
 */
export function writeWholeFile(dir: string, fileName: string, content: string): WriteResult {
  const target = join(dir, fileName)
  const temp = join(dir, atomicTempFileName(fileName))
  try {
    rmSync(temp, { force: true })
    writeFileSync(temp, content, { mode: WRITTEN_FILE_MODE, flag: 'wx' })
    renameSync(temp, target)
    return { ok: true }
  } catch (err) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // The write already failed; that failure is the one reported.
    }
    return { ok: false, error: `writing ${target} failed: ${dependencyErrorText(err)}` }
  }
}

/** Writes `verdict.txt` whole, its one line then a line feed: a temporary file in the run directory, then a rename (b.uqm SR-5.7). A line holding a line break is refused. */
export function writeVerdictFile(runDir: string, line: string): WriteResult {
  if (LINE_BREAK_PATTERN.test(line)) return { ok: false, error: 'the verdict line holds a line break' }
  return writeWholeFile(runDir, VERDICT_FILE_NAME, `${line}\n`)
}

// Reservations (b.uqm SR-6.2) and results.json (b.uqm SR-16.1).

/** A reservation's file name, `<RUN_ID>-<PID>.json` (b.uqm SR-6.2). */
export function reservationFileName(owner: Owner): string {
  return `${formatOwner(owner)}${RESERVATION_FILE_SUFFIX}`
}

/** The owner a reservation file name names, or null for a name that is no reservation name. */
export function reservationOwnerFromFileName(fileName: string): Owner | null {
  if (!fileName.endsWith(RESERVATION_FILE_SUFFIX)) return null
  return parseOwner(fileName.slice(0, -RESERVATION_FILE_SUFFIX.length))
}

/** Whether a name beside the lock is a reservation name; any other file there is ignored (b.uqm SR-6.2). */
export function isReservationFileName(fileName: string): boolean {
  return reservationOwnerFromFileName(fileName) !== null
}

/** The temporary file a reservation write goes through, whose name is never a reservation name (b.uqm SR-6.2). */
export function reservationTempFileName(owner: Owner): string {
  return atomicTempFileName(reservationFileName(owner))
}

function reservationShape(): JsonShape {
  const kinds: readonly RunKind[] = ['full', 'selective']
  return objectShape({
    version: literalShape(RESERVATION_FORMAT_VERSION),
    runId: runIdShape(),
    pid: wholeShape(1),
    shards: wholeShape(),
    memoryBytes: wholeShape(),
    cpus: wholeShape(),
    kind: literalsShape(kinds),
  })
}

/** A reservation's file text: exactly b.uqm SR-6.2's keys, in its order. Throws for a reservation of another shape. */
export function serializeReservation(reservation: Reservation): string {
  return serializeShaped('serializeReservation', reservation, reservationShape())
}

/** A reservation file's text, parsed strictly: exact keys, `version` 1, whole numbers, `kind` full or selective (b.uqm SR-6.2). */
export function parseReservation(text: string): ParseResult<Reservation> {
  const json = parseJsonText(text)
  return json.ok ? checkedShape<Reservation>(json.value, reservationShape()) : json
}

function hexShape(length: number): JsonShape {
  return stringShape(`${length} lowercase hexadecimal characters`, (value) => isLowerHex(value, length))
}

function inspectionShape(): JsonShape {
  return objectShape({
    name: stringShape(),
    imageId: stringShape(),
    mounts: arrayShape(
      objectShape({
        source: stringShape(),
        target: stringShape(),
        readOnly: booleanShape(),
      }),
    ),
    networkMode: stringShape(),
    pidMode: stringShape(),
    ipcMode: stringShape(),
    privileged: booleanShape(),
    memoryBytes: integerShape(),
    memorySwapBytes: integerShape(),
    pidsLimit: nullableShape(integerShape()),
    nanoCpus: integerShape(),
    labels: recordShape(stringShape()),
    autoRemove: booleanShape(),
  })
}

function workingSetReadingShape(): JsonShape {
  return objectShape({
    bytes: wholeShape(),
    anonBytes: wholeShape(),
    activeFileBytes: wholeShape(),
  })
}

/** `results.json`'s shape: exactly b.uqm SR-16.1's keys and nesting, in its order. Counts and bytes are whole numbers; seconds are numbers. */
function resultsShape(): JsonShape {
  const scriptResults: readonly ResultsScript['result'][] = ['pass', 'fail', 'notrun']
  const anonPeakMarks: readonly ResultsAnonPeak['mark'][] = [null, 'partial', 'unknown']
  const mode = stringShape('a four-digit octal mode', (value) => /^[0-7]{4}$/.test(value))
  const sha256 = hexShape(SHA256_HEX_LENGTH)
  return objectShape({
    version: literalShape(RESULTS_FORMAT_VERSION),
    runId: runIdShape(),
    pid: wholeShape(1),
    packageSha256: nullableShape(sha256),
    images: objectShape({
      pinned: nullableShape(stringShape()),
      drift: nullableShape(stringShape()),
      retag: nullableShape(stringShape()),
      retagMoved: booleanShape(),
    }),
    verdict: stringShape(),
    invocation: objectShape({
      args: arrayShape(stringShape()),
      selective: booleanShape(),
      faults: arrayShape(stringShape()),
    }),
    scripts: arrayShape(
      objectShape({
        script: stringShape(),
        shard: wholeShape(1),
        result: literalsShape(scriptResults),
        seconds: nullableShape(nonNegativeShape()),
        failLine: nullableShape(stringShape()),
      }),
    ),
    shards: arrayShape(
      objectShape({
        shard: wholeShape(1),
        assigned: arrayShape(stringShape()),
        expectedSeconds: nonNegativeShape(),
        limitMinutes: nonNegativeShape(),
        endedNormally: booleanShape(),
        end: stringShape(),
        seconds: nullableShape(nonNegativeShape()),
        anonPeak: objectShape({
          bytes: nullableShape(wholeShape()),
          pageCacheBytes: nullableShape(wholeShape()),
          mark: literalsShape(anonPeakMarks),
        }),
        peakPids: nullableShape(wholeShape()),
        final: objectShape({
          oomKilled: oneOfShape(booleanShape(), literalShape(UNREADABLE_READING)),
          oomKillCount: oneOfShape(wholeShape(), literalShape(UNREADABLE_READING)),
        }),
        failedReadings: wholeShape(),
        packageSha256: nullableShape(sha256),
        dependencyFingerprint: nullableShape(sha256),
        imageId: nullableShape(stringShape()),
        inspection: nullableShape(inspectionShape()),
        inspectionError: nullableShape(stringShape()),
      }),
    ),
    shardCount: objectShape({
      requested: wholeShape(),
      effective: wholeShape(),
      admitted: wholeShape(),
      started: wholeShape(),
      reasons: arrayShape(stringShape()),
    }),
    cap: objectShape({
      usedBytes: wholeShape(),
      peakBytes: nullableShape(wholeShape()),
      peakShard: nullableShape(wholeShape(1)),
      peakPageCacheBytes: nullableShape(wholeShape()),
      peakFromKill: nullableShape(booleanShape()),
      derivedBytes: nullableShape(wholeShape()),
      suffix: nullableShape(stringShape()),
    }),
    workingSet: objectShape({
      before: nullableShape(workingSetReadingShape()),
      peak: nullableShape(workingSetReadingShape()),
      after: nullableShape(workingSetReadingShape()),
    }),
    failedReadings: wholeShape(),
    modes: objectShape({
      runDir: mode,
      tarball: nullableShape(mode),
      shardDirs: recordShape(mode),
    }),
    failures: arrayShape(
      objectShape({
        line: stringShape(),
        shard: nullableShape(wholeShape(1)),
      }),
    ),
    skippedChecks: arrayShape(stringShape()),
    cleanupFailures: arrayShape(stringShape()),
    timing: objectShape({
      buildSeconds: nonNegativeShape(),
      baseBuildSeconds: nonNegativeShape(),
      totalSeconds: nonNegativeShape(),
    }),
    timingSummary: arrayShape(stringShape()),
  })
}

/** `results.json`'s text: exactly b.uqm SR-16.1's keys and nesting, in its order, records' keys sorted. Throws for results of another shape. */
export function serializeResults(results: Results): string {
  return serializeShaped('serializeResults', results, resultsShape())
}

/** `results.json`'s text, parsed strictly: the exact keys and nesting of b.uqm SR-16.1, `version` 1. The reader's narrow read of `version` and `timingSummary` is its own (E3). */
export function parseResults(text: string): ParseResult<Results> {
  const json = parseJsonText(text)
  return json.ok ? checkedShape<Results>(json.value, resultsShape()) : json
}

// Result files and the in-shard records (b.uqm SR-11.3, SR-11.5).

/** A script's wall time as a result file writes it: digits, a point and exactly three digits (`21.347`, `0.512`). Throws for a negative or non-finite time. */
export function formatResultSeconds(seconds: number): string {
  const text = Number.isFinite(seconds) && seconds >= 0 ? seconds.toFixed(3) : ''
  if (!RESULT_SECONDS_PATTERN.test(text)) throw new Error(`formatResultSeconds: not a script time: ${seconds}`)
  return text
}

/** One complete result-file line as its event, or null for a line of no known form (b.uqm SR-11.3). Fields are separated by single spaces. */
export function parseResultLine(line: string): ResultEvent | null {
  const fields = line.split(' ')
  const [word, fileName, result, seconds] = fields
  if (fields.length === 1 && word === RESULT_WORD_DONE) return { kind: RESULT_WORD_DONE }
  if (fileName === undefined || !SCRIPT_FILE_NAME_PATTERN.test(fileName)) return null
  if (fields.length === 2 && word === RESULT_WORD_START) return { kind: RESULT_WORD_START, fileName }
  if (fields.length === 2 && word === RESULT_WORD_NOTRUN) return { kind: RESULT_WORD_NOTRUN, fileName }
  if (fields.length !== 4 || word !== RESULT_WORD_END || seconds === undefined || !RESULT_SECONDS_PATTERN.test(seconds)) return null
  if (result === RESULT_WORD_PASS) return { kind: RESULT_WORD_END, fileName, result: RESULT_WORD_PASS, seconds: Number(seconds) }
  if (result === RESULT_WORD_FAIL) return { kind: RESULT_WORD_END, fileName, result: RESULT_WORD_FAIL, seconds: Number(seconds) }
  return null
}

/** One result-file line, without its line feed (b.uqm SR-11.3). Throws for an event no reader would read back, such as a bad file name. */
export function formatResultLine(event: ResultEvent): string {
  let line: string
  switch (event.kind) {
    case 'start':
      line = `${RESULT_WORD_START} ${event.fileName}`
      break
    case 'end':
      line = `${RESULT_WORD_END} ${event.fileName} ${event.result === 'pass' ? RESULT_WORD_PASS : RESULT_WORD_FAIL} ${formatResultSeconds(event.seconds)}`
      break
    case 'notrun':
      line = `${RESULT_WORD_NOTRUN} ${event.fileName}`
      break
    case 'done':
      line = RESULT_WORD_DONE
      break
  }
  if (parseResultLine(line) === null) throw new Error(`formatResultLine: not a result-file line: ${JSON.stringify(line)}`)
  return line
}

/** A result file's text: each event's line, each ending in a line feed (b.uqm SR-11.3). */
export function formatResultFile(events: readonly ResultEvent[]): string {
  return events.map((event) => `${formatResultLine(event)}\n`).join('')
}

/** The injected-failure line a `fail:` fault's script log holds, `FAIL: <file name>: injected failure` (b.uqm SR-11.3, SR-14.2). */
export function injectedFailureLine(fileName: string): string {
  return `${FAIL_PREFIX}${fileName}: ${INJECTED_FAILURE_TEXT}`
}

/**
 * A result file's text read by lines (b.uqm SR-11.3): a last line without its
 * line feed is still being written and is ignored; a complete line of no
 * known form, a carriage return included, makes the file unreadable.
 */
export function parseResultFileText(text: string): ResultFileRead {
  const lines = text.split('\n')
  // The last piece is the partial last line, or empty after a final line feed.
  lines.pop()
  const events: ResultEvent[] = []
  for (const [index, line] of lines.entries()) {
    const event = parseResultLine(line)
    if (event === null) return { kind: 'unreadable', error: `${RESULT_FILE_NAME} line ${index + 1} is of no result-file form` }
    events.push(event)
  }
  return { kind: 'events', events }
}

/** A shard's result file, `result.txt` in its shard subdirectory: its events, missing, or unreadable (b.uqm SR-11.3, SR-12.1). A missing file is never unreadable. */
export function readResultFile(shardDir: string): ResultFileRead {
  const read = readFileText(join(shardDir, RESULT_FILE_NAME))
  if (read.kind === 'missing') return { kind: 'missing' }
  if (read.kind === 'unreadable') return { kind: 'unreadable', error: read.error }
  return parseResultFileText(read.text)
}

/** Whether `text` is exactly `length` lowercase hexadecimal characters. */
function isLowerHex(text: string, length: number): boolean {
  return text.length === length && /^[0-9a-f]*$/.test(text)
}

/** An in-shard hex record as read: its value, missing, or malformed (wrong length, uppercase, no final line feed, unreadable). */
export type HexRecordRead =
  | {
      readonly kind: 'value'
      readonly value: string
    }
  | {
      readonly kind: 'missing'
    }
  | {
      readonly kind: 'malformed'
      readonly error: string
    }

/** A hex record's text: `length` lowercase hexadecimal characters and one line feed (`canary.txt` 32, `package.sha256` and `dependency-fingerprint.txt` 64; b.uqm SR-11.3). Throws for a value of another form. */
export function formatHexRecord(value: string, length: number): string {
  if (!isLowerHex(value, length)) throw new Error(`formatHexRecord: not ${length} lowercase hexadecimal characters`)
  return `${value}\n`
}

/** A hex record's value from its text, or why it is malformed. */
export function parseHexRecord(text: string, length: number): ParseResult<string> {
  const value = text.endsWith('\n') ? text.slice(0, -1) : null
  if (value === null) return { ok: false, error: 'no final line feed' }
  if (!isLowerHex(value, length)) return { ok: false, error: `not ${length} lowercase hexadecimal characters then one line feed` }
  return { ok: true, value }
}

/** An in-shard hex record file (`canary.txt`, `package.sha256`, `dependency-fingerprint.txt`): its value, missing, or malformed. */
export function readHexRecord(path: string, length: number): HexRecordRead {
  const read = readFileText(path)
  if (read.kind === 'missing') return { kind: 'missing' }
  if (read.kind === 'unreadable') return { kind: 'malformed', error: read.error }
  const parsed = parseHexRecord(read.text, length)
  return parsed.ok ? { kind: 'value', value: parsed.value } : { kind: 'malformed', error: parsed.error }
}

// The runner log (b.uqm SR-5.4, SR-15.3, SR-18.3).

/** A word a shell reads back as itself, unquoted. */
const SHELL_PLAIN_WORD_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/
/** A character that holds a control character, which only `$'…'` quoting keeps on one line. */
const SHELL_CONTROL_PATTERN = /[\x00-\x1f\x7f]/
/** The runner log's first line: groups are the RUN_ID, the PID and the argument part (empty, or a space then the words). The `s` flag lets the argument part hold U+2028 and U+2029, which a quoted argument may carry (b.uqm SR-18.3). */
const RUNNER_LOG_FIRST_LINE_PATTERN = /^ci-run: run (\S+) pid ([1-9][0-9]*): \/ci((?: .*)?)$/s

/** The escapes `$'…'` quoting writes for its named control characters, and reads back. */
const ANSI_C_ESCAPES: Readonly<Record<string, string>> = { '\n': 'n', '\r': 'r', '\t': 't', '\\': '\\', "'": "'" }

/** An argument quoted so a shell gives it back exactly: as it is when plain, in single quotes, or in `$'…'` when it holds a control character. */
function shellQuoted(arg: string): string {
  if (SHELL_PLAIN_WORD_PATTERN.test(arg)) return arg
  if (!SHELL_CONTROL_PATTERN.test(arg)) return `'${arg.replaceAll("'", `'\\''`)}'`
  let body = ''
  for (const char of arg) {
    const named = ANSI_C_ESCAPES[char]
    if (named !== undefined) body += `\\${named}`
    else if (SHELL_CONTROL_PATTERN.test(char)) body += `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    else body += char
  }
  return `$'${body}'`
}

/** The body of a `$'…'` word from just after its opening quote: the text and the index after its closing quote, or null when malformed. */
function readAnsiCQuoted(text: string, start: number): { readonly value: string; readonly next: number } | null {
  let value = ''
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === "'") return { value, next: index + 1 }
    if (char !== '\\') {
      value += char
      index += 1
      continue
    }
    const escape = text[index + 1]
    const named = Object.entries(ANSI_C_ESCAPES).find(([, letter]) => letter === escape)
    if (named !== undefined) {
      value += named[0]
      index += 2
    } else if (escape === 'x' && /^[0-9a-f]{2}$/.test(text.slice(index + 2, index + 4))) {
      value += String.fromCharCode(parseInt(text.slice(index + 2, index + 4), 16))
      index += 4
    } else {
      return null
    }
  }
  return null
}

/** The words of a first line's argument part as `shellQuoted` wrote them, each after one space; null when it is not of that form. */
function parseShellQuotedWords(text: string): string[] | null {
  const words: string[] = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== ' ') return null
    index += 1
    let word = ''
    let started = false
    while (index < text.length && text[index] !== ' ') {
      const char = text[index] as string
      if (char === "'") {
        const end = text.indexOf("'", index + 1)
        if (end < 0) return null
        word += text.slice(index + 1, end)
        index = end + 1
      } else if (char === '$' && text[index + 1] === "'") {
        const quoted = readAnsiCQuoted(text, index + 2)
        if (quoted === null) return null
        word += quoted.value
        index = quoted.next
      } else if (char === '\\' && text[index + 1] === "'") {
        word += "'"
        index += 2
      } else if (SHELL_PLAIN_WORD_PATTERN.test(char)) {
        word += char
        index += 1
      } else {
        return null
      }
      started = true
    }
    if (!started) return null
    words.push(word)
  }
  return words
}

/**
 * The runner log's first line (b.uqm SR-5.4): the RUN_ID, the runner's PID
 * and the `/ci` arguments as given, `ci-run: run <RUN_ID> pid <PID>: /ci
 * <arguments>`. Each argument is quoted as a shell needs, so pasting the part
 * after `/ci` onto a command line gives back exactly the same arguments
 * (b.uqm SR-18.3, "Finishing a run by hand").
 */
export function formatRunnerLogFirstLine(runId: string, pid: number, args: readonly string[]): string {
  return `ci-run: run ${runId} pid ${pid}: /ci${args.map((arg) => ` ${shellQuoted(arg)}`).join('')}`
}

/** The runner log's first line, read back. */
export interface RunnerLogFirstLine {
  readonly runId: string
  readonly pid: number
  /** The `/ci` arguments as given. */
  readonly args: readonly string[]
}

/** The RUN_ID, PID and exact `/ci` arguments from a runner log's first line (the text up to its first line feed); null when it is not of that form. */
export function parseRunnerLogFirstLine(logText: string): RunnerLogFirstLine | null {
  const lineEnd = logText.indexOf('\n')
  const match = RUNNER_LOG_FIRST_LINE_PATTERN.exec(lineEnd < 0 ? logText : logText.slice(0, lineEnd))
  if (match === null) return null
  const [, runId, pidText, argPart] = match
  if (runId === undefined || pidText === undefined || argPart === undefined || !isRunId(runId)) return null
  const pid = Number(pidText)
  const args = parseShellQuotedWords(argPart)
  return Number.isSafeInteger(pid) && args !== null ? { runId, pid, args } : null
}

/** The first line of the run directory's `runner.log`, read back; null when the log is missing, unreadable or does not start with one. */
export function readRunnerLogFirstLine(runDir: string): RunnerLogFirstLine | null {
  const read = readFileText(join(runDir, RUNNER_LOG_FILE_NAME))
  return read.kind === 'text' ? parseRunnerLogFirstLine(read.text) : null
}

/**
 * The runner-log writer (b.uqm SR-5.4). Called as a `RunnerLogSink`, it
 * appends one line (or each line of a text holding line feeds). Every append
 * is synchronous, so a line is in the file when the call returns.
 */
export interface RunnerLogWriter {
  (line: string): void
  /** The log file's path. */
  readonly path: string
  /** Appends a child process's output, split into its lines; a final line feed ends the last line, and empty output writes nothing. */
  childOutput(text: string): void
  /** Appends an error: one `error: ` line with its message (after `context: ` when given), then its stack frames. */
  error(err: unknown, context?: string): void
  /** Switches redaction on, or adds values to it: from now on each value is replaced with `<redacted>` in every line, child output included (b.uqm SR-15.3). Empty values are ignored. */
  redactValues(values: Iterable<string>): void
}

/** How a runner-log writer reports an append that failed. */
export interface RunnerLogOptions {
  /** Told each failed append's error on one line; without it a failed append is dropped. */
  readonly onAppendError?: (error: string) => void
}

/** A text's log lines: split at line feeds, a final line feed ending the last line. */
function runnerLogLines(text: string, emptyWritesLine: boolean): string[] {
  if (text === '') return emptyWritesLine ? [''] : []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/** An error's log lines: `error: [<context>: ][<name>: ]<message on one line>`, then each stack frame. */
function runnerLogErrorLines(err: unknown, context: string | undefined): string[] {
  const where = context === undefined ? '' : `${context}: `
  if (!(err instanceof Error)) return [`error: ${where}${dependencyErrorText(err)}`]
  const frames = (err.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line))
  return [`error: ${where}${err.name}: ${dependencyErrorText(err)}`, ...frames]
}

/** A pattern matching any of the values, longest first, so one pass replaces each whole value; null for none. */
function redactionPattern(values: readonly string[]): RegExp | null {
  if (values.length === 0) return null
  const escaped = [...values].sort((a, b) => b.length - a.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(escaped.join('|'), 'g')
}

/**
 * Creates the writer for the runner log at `path`, appending to it (and
 * creating it when missing). Redaction is off until `redactValues` switches
 * it on (E11, from the start of `secret-scan`). Every line the runner writes
 * to its log, child-process output included, goes through this writer.
 */
export function createRunnerLog(path: string, options: RunnerLogOptions = {}): RunnerLogWriter {
  const redacted: string[] = []
  let pattern: RegExp | null = null
  const append = (lines: readonly string[]): void => {
    if (lines.length === 0) return
    const text = lines.map((line) => `${pattern === null ? line : line.replace(pattern, REDACTION_PLACEHOLDER)}\n`).join('')
    try {
      appendFileSync(path, text, { mode: WRITTEN_FILE_MODE })
    } catch (err) {
      options.onAppendError?.(dependencyErrorText(err))
    }
  }
  const write = (line: string): void => append(runnerLogLines(line, true))
  return Object.assign(write, {
    path,
    childOutput: (text: string): void => append(runnerLogLines(text, false)),
    error: (err: unknown, context?: string): void => append(runnerLogErrorLines(err, context)),
    redactValues: (values: Iterable<string>): void => {
      for (const value of values) {
        if (value !== '' && !redacted.includes(value)) redacted.push(value)
      }
      pattern = redactionPattern(redacted)
    },
  })
}

// ---------------------------------------------------------------------------
// 6. Docker layer (E1)
// ---------------------------------------------------------------------------

// --- 6/T4 (E1 T4): one fixed argument form per docker operation; docker run lists logged ---
//
// One exported argument-list builder per docker operation the runner uses,
// and one function per operation that spawns exactly that list through the
// spawn it is given, with the child environment it is given (b.uqm SR-15.4):
// this layer reads no environment and builds none. Every answer is a value,
// never a throw: a non-zero exit, an answer that cannot be parsed and an
// argument the layer refuses are each a failure carrying the exit status
// (null when the layer refused an argument and spawned nothing) and the error
// on one line. The fake container interface answers exactly these forms.
//
// Fixed here:
// - no inspect form selects `Config.Env` or any other environment field (b.uqm SR-10.5);
// - the only image removals are a tag removal naming one run-private tag and
//   a prune of untagged images filtered on one exact owner label: no image is
//   removed by an ID or a digest, and no removal is forced (b.uqm SR-6.4, SR-9.3);
// - both builds start in a process group of their own (b.uqm SR-5.6) and take
//   their image ID from their own output, never from a tag lookup (b.uqm SR-9.3);
// - a `docker run` list is checked, then written to the runner log as one
//   line, then spawned; a refused list is neither logged nor spawned
//   (b.uqm SR-10.4, SR-15.2).

/** The program every docker operation runs, looked up on the child environment's `PATH`. */
export const DOCKER_PROGRAM = 'docker'
/** A full image ID as Docker gives it, `sha256:<64 lowercase hex>`. */
export const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/
/** A full container ID as Docker gives it, 64 lowercase hex. */
export const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/
/** A build's own report of its image ID in `--progress=plain` output (BuildKit, the classic image store): `#<n> writing image sha256:<hex> done`; group 1 is the ID. */
export const BUILD_IMAGE_ID_PATTERN = /\bwriting image (sha256:[0-9a-f]{64})\b/
/** The progress option of both builds: plain text lines, which reach the runner log and carry the image ID. */
export const BUILD_PROGRESS_OPTION = '--progress=plain'
/** The prefix of the runner-log line that holds a `docker run` argument list, as JSON, ahead of its spawn (b.uqm SR-10.4). */
export const DOCKER_RUN_LOG_PREFIX = 'docker run: '

/** A label key the layer passes: a letter or digit, then letters, digits, `.`, `_`, `/` and `-`. */
const DOCKER_LABEL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
/** A control character, line breaks included: never inside a docker argument. */
const DOCKER_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
/** The untagged placeholder an old daemon may put in `RepoTags`; never a tag. */
const DOCKER_UNTAGGED_PLACEHOLDER = '<none>:<none>'

/**
 * The container state form's Go template: one JSON object per container,
 * with its ID, name, status, running flag, `State.Pid` (0 when not running),
 * `State.OOMKilled`, `State.ExitCode`, memory cap (`HostConfig.Memory`, 0 when
 * unset) and labels. It selects no environment field.
 */
export const CONTAINER_STATE_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},"running":{{json .State.Running}},' +
  '"pid":{{json .State.Pid}},"oomKilled":{{json .State.OOMKilled}},"exitCode":{{json .State.ExitCode}},' +
  '"memoryBytes":{{json .HostConfig.Memory}},"labels":{{json .Config.Labels}}}'

/**
 * The inspection form's Go template: b.uqm SR-10.5's fields only (name, image
 * ID, each mount's source, target and read-write flag, network, PID and IPC
 * modes, privileged flag, memory, memory-swap, PID and CPU limits, labels and
 * the self-removal setting), one JSON object. It selects no environment field.
 */
export const CONTAINER_INSPECTION_FORMAT =
  '{"name":{{json .Name}},"imageId":{{json .Image}},' +
  '"mounts":[{{range $i, $m := .Mounts}}{{if $i}},{{end}}{"source":{{json $m.Source}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}],' +
  '"networkMode":{{json .HostConfig.NetworkMode}},"pidMode":{{json .HostConfig.PidMode}},"ipcMode":{{json .HostConfig.IpcMode}},' +
  '"privileged":{{json .HostConfig.Privileged}},"memoryBytes":{{json .HostConfig.Memory}},"memorySwapBytes":{{json .HostConfig.MemorySwap}},' +
  '"pidsLimit":{{json .HostConfig.PidsLimit}},"nanoCpus":{{json .HostConfig.NanoCpus}},"labels":{{json .Config.Labels}},' +
  '"autoRemove":{{json .HostConfig.AutoRemove}}}'

/** The image inspect form's Go template: one JSON object per image, with its ID, its tags and its labels (null when it has no config). */
export const IMAGE_INSPECT_FORMAT =
  '{"id":{{json .Id}},"tags":{{json .RepoTags}},"labels":{{with .Config}}{{json .Labels}}{{else}}null{{end}}}'

/** What every docker operation spawns with. Callers build it from `RunnerDeps.spawn`, the child-environment rule and the worktree root. */
export interface DockerContext {
  /** The spawn dependency (`RunnerDeps.spawn`). */
  readonly spawn: SpawnFn
  /** The child environment, as the child-environment rule gives it (b.uqm SR-15.4); passed on unchanged. */
  readonly env: Readonly<Record<string, string>>
  /** The working directory of every docker command: the worktree root. */
  readonly cwd: string
}

/** A docker operation that failed. */
export interface DockerFailure {
  readonly ok: false
  /** The command's exit status; null when the layer refused an argument and spawned nothing. */
  readonly exitCode: number | null
  /** Its standard error, or why its answer could not be used, on one line. */
  readonly error: string
}

/** A docker operation's answer: its parsed value, or a failure. */
export type DockerAnswer<T> =
  | {
      readonly ok: true
      readonly value: T
    }
  | DockerFailure

/** Labels to set, in the order given, each as `--label <key>=<value>`. */
export type DockerLabels = Readonly<Record<string, string>>

/** Sends a signal: `RunnerDeps.sendSignal`. */
export type DockerSignalSender = RunnerDeps['sendSignal']

/** A container in the state form. */
export interface ContainerState {
  /** Its full ID. */
  readonly id: string
  /** Its name, without Docker's leading `/`. */
  readonly name: string
  /** Docker's `State.Status`: `created`, `running`, `paused`, `restarting`, `removing`, `exited` or `dead`. */
  readonly status: string
  readonly running: boolean
  /** `State.Pid`: 0 when it is not running. */
  readonly pid: number
  /** `State.OOMKilled`. */
  readonly oomKilled: boolean
  /** `State.ExitCode`. */
  readonly exitCode: number
  /** Its memory cap in bytes; null when none is set. */
  readonly memoryCapBytes: number | null
  /** Every label with its value. */
  readonly labels: Readonly<Record<string, string>>
}

/** An image as the image inspect form gives it. */
export interface ImageRecord {
  /** Its image ID, `sha256:<hex>`. */
  readonly id: string
  /** Its tags; none when it is untagged. */
  readonly tags: readonly string[]
  /** Every label with its value. */
  readonly labels: Readonly<Record<string, string>>
}

/** One image of an image list. */
export interface ImageListEntry {
  /** Its image ID, `sha256:<hex>`. */
  readonly id: string
  /** Its tags; none when it is untagged. */
  readonly tags: readonly string[]
  /** Its owner label's value (b.uqm SR-6.3); null when it carries no owner label. */
  readonly ownerLabel: string | null
}

/** One filter of an image list: `dangling=true`, `label=<key>` or `label=<key>=<value>`, or `reference=<pattern>`. */
export type ImageListFilter =
  | {
      readonly kind: 'dangling'
    }
  | {
      readonly kind: 'label'
      readonly key: string
      /** The exact value; null to match any value of the key. */
      readonly value: string | null
    }
  | {
      readonly kind: 'reference'
      readonly pattern: string
    }

/** The caller's check of a `docker run` argument list (b.uqm SR-10.4): pass, or refuse with a reason that holds no secret value. */
export type DockerRunListCheck = (argv: readonly string[]) => DockerRunListVerdict

/** What a `docker run` argument-list check answers. */
export type DockerRunListVerdict =
  | {
      readonly ok: true
    }
  | {
      readonly ok: false
      readonly reason: string
    }

/** A `docker run`'s outcome: started, refused by its check (neither logged nor spawned), or failed. */
export type ContainerRunOutcome =
  | {
      readonly kind: 'started'
      /** The new container's full ID. */
      readonly containerId: string
    }
  | {
      readonly kind: 'refused'
      readonly reason: string
    }
  | {
      readonly kind: 'failed'
      /** The exit status; null when nothing was spawned. */
      readonly exitCode: number | null
      readonly error: string
    }

/** The test-image build: a Dockerfile path, the worktree as context, labels and a run-private tag (b.uqm SR-9.3). */
export interface TestImageBuildSpec {
  readonly dockerfilePath: string
  readonly contextDir: string
  readonly labels: DockerLabels
  readonly tag: string
}

/** A derived-image build (drift or retag, b.uqm SR-14.2): its Dockerfile on standard input starts from `from`, with labels and a run-private tag, and no build context. */
export interface DerivedImageBuildSpec {
  /** The image it starts from: a run-private tag, never an image ID (BuildKit does not accept `FROM sha256:<id>`). */
  readonly from: string
  readonly labels: DockerLabels
  readonly tag: string
}

/** How a build ended. */
export type ImageBuildResult =
  | {
      readonly kind: 'built'
      /** The image ID from the build's own output. */
      readonly imageId: string
    }
  | {
      /** Ended through its handle (b.uqm SR-5.6): no image build failure. */
      readonly kind: 'ended'
      readonly exitCode: number
    }
  | {
      readonly kind: 'failed'
      /** The exit status; null when nothing was spawned. */
      readonly exitCode: number | null
      /** Its last line of error output, or why it has no image ID, on one line. */
      readonly error: string
    }

/** A started build, in a process group of its own. */
export interface ImageBuild {
  /** Its PID; null when it could not be started. */
  readonly pid: number | null
  /** Its process group; null when it could not be started. */
  readonly processGroup: number | null
  /** Ends it: SIGKILL to its whole process group (b.uqm SR-5.6). Once the build has settled it signals nothing and answers `no-such-process`, so a reused group ID is never signalled. */
  end(): SignalOutcome
  /** Settles once it has ended; never rejects. */
  readonly result: Promise<ImageBuildResult>
}

/** An image prune's outcome: done, refused by Docker as already running (b.uqm SR-9.3, SR-23.6), or failed. */
export type ImagePruneOutcome =
  | {
      readonly kind: 'done'
    }
  | {
      readonly kind: 'already-running'
      readonly error: string
    }
  | {
      readonly kind: 'failed'
      /** The exit status; null when nothing was spawned. */
      readonly exitCode: number | null
      readonly error: string
    }

/** Stops a builder: an argument that cannot go into a docker argument list. */
function refuseDockerArgument(reason: string): never {
  throw new Error(reason)
}

/** A positional operand: not empty, not read as an option, no control character. */
function dockerOperand(value: string, what: string): string {
  if (value === '') refuseDockerArgument(`${what} is empty`)
  if (value.startsWith('-')) refuseDockerArgument(`${what} begins with "-": ${JSON.stringify(value)}`)
  if (DOCKER_CONTROL_CHARACTER_PATTERN.test(value)) refuseDockerArgument(`${what} holds a control character`)
  return value
}

/** `--label <key>=<value>` for each label, in the order given. */
function dockerLabelArguments(labels: DockerLabels): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(labels)) {
    if (!DOCKER_LABEL_KEY_PATTERN.test(key)) refuseDockerArgument(`not a label key: ${JSON.stringify(key)}`)
    if (DOCKER_CONTROL_CHARACTER_PATTERN.test(value)) refuseDockerArgument(`label ${key}'s value holds a control character`)
    args.push('--label', `${key}=${value}`)
  }
  return args
}

/** Whether `tag` is a run-private tag, `cscb-ci-run:<RUN_ID>-<PID>-<role>`, role being `test`, `drift` or `retag` (b.uqm SR-9.3), by the one rule `parseRunTag` holds. An image ID, a digest or any other tag is not. */
export function isRunPrivateTag(tag: string): boolean {
  return parseRunTag(tag) !== null
}

/** A run-private tag, or a refusal. */
function runPrivateTagOperand(tag: string): string {
  if (!isRunPrivateTag(tag)) refuseDockerArgument(`not a run-private tag ${RUN_TAG_REPOSITORY}:<RUN_ID>-<PID>-<role>: ${JSON.stringify(tag)}`)
  return tag
}

/** An image ID, or a refusal. */
function imageIdOperand(imageId: string): string {
  if (!IMAGE_ID_PATTERN.test(imageId)) refuseDockerArgument(`not an image ID: ${JSON.stringify(imageId)}`)
  return imageId
}

/** An argument list from its builder, or the failure its refusal makes (nothing spawned). */
function dockerArguments(build: () => string[]): DockerAnswer<string[]> {
  try {
    return { ok: true, value: build() }
  } catch (err) {
    return { ok: false, exitCode: null, error: dependencyErrorText(err) }
  }
}

/** Text on one line. */
function dockerOneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/** Bytes as text. */
function dockerText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** The operation an argument list names, for an error: the words before its first option, at most three (`docker container inspect`). */
function dockerOperationName(argv: readonly string[]): string {
  const firstOption = argv.findIndex((arg, index) => index > 0 && arg.startsWith('-'))
  return argv.slice(0, Math.min(firstOption === -1 ? argv.length : firstOption, 3)).join(' ')
}

/** The failure of a command that exited non-zero: its standard error on one line. */
function dockerExitFailure(argv: readonly string[], result: SpawnResult): DockerFailure {
  const error = dockerOneLine(result.stderr)
  return {
    ok: false,
    exitCode: result.exitCode,
    error: error !== '' ? error : `${dockerOperationName(argv)} exited ${result.exitCode} with no error output`,
  }
}

/** The failure of a command whose answer cannot be used. */
function dockerAnswerFailure(argv: readonly string[], exitCode: number, why: string): DockerFailure {
  return { ok: false, exitCode, error: `${dockerOperationName(argv)}: ${why}` }
}

/** What a docker command needs beyond its argument list. */
interface DockerSpawnOptions {
  readonly stdin?: string
  readonly onOutputLine?: (line: string) => void
  readonly ownProcessGroup?: boolean
}

/** A child that never started, with why. */
function dockerNotStarted(why: string): SpawnedChild {
  return {
    pid: null,
    processGroup: null,
    result: Promise.resolve({ exitCode: SPAWN_FAILED_EXIT_STATUS, stdout: new Uint8Array(0), stderr: why }),
  }
}

/** Starts one docker command through the given spawn, with the given environment; a spawn that throws is a child that never started. */
function startDocker(docker: DockerContext, argv: readonly string[], options: DockerSpawnOptions = {}): SpawnedChild {
  const request: SpawnRequest = {
    argv,
    env: docker.env,
    cwd: docker.cwd,
    ownProcessGroup: options.ownProcessGroup === true,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.onOutputLine === undefined ? {} : { onOutputLine: options.onOutputLine }),
  }
  try {
    return docker.spawn(request)
  } catch (err) {
    return dockerNotStarted(`could not start ${DOCKER_PROGRAM}: ${dependencyErrorText(err)}`)
  }
}

/** A child's result that never rejects. */
function settleDocker(result: Promise<SpawnResult>): Promise<SpawnResult> {
  return result.catch((err: unknown) => ({
    exitCode: SPAWN_FAILED_EXIT_STATUS,
    stdout: new Uint8Array(0),
    stderr: `${DOCKER_PROGRAM} command failed: ${dependencyErrorText(err)}`,
  }))
}

/** Runs one docker command to its end. */
function runDocker(docker: DockerContext, argv: readonly string[], options: DockerSpawnOptions = {}): Promise<SpawnResult> {
  return settleDocker(startDocker(docker, argv, options).result)
}

/** A command's standard output as its non-empty lines, trimmed, each once, in order. */
function dockerOutputLines(stdout: Uint8Array): string[] {
  const seen = new Set<string>()
  for (const line of dockerText(stdout).split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') seen.add(trimmed)
  }
  return [...seen]
}

/** Whether every line of a failed command's standard error says that what it named does not exist. */
function onlyNotFoundErrors(stderr: string, notFoundText: string): boolean {
  const lines = stderr.split('\n').filter((line) => line.trim() !== '')
  return lines.length > 0 && lines.every((line) => line.includes(notFoundText))
}

/** A JSON object's fields. */
type DockerJsonObject = Readonly<Record<string, unknown>>

function isDockerJsonObject(value: unknown): value is DockerJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One JSON value per non-empty line of standard output, each parsed; null when a line is not JSON or does not parse. */
function parseDockerJsonLines<T>(stdout: Uint8Array, parse: (value: unknown) => T | null): T[] | null {
  const parsed: T[] = []
  for (const line of dockerText(stdout).split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return null
    }
    const item = parse(value)
    if (item === null) return null
    parsed.push(item)
  }
  return parsed
}

/** Labels as Docker gives them: an object of strings, or null for none. */
function parseDockerLabels(value: unknown): Record<string, string> | null {
  if (value === null) return {}
  if (!isDockerJsonObject(value)) return null
  const labels: Record<string, string> = {}
  for (const [key, labelValue] of Object.entries(value)) {
    if (typeof labelValue !== 'string') return null
    labels[key] = labelValue
  }
  return labels
}

function isDockerWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** A container name without Docker's leading `/`. */
function dockerContainerName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name
}

function parseContainerState(value: unknown): ContainerState | null {
  if (!isDockerJsonObject(value)) return null
  const { id, name, status, running, pid, oomKilled, exitCode, memoryBytes } = value
  const labels = parseDockerLabels(value.labels)
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || typeof status !== 'string') return null
  if (typeof running !== 'boolean' || typeof oomKilled !== 'boolean' || labels === null) return null
  if (!isDockerWholeNumber(pid) || pid < 0 || !isDockerWholeNumber(exitCode) || !isDockerWholeNumber(memoryBytes) || memoryBytes < 0) return null
  return {
    id,
    name: dockerContainerName(name),
    status,
    running,
    pid,
    oomKilled,
    exitCode,
    memoryCapBytes: memoryBytes === 0 ? null : memoryBytes,
    labels,
  }
}

function parseInspectionMount(value: unknown): ShardMount | null {
  if (!isDockerJsonObject(value)) return null
  const { source, target, rw } = value
  if (typeof source !== 'string' || typeof target !== 'string' || typeof rw !== 'boolean') return null
  return { source, target, readOnly: !rw }
}

function parseInspectionData(value: unknown): InspectionData | null {
  if (!isDockerJsonObject(value)) return null
  const { name, imageId, networkMode, pidMode, ipcMode, privileged, memoryBytes, memorySwapBytes, pidsLimit, nanoCpus, autoRemove } = value
  const labels = parseDockerLabels(value.labels)
  if (!Array.isArray(value.mounts)) return null
  const mounts: ShardMount[] = []
  for (const entry of value.mounts) {
    const mount = parseInspectionMount(entry)
    if (mount === null) return null
    mounts.push(mount)
  }
  if (typeof name !== 'string' || typeof imageId !== 'string' || labels === null) return null
  if (typeof networkMode !== 'string' || typeof pidMode !== 'string' || typeof ipcMode !== 'string') return null
  if (typeof privileged !== 'boolean' || typeof autoRemove !== 'boolean') return null
  if (!isDockerWholeNumber(memoryBytes) || !isDockerWholeNumber(memorySwapBytes) || !isDockerWholeNumber(nanoCpus)) return null
  if (pidsLimit !== null && !isDockerWholeNumber(pidsLimit)) return null
  return {
    name: dockerContainerName(name),
    imageId,
    mounts,
    networkMode,
    pidMode,
    ipcMode,
    privileged,
    memoryBytes,
    memorySwapBytes,
    pidsLimit,
    nanoCpus,
    labels,
    autoRemove,
  }
}

function parseImageRecord(value: unknown): ImageRecord | null {
  if (!isDockerJsonObject(value)) return null
  const { id, tags } = value
  const labels = parseDockerLabels(value.labels)
  if (typeof id !== 'string' || id === '' || labels === null) return null
  if (tags !== null && !(Array.isArray(tags) && tags.every((tag) => typeof tag === 'string'))) return null
  return { id, tags: ((tags ?? []) as string[]).filter((tag) => tag !== DOCKER_UNTAGGED_PLACEHOLDER), labels }
}

/** Objects read by one inspect over several names or IDs: those found, and the names or IDs that no longer exist. */
interface DockerInspectRead<T> {
  readonly found: readonly T[]
  readonly missing: readonly string[]
}

/**
 * One inspect over `refs`, its answer parsed. A non-zero exit whose every
 * error line says that what it named does not exist is no failure: those
 * names or IDs are missing (gone since a listing, say), and the rest are found.
 */
async function readDockerInspect<T>(
  docker: DockerContext,
  argv: readonly string[],
  refs: readonly string[],
  notFoundText: string,
  parse: (value: unknown) => T | null,
  matches: (item: T, ref: string) => boolean,
): Promise<DockerAnswer<DockerInspectRead<T>>> {
  const result = await runDocker(docker, argv)
  if (result.exitCode !== 0 && !onlyNotFoundErrors(result.stderr, notFoundText)) return dockerExitFailure(argv, result)
  const found = parseDockerJsonLines(result.stdout, parse)
  if (found === null) return dockerAnswerFailure(argv, result.exitCode, 'its answer could not be parsed')
  const missing = result.exitCode === 0 ? [] : refs.filter((ref) => !found.some((item) => matches(item, ref)))
  return { ok: true, value: { found, missing } }
}

/** One object from an inspect of one name or ID: it, null when it does not exist, or a failure. */
function oneInspected<T>(argv: readonly string[], read: DockerAnswer<DockerInspectRead<T>>): DockerAnswer<T | null> {
  if (!read.ok) return read
  const [first, ...others] = read.value.found
  if (first !== undefined && others.length === 0) return { ok: true, value: first }
  if (first === undefined && read.value.missing.length > 0) return { ok: true, value: null }
  return dockerAnswerFailure(argv, 0, `it answered ${read.value.found.length} objects for one name`)
}

function containerMatches(state: ContainerState, ref: string): boolean {
  return state.id === ref || state.name === ref || state.id.startsWith(ref)
}

function imageMatches(image: ImageRecord, ref: string): boolean {
  return image.id === ref || image.tags.includes(ref)
}

// Containers (b.uqm SR-6.4, SR-6.5, SR-7.3, SR-9.4, SR-10.5, SR-10.6, SR-13.2).

/** `docker version --format {{.Server.Version}}`: whether docker answers. */
export function dockerAnswersArgs(): string[] {
  return [DOCKER_PROGRAM, 'version', '--format', '{{.Server.Version}}']
}

/** Whether docker answers: the daemon's version, or a failure. */
export async function checkDockerAnswers(docker: DockerContext): Promise<DockerAnswer<string>> {
  const argv = dockerAnswersArgs()
  const result = await runDocker(docker, argv)
  if (result.exitCode !== 0) return dockerExitFailure(argv, result)
  const version = dockerOneLine(dockerText(result.stdout))
  if (version === '') return dockerAnswerFailure(argv, result.exitCode, 'the daemon gave no version')
  return { ok: true, value: version }
}

/** `docker container ls --all --no-trunc --quiet`: every container's full ID, stopped ones included. */
export function containerListArgs(): string[] {
  return [DOCKER_PROGRAM, 'container', 'ls', '--all', '--no-trunc', '--quiet']
}

/** `docker container inspect --format <CONTAINER_STATE_FORMAT> <container>...`: the state form. */
export function containerStateInspectArgs(containers: readonly string[]): string[] {
  if (containers.length === 0) refuseDockerArgument('no container to inspect')
  return [DOCKER_PROGRAM, 'container', 'inspect', '--format', CONTAINER_STATE_FORMAT, ...containers.map((c) => dockerOperand(c, 'container'))]
}

/**
 * Every container, stopped ones included, in the state form: its ID, name,
 * status, `State.Pid`, `State.OOMKilled`, exit code, memory cap and every
 * label with its value. The list, then one state-form inspect of every ID it
 * gave; a container removed between the two is left out. No container: empty.
 */
export async function listContainers(docker: DockerContext): Promise<DockerAnswer<readonly ContainerState[]>> {
  const listArgv = containerListArgs()
  const listed = await runDocker(docker, listArgv)
  if (listed.exitCode !== 0) return dockerExitFailure(listArgv, listed)
  const ids = dockerOutputLines(listed.stdout)
  if (ids.length === 0) return { ok: true, value: [] }
  const argv = dockerArguments(() => containerStateInspectArgs(ids))
  if (!argv.ok) return argv
  const read = await readDockerInspect(docker, argv.value, ids, DOCKER_NO_SUCH_CONTAINER_TEXT, parseContainerState, containerMatches)
  if (!read.ok) return read
  return { ok: true, value: read.value.found }
}

/** One container in the state form; null when it does not exist. */
export async function inspectContainerState(docker: DockerContext, container: string): Promise<DockerAnswer<ContainerState | null>> {
  const argv = dockerArguments(() => containerStateInspectArgs([container]))
  if (!argv.ok) return argv
  const read = await readDockerInspect(docker, argv.value, [container], DOCKER_NO_SUCH_CONTAINER_TEXT, parseContainerState, containerMatches)
  return oneInspected(argv.value, read)
}

/** `docker container inspect --format <CONTAINER_INSPECTION_FORMAT> <container>`: the inspection form (b.uqm SR-10.5). */
export function containerInspectionArgs(container: string): string[] {
  return [DOCKER_PROGRAM, 'container', 'inspect', '--format', CONTAINER_INSPECTION_FORMAT, dockerOperand(container, 'container')]
}

/** A shard container's inspection data: b.uqm SR-10.5's fields only, never its environment. A container that does not exist is a failure. */
export async function readContainerInspection(docker: DockerContext, container: string): Promise<DockerAnswer<InspectionData>> {
  const argv = dockerArguments(() => containerInspectionArgs(container))
  if (!argv.ok) return argv
  const result = await runDocker(docker, argv.value)
  if (result.exitCode !== 0) return dockerExitFailure(argv.value, result)
  const parsed = parseDockerJsonLines(result.stdout, parseInspectionData)
  if (parsed === null) return dockerAnswerFailure(argv.value, result.exitCode, 'its answer could not be parsed')
  const [data, ...others] = parsed
  if (data === undefined || others.length > 0) return dockerAnswerFailure(argv.value, result.exitCode, `it answered ${parsed.length} objects for one container`)
  return { ok: true, value: data }
}

/** `docker container create --pull never --name <name> [--label <key>=<value>]... <image>`: a container that is never started (b.uqm SR-9.4). */
export function containerCreateArgs(name: string, labels: DockerLabels, image: string): string[] {
  return [
    DOCKER_PROGRAM,
    'container',
    'create',
    '--pull',
    'never',
    '--name',
    dockerOperand(name, 'container name'),
    ...dockerLabelArguments(labels),
    dockerOperand(image, 'image'),
  ]
}

/** Creates a container from an image, with a name and labels, and never starts it: its full ID, or a failure. */
export async function createContainer(docker: DockerContext, name: string, labels: DockerLabels, image: string): Promise<DockerAnswer<string>> {
  const argv = dockerArguments(() => containerCreateArgs(name, labels, image))
  if (!argv.ok) return argv
  const result = await runDocker(docker, argv.value)
  if (result.exitCode !== 0) return dockerExitFailure(argv.value, result)
  const id = dockerOutputLines(result.stdout).at(-1)
  if (id === undefined || !CONTAINER_ID_PATTERN.test(id)) return dockerAnswerFailure(argv.value, result.exitCode, 'it gave no container ID')
  return { ok: true, value: id }
}

/** `docker container cp <container>:<path> -`: a path copied out as a tar archive on standard output. */
export function containerCopyOutArgs(container: string, path: string): string[] {
  if (!path.startsWith('/')) refuseDockerArgument(`not an absolute path in the container: ${JSON.stringify(path)}`)
  return [DOCKER_PROGRAM, 'container', 'cp', `${dockerOperand(container, 'container')}:${dockerOperand(path, 'path')}`, '-']
}

/** A path copied out of a container: the tar archive's bytes, written nowhere, or a failure. */
export async function copyOutOfContainer(docker: DockerContext, container: string, path: string): Promise<DockerAnswer<Uint8Array>> {
  const argv = dockerArguments(() => containerCopyOutArgs(container, path))
  if (!argv.ok) return argv
  const result = await runDocker(docker, argv.value)
  if (result.exitCode !== 0) return dockerExitFailure(argv.value, result)
  if (result.stdout.length === 0) return dockerAnswerFailure(argv.value, result.exitCode, 'it gave no archive')
  return { ok: true, value: result.stdout }
}

/** `docker container kill --signal <signal> <container>`. */
export function containerKillArgs(container: string, signal: SentSignal): string[] {
  if (signal !== 'SIGKILL' && signal !== 'SIGTERM') refuseDockerArgument(`not a signal the runner sends: ${JSON.stringify(signal)}`)
  return [DOCKER_PROGRAM, 'container', 'kill', '--signal', signal, dockerOperand(container, 'container')]
}

/** Sends a signal to a container's main process (SIGKILL at a stop, b.uqm SR-10.6). */
export async function killContainer(docker: DockerContext, container: string, signal: SentSignal): Promise<DockerAnswer<null>> {
  const argv = dockerArguments(() => containerKillArgs(container, signal))
  if (!argv.ok) return argv
  const result = await runDocker(docker, argv.value)
  if (result.exitCode !== 0) return dockerExitFailure(argv.value, result)
  return { ok: true, value: null }
}

/** `docker container logs <container>`. */
export function containerLogsArgs(container: string): string[] {
  return [DOCKER_PROGRAM, 'container', 'logs', dockerOperand(container, 'container')]
}

/** A container's combined Docker logs: its standard output's log, then its standard error's. */
export async function readContainerLogs(docker: DockerContext, container: string): Promise<DockerAnswer<string>> {
  const argv = dockerArguments(() => containerLogsArgs(container))
  if (!argv.ok) return argv
  const result = await runDocker(docker, argv.value)
  if (result.exitCode !== 0) return dockerExitFailure(argv.value, result)
  const out = dockerText(result.stdout)
  const separator = out !== '' && !out.endsWith('\n') && result.stderr !== '' ? '\n' : ''
  return { ok: true, value: `${out}${separator}${result.stderr}` }
}

/** `docker container rm <container>`: never forced. */
export function containerRemoveArgs(container: string): string[] {
  return [DOCKER_PROGRAM, 'container', 'rm', dockerOperand(container, 'container')]
}

/** Removes a container that is not running. */
export async function removeContainer(docker: DockerContext, container: string): Promise<DockerAnswer<null>> {
  const argv = dockerArguments(() => containerRemoveArgs(container))
  if (!argv.ok) return argv
  const result = await runDocker(docker, argv.value)
  if (result.exitCode !== 0) return dockerExitFailure(argv.value, result)
  return { ok: true, value: null }
}

// docker run (b.uqm SR-10.4, SR-15.2).

/** `docker run --detach <the caller's arguments>...`: the caller owns its options, image and command. */
export function containerRunArgs(runArguments: readonly string[]): string[] {
  return [DOCKER_PROGRAM, 'run', '--detach', ...runArguments]
}

/** The runner-log line of a `docker run` argument list: the prefix, then the list as JSON, so it reads back as exactly the list spawned. */
export function dockerRunLogLine(argv: readonly string[]): string {
  return `${DOCKER_RUN_LOG_PREFIX}${JSON.stringify(argv)}`
}

/**
 * Starts a detached container: checks the argument list with the caller's
 * check, then writes it to the runner log as one line, then spawns it. A
 * refused list (or a check that throws) is neither logged nor spawned, and the
 * refusal is returned. A list the log cannot take is not spawned: `log` must
 * throw when it cannot append the line. The real writer never throws (a failed
 * append goes to its `onAppendError`), so E13 wires `createRunnerLog`'s
 * `onAppendError` so the sink passed here rethrows. A logged list stays logged
 * when its spawn fails.
 */
export async function runContainer(
  docker: DockerContext,
  runArguments: readonly string[],
  check: DockerRunListCheck,
  log: RunnerLogSink,
): Promise<ContainerRunOutcome> {
  const argv = containerRunArgs(runArguments)
  let verdict: DockerRunListVerdict
  try {
    verdict = check([...argv])
  } catch (err) {
    return { kind: 'refused', reason: `the argument-list check failed: ${dependencyErrorText(err)}` }
  }
  if (!verdict.ok) return { kind: 'refused', reason: verdict.reason }
  try {
    log(dockerRunLogLine(argv))
  } catch (err) {
    return { kind: 'failed', exitCode: null, error: `the docker run argument list could not be written to the runner log: ${dependencyErrorText(err)}` }
  }
  const result = await runDocker(docker, argv)
  if (result.exitCode !== 0) {
    const failure = dockerExitFailure(argv, result)
    return { kind: 'failed', exitCode: failure.exitCode, error: failure.error }
  }
  const id = dockerOutputLines(result.stdout).at(-1)
  if (id === undefined || !CONTAINER_ID_PATTERN.test(id)) return { kind: 'failed', exitCode: result.exitCode, error: `${dockerOperationName(argv)}: it gave no container ID` }
  return { kind: 'started', containerId: id }
}

// Images (b.uqm SR-5.6, SR-6.4, SR-9.2, SR-9.3, SR-14.2, SR-23.6).

/** `docker image inspect --format <IMAGE_INSPECT_FORMAT> <image>...`: the image inspect form. */
export function imageInspectArgs(images: readonly string[]): string[] {
  if (images.length === 0) refuseDockerArgument('no image to inspect')
  return [DOCKER_PROGRAM, 'image', 'inspect', '--format', IMAGE_INSPECT_FORMAT, ...images.map((image) => dockerOperand(image, 'image'))]
}

/** One image by name or ID: present (its ID, tags and labels), null when missing, or a failure. */
export async function inspectImage(docker: DockerContext, image: string): Promise<DockerAnswer<ImageRecord | null>> {
  const argv = dockerArguments(() => imageInspectArgs([image]))
  if (!argv.ok) return argv
  const read = await readDockerInspect(docker, argv.value, [image], DOCKER_NO_SUCH_IMAGE_TEXT, parseImageRecord, imageMatches)
  return oneInspected(argv.value, read)
}

/** One image-list filter's text. */
function imageListFilterText(filter: ImageListFilter): string {
  switch (filter.kind) {
    case 'dangling':
      return 'dangling=true'
    case 'label': {
      if (!DOCKER_LABEL_KEY_PATTERN.test(filter.key)) refuseDockerArgument(`not a label key: ${JSON.stringify(filter.key)}`)
      if (filter.value === null) return `label=${filter.key}`
      if (filter.value === '' || DOCKER_CONTROL_CHARACTER_PATTERN.test(filter.value)) refuseDockerArgument(`not a label value to filter on: ${JSON.stringify(filter.value)}`)
      return `label=${filter.key}=${filter.value}`
    }
    case 'reference':
      return `reference=${dockerOperand(filter.pattern, 'reference pattern')}`
  }
}

/** `docker image ls --no-trunc --quiet [--filter <filter>]...`: the full IDs of the images that pass every filter. */
export function imageListArgs(filters: readonly ImageListFilter[]): string[] {
  const argv = [DOCKER_PROGRAM, 'image', 'ls', '--no-trunc', '--quiet']
  for (const filter of filters) argv.push('--filter', imageListFilterText(filter))
  return argv
}

/**
 * The images that pass every filter, each with its ID, its tags (none when
 * untagged) and its owner label's value (null when it has none). The list
 * gives only IDs, so one image-inspect-form read of those IDs adds the tags
 * and labels; an image removed between the two is left out. None: empty.
 */
export async function listImages(docker: DockerContext, filters: readonly ImageListFilter[]): Promise<DockerAnswer<readonly ImageListEntry[]>> {
  const listArgv = dockerArguments(() => imageListArgs(filters))
  if (!listArgv.ok) return listArgv
  const listed = await runDocker(docker, listArgv.value)
  if (listed.exitCode !== 0) return dockerExitFailure(listArgv.value, listed)
  const ids = dockerOutputLines(listed.stdout)
  if (ids.length === 0) return { ok: true, value: [] }
  const argv = dockerArguments(() => imageInspectArgs(ids))
  if (!argv.ok) return argv
  const read = await readDockerInspect(docker, argv.value, ids, DOCKER_NO_SUCH_IMAGE_TEXT, parseImageRecord, imageMatches)
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.found.map((image) => ({ id: image.id, tags: image.tags, ownerLabel: image.labels[OWNER_LABEL] ?? null })),
  }
}

/** `docker image rm <run-private tag>`: one tag removed by its name; never an ID or a digest, never forced. Refuses any other argument. */
export function imageTagRemovalArgs(tag: string): string[] {
  return [DOCKER_PROGRAM, 'image', 'rm', runPrivateTagOperand(tag)]
}

/** Removes one run-private tag by its name; Docker deletes the image with its last tag when no container uses it (b.uqm SR-23.6). Any other argument is refused (exit status null), nothing spawned. */
export async function removeImageTag(docker: DockerContext, tag: string): Promise<DockerAnswer<null>> {
  const argv = dockerArguments(() => imageTagRemovalArgs(tag))
  if (!argv.ok) return argv
  const result = await runDocker(docker, argv.value)
  if (result.exitCode !== 0) return dockerExitFailure(argv.value, result)
  return { ok: true, value: null }
}

/** `docker image tag <image ID> <run-private tag>`. */
export function imageTagArgs(imageId: string, tag: string): string[] {
  return [DOCKER_PROGRAM, 'image', 'tag', imageIdOperand(imageId), runPrivateTagOperand(tag)]
}

/** Points a run-private tag at an image ID, moving it off any image it named (the `retag` fault, b.uqm SR-14.2). */
export async function tagImage(docker: DockerContext, imageId: string, tag: string): Promise<DockerAnswer<null>> {
  const argv = dockerArguments(() => imageTagArgs(imageId, tag))
  if (!argv.ok) return argv
  const result = await runDocker(docker, argv.value)
  if (result.exitCode !== 0) return dockerExitFailure(argv.value, result)
  return { ok: true, value: null }
}

/** `docker build --progress=plain --file <Dockerfile> [--label <key>=<value>]... --tag <run-private tag> <context>`: the test-image build. */
export function testImageBuildArgs(spec: TestImageBuildSpec): string[] {
  return [
    DOCKER_PROGRAM,
    'build',
    BUILD_PROGRESS_OPTION,
    '--file',
    dockerOperand(spec.dockerfilePath, 'Dockerfile path'),
    ...dockerLabelArguments(spec.labels),
    '--tag',
    runPrivateTagOperand(spec.tag),
    dockerOperand(spec.contextDir, 'build context'),
  ]
}

/** `docker build --progress=plain [--label <key>=<value>]... --tag <run-private tag> -`: a derived-image build, its Dockerfile on standard input and no build context. */
export function derivedImageBuildArgs(spec: DerivedImageBuildSpec): string[] {
  return [DOCKER_PROGRAM, 'build', BUILD_PROGRESS_OPTION, ...dockerLabelArguments(spec.labels), '--tag', runPrivateTagOperand(spec.tag), '-']
}

/**
 * A derived-image build's Dockerfile, written to its standard input:
 * `FROM <from>`, `from` being a run-private tag. An image ID (or anything
 * else) is refused and nothing is spawned: BuildKit does not accept
 * `FROM sha256:<id>` (moby#39769, buildkit#2204). E8 builds the drift and
 * retag images FROM the run's `-test` tag, and reads that tag with
 * `inspectImage` before and after the build to verify it still names the
 * pinned image ID.
 */
export function derivedImageDockerfile(spec: DerivedImageBuildSpec): string {
  if (!isRunPrivateTag(spec.from)) {
    refuseDockerArgument(`not a run-private tag ${RUN_TAG_REPOSITORY}:<RUN_ID>-<PID>-<role> to build from: ${JSON.stringify(spec.from)}`)
  }
  return `FROM ${spec.from}\n`
}

/** The last image ID a build's output reports. */
function lastReportedImageId(text: string): string | null {
  let imageId: string | null = null
  for (const line of text.split('\n')) {
    const match = BUILD_IMAGE_ID_PATTERN.exec(line)
    if (match?.[1] !== undefined) imageId = match[1]
  }
  return imageId
}

/** A build that could not be started. */
function buildNotStarted(error: string): ImageBuild {
  return {
    pid: null,
    processGroup: null,
    end: () => 'no-such-process',
    result: Promise.resolve({ kind: 'failed', exitCode: null, error }),
  }
}

/**
 * Starts a build in a process group of its own. Each output line goes to the
 * log as it arrives (a log that throws loses only that line); the image ID is
 * the last one the build's own output reports. `end()` sends SIGKILL to the
 * whole group; a build that then exits without its image is `ended`. Once the
 * build has settled, `end()` sends nothing and answers `no-such-process`.
 */
function startImageBuild(
  docker: DockerContext,
  sendSignal: DockerSignalSender,
  build: () => { readonly argv: string[]; readonly stdin?: string },
  log: RunnerLogSink,
): ImageBuild {
  let request: { readonly argv: string[]; readonly stdin?: string }
  try {
    request = build()
  } catch (err) {
    return buildNotStarted(dependencyErrorText(err))
  }
  const { argv } = request
  let reportedId: string | null = null
  let ended = false
  const onOutputLine = (line: string): void => {
    const match = BUILD_IMAGE_ID_PATTERN.exec(line)
    if (match?.[1] !== undefined) reportedId = match[1]
    try {
      log(line)
    } catch {
      // The log's own failure loses this line only; the build goes on.
    }
  }
  const child = startDocker(docker, argv, {
    ownProcessGroup: true,
    onOutputLine,
    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
  })
  const processGroup = child.processGroup
  // Once the build has ended its group ID may name another process's group,
  // so `end()` signals nothing from then on.
  let settled = false
  const end = (): SignalOutcome => {
    if (settled) return 'no-such-process'
    ended = true
    return processGroup === null ? 'no-such-process' : sendSignal({ kind: 'group', processGroup }, 'SIGKILL')
  }
  const result = settleDocker(child.result).then((done): ImageBuildResult => {
    settled = true
    const imageId = reportedId ?? lastReportedImageId(`${dockerText(done.stdout)}\n${done.stderr}`)
    if (done.exitCode === 0 && imageId !== null) return { kind: 'built', imageId }
    if (ended) return { kind: 'ended', exitCode: done.exitCode }
    if (done.exitCode === 0) return { kind: 'failed', exitCode: 0, error: `${dockerOperationName(argv)}: its output reported no image ID` }
    const lastLine = done.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .at(-1)
    return { kind: 'failed', exitCode: done.exitCode, error: lastLine ?? `${dockerOperationName(argv)} exited ${done.exitCode} with no error output` }
  })
  return { pid: child.pid, processGroup, end, result }
}

/** Starts the test-image build from a Dockerfile with the worktree as context (b.uqm SR-9.3), its output lines to the runner log. */
export function startTestImageBuild(docker: DockerContext, sendSignal: DockerSignalSender, spec: TestImageBuildSpec, log: RunnerLogSink): ImageBuild {
  return startImageBuild(docker, sendSignal, () => ({ argv: testImageBuildArgs(spec) }), log)
}

/** Starts a derived-image build (drift or retag, b.uqm SR-14.2): its Dockerfile on standard input, no build context, its output lines to the runner log. */
export function startDerivedImageBuild(docker: DockerContext, sendSignal: DockerSignalSender, spec: DerivedImageBuildSpec, log: RunnerLogSink): ImageBuild {
  return startImageBuild(docker, sendSignal, () => ({ argv: derivedImageBuildArgs(spec), stdin: derivedImageDockerfile(spec) }), log)
}

/** `docker image prune --force --filter label=cscb-ci-owner=<owner>`: untagged images only (no `--all`), filtered on exactly one owner label. `--force` only skips the prompt. */
export function imagePruneArgs(owner: string): string[] {
  if (owner === '' || DOCKER_CONTROL_CHARACTER_PATTERN.test(owner)) refuseDockerArgument(`not an owner label value to prune on: ${JSON.stringify(owner)}`)
  return [DOCKER_PROGRAM, 'image', 'prune', '--force', '--filter', `label=${OWNER_LABEL}=${owner}`]
}

/** One prune of the untagged images that carry exactly this owner label and that no container uses. One try: retries belong to the caller (b.uqm SR-9.3). */
export async function pruneUntaggedImages(docker: DockerContext, owner: string): Promise<ImagePruneOutcome> {
  const argv = dockerArguments(() => imagePruneArgs(owner))
  if (!argv.ok) return { kind: 'failed', exitCode: null, error: argv.error }
  const result = await runDocker(docker, argv.value)
  if (result.exitCode === 0) return { kind: 'done' }
  const failure = dockerExitFailure(argv.value, result)
  if (result.stderr.includes(PRUNE_ALREADY_RUNNING_TEXT)) return { kind: 'already-running', error: failure.error }
  return { kind: 'failed', exitCode: failure.exitCode, error: failure.error }
}

// ---------------------------------------------------------------------------
// 7. Validation (E2)
// ---------------------------------------------------------------------------

// --- 7/T1 (E2 T1): discovery and selection ---
//
// Validation stages 2 to 5 (b.uqm SR-2.3, SR-2.6) and the run's scripts
// (b.uqm Terms). One reader, `readIntegrationEntries`, lists the worktree's
// `tests/integration`; every check after it is pure and takes an entry list,
// so E8 can feed the pinned image's listing to the same rules. Each check
// returns its stage's failures already in that stage's detail-line order
// (b.uqm SR-2.6): the stage driver (T3) makes the first one the refusal's
// reason and each other one a detail line. Every reason comes from an
// exported builder and shows names through `shownArgument`, so none holds a
// line break.

// E2 T1's worktree reader: entry kinds by lstat, never following a link.
import { lstatSync, readdirSync } from 'node:fs'

/** The `test-*.sh` glob's fixed head and tail (b.uqm Terms). */
const SCRIPT_GLOB_PREFIX = 'test-'
const SCRIPT_GLOB_SUFFIX = '.sh'

/** The glob as reasons show it, `test-*.sh`. */
const SCRIPT_GLOB_TEXT = `${SCRIPT_GLOB_PREFIX}*${SCRIPT_GLOB_SUFFIX}`

/** The naming rule as reasons state it (b.uqm SR-2.2, SR-2.3). */
const SCRIPT_NAME_RULE_TEXT =
  'a script is named test-<n>-<slug>.sh, n a whole number (0 included, no leading zero) and slug one or more lowercase letters, digits and hyphens'

/** test-1's number: every shard runs test-1 first (b.uqm SR-2.3, SR-3.3). */
const FIRST_SCRIPT_NUMBER = 1

/** Whether an entry name matches the `test-*.sh` glob: `test-`, then any text (none included), then `.sh`. */
export function matchesScriptGlob(name: string): boolean {
  return (
    name.length >= SCRIPT_GLOB_PREFIX.length + SCRIPT_GLOB_SUFFIX.length &&
    name.startsWith(SCRIPT_GLOB_PREFIX) &&
    name.endsWith(SCRIPT_GLOB_SUFFIX)
  )
}

/** Compares two names by their UTF-8 bytes: the order of stage 2's failures and of the reader's entries (b.uqm SR-2.6). */
export function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

// The reader (b.uqm SR-2.3): the one filesystem read of discovery.

/** A `tests/integration` entry's kind, judged on the entry itself: a symbolic link is a link whatever its target, and is never followed (b.uqm SR-2.3). */
export type IntegrationEntryKind = 'regular' | 'symlink' | 'directory' | 'other'

/** One `tests/integration` entry whose name matches `test-*.sh` (b.uqm SR-2.3). The checks below take lists of these. */
export interface IntegrationEntry {
  /** Its name, decoded as UTF-8. */
  readonly name: string
  readonly kind: IntegrationEntryKind
}

/** The error of a worktree whose `tests/integration` could not be listed, naming the directory. */
export function integrationReadFailedText(dirPath: string, error: string): string {
  return `reading the scripts in ${shownArgument(dirPath)} failed: ${error}`
}

/**
 * Lists the worktree's `tests/integration` afresh (b.uqm SR-2.3): every entry
 * whose name matches `test-*.sh`, with its kind from `lstat`, so a symbolic
 * link shows as a link, dangling or not. Entries come in bytewise name order.
 * Names are read as bytes, so an entry whose name is not valid UTF-8 is still
 * judged by its own `lstat` (and then refused by its name). Nothing is cached:
 * every call reads the directory again. A failure to list the directory or to
 * judge an entry fails the whole read, with `integrationReadFailedText`.
 * Callers pass `RunnerDeps.worktreeRoot`.
 */
export function readIntegrationEntries(worktreeRoot: string): DepRead<readonly IntegrationEntry[]> {
  const dirPath = join(worktreeRoot, INTEGRATION_DIR_PATH)
  const dirPrefix = Buffer.from(`${dirPath}/`, 'utf8')
  try {
    const entries: IntegrationEntry[] = []
    for (const rawName of readdirSync(dirPath, { encoding: 'buffer' })) {
      const name = rawName.toString('utf8')
      if (!matchesScriptGlob(name)) continue
      const stats = lstatSync(Buffer.concat([dirPrefix, rawName]))
      const kind: IntegrationEntryKind = stats.isFile()
        ? 'regular'
        : stats.isSymbolicLink()
          ? 'symlink'
          : stats.isDirectory()
            ? 'directory'
            : 'other'
      entries.push({ name, kind })
    }
    return { ok: true, value: entries.sort((a, b) => compareBytewise(a.name, b.name)) }
  } catch (err) {
    return { ok: false, error: integrationReadFailedText(dirPath, dependencyErrorText(err)) }
  }
}

// Stage failures and their reasons (b.uqm SR-2.3, SR-2.6). Tests import
// every reason from these builders and never type it (b.uqm SR-21.4).

/** One failure of a validation stage (b.uqm SR-2.6): its reason, the refusal's text after `NOT RUN: `, on one line. */
export interface StageFailure {
  readonly reason: string
}

/** A stage-2 failure: an entry that is not a regular file, or a regular file that breaks the naming rule. */
export interface NameFailure extends StageFailure {
  /** The entry's name. */
  readonly name: string
}

/** A stage-3 failure: one number that two or more scripts hold. */
export interface DuplicateNumberFailure extends StageFailure {
  /** The number form they share. */
  readonly numberForm: string
  /** Every file with that number, in bytewise order. */
  readonly fileNames: readonly string[]
}

/** A stage-5 failure: a SCRIPT argument that matches no script. */
export interface SelectionFailure extends StageFailure {
  /** The SCRIPT argument as given. */
  readonly argument: string
  /** Its index among the SCRIPT arguments (`Invocation.scripts`); failures come in this, the argument order. */
  readonly scriptIndex: number
}

/** How a reason names each kind of entry that is not a regular file. */
const NOT_REGULAR_KIND_TEXT: Readonly<Record<Exclude<IntegrationEntryKind, 'regular'>, string>> = {
  symlink: 'a symbolic link',
  directory: 'a directory',
  other: 'a special file',
}

/** Names joined for a reason: `a and b`, `a, b and c`. */
function joinedNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** `test-9-x.sh in tests/integration is a symbolic link, not a regular file: ...` (b.uqm SR-2.3): an entry is never skipped silently. */
export function notRegularEntryReason(name: string, kind: Exclude<IntegrationEntryKind, 'regular'>): string {
  return `${shownArgument(name)} in ${INTEGRATION_DIR_PATH} is ${NOT_REGULAR_KIND_TEXT[kind]}, not a regular file: every ${SCRIPT_GLOB_TEXT} entry there must be a regular file, and none is skipped`
}

/** `test-05-x.sh in tests/integration breaks the naming rule: a script is named test-<n>-<slug>.sh, ...` (b.uqm SR-2.3). */
export function badScriptNameReason(name: string): string {
  return `${shownArgument(name)} in ${INTEGRATION_DIR_PATH} breaks the naming rule: ${SCRIPT_NAME_RULE_TEXT}`
}

/** `test-5-a.sh and test-5-b.sh in tests/integration are both test-5: no two scripts may share a number` (b.uqm SR-2.3), naming every file with the number. */
export function duplicateNumberReason(numberForm: string, fileNames: readonly string[]): string {
  const quantifier = fileNames.length === 2 ? 'both' : 'all'
  return `${joinedNames(fileNames.map(shownArgument))} in ${INTEGRATION_DIR_PATH} are ${quantifier} ${numberForm}: no two scripts may share a number`
}

/** `test-1 is missing: tests/integration has no script numbered 1, and every shard runs it first` (b.uqm SR-2.3). */
export function missingTest1Reason(): string {
  return `${numberFormOf(FIRST_SCRIPT_NUMBER)} is missing: ${INTEGRATION_DIR_PATH} has no script numbered ${FIRST_SCRIPT_NUMBER}, and every shard runs it first`
}

/** `test-999 matches no script: a SCRIPT is a script's number form, test-<n>, or its whole file name in tests/integration` (b.uqm SR-2.3). */
export function unmatchedScriptReason(argument: string): string {
  return `${shownArgument(argument)} matches no script: a SCRIPT is a script's number form, test-<n>, or its whole file name in ${INTEGRATION_DIR_PATH}`
}

// Stages 2 to 4 and the script list. Pure: each takes an entry list (only
// `test-*.sh` entries, as `readIntegrationEntries` gives them) in any order.

/** The entries that are scripts (regular files with valid names), in the list's order. */
function namedScripts(entries: readonly IntegrationEntry[]): Script[] {
  const scripts: Script[] = []
  for (const entry of entries) {
    if (entry.kind !== 'regular') continue
    const number = fileNameNumber(entry.name)
    const numberForm = fileNameNumberForm(entry.name)
    if (number === null || numberForm === null) continue
    scripts.push({ fileName: entry.name, number, numberForm })
  }
  return scripts
}

/** A new list of the scripts in canonical order (b.uqm SR-3.3). */
function sortScriptsCanonical(scripts: readonly Script[]): Script[] {
  return [...scripts].sort((a, b) => compareCanonicalNumbers(a.number, b.number))
}

/** A new list of the entries in bytewise name order. */
function sortEntriesBytewise(entries: readonly IntegrationEntry[]): IntegrationEntry[] {
  return [...entries].sort((a, b) => compareBytewise(a.name, b.name))
}

/** Compares two number forms by their numbers, read exactly from their digits (a whole number has no leading zero), so numbers past 2^53 still compare right. */
function compareNumberForms(a: string, b: string): number {
  const da = a.slice(SCRIPT_GLOB_PREFIX.length)
  const db = b.slice(SCRIPT_GLOB_PREFIX.length)
  if (da.length !== db.length) return da.length - db.length
  return da < db ? -1 : da > db ? 1 : 0
}

/**
 * Validation stage 2, the script names (b.uqm SR-2.3, SR-2.6): one failure
 * per entry that is not a regular file and per regular file that breaks the
 * naming rule, the two kinds interleaved in bytewise file-name order.
 */
export function checkScriptNames(entries: readonly IntegrationEntry[]): NameFailure[] {
  const failures: NameFailure[] = []
  for (const entry of sortEntriesBytewise(entries)) {
    if (entry.kind !== 'regular') failures.push({ name: entry.name, reason: notRegularEntryReason(entry.name, entry.kind) })
    else if (!isScriptFileName(entry.name)) failures.push({ name: entry.name, reason: badScriptNameReason(entry.name) })
  }
  return failures
}

/**
 * Validation stage 3, duplicate numbers (b.uqm SR-2.3, SR-2.6): one failure
 * per number that two or more scripts hold, naming every such file in
 * bytewise order, by ascending number. Numbers are compared by their exact
 * digits. Entries stage 2 refuses are not scripts and are not counted.
 */
export function checkDuplicateNumbers(entries: readonly IntegrationEntry[]): DuplicateNumberFailure[] {
  const fileNamesByForm = new Map<string, string[]>()
  for (const script of namedScripts(sortEntriesBytewise(entries))) {
    const fileNames = fileNamesByForm.get(script.numberForm)
    if (fileNames === undefined) fileNamesByForm.set(script.numberForm, [script.fileName])
    else fileNames.push(script.fileName)
  }
  return [...fileNamesByForm]
    .filter(([, fileNames]) => fileNames.length > 1)
    .sort(([a], [b]) => compareNumberForms(a, b))
    .map(([numberForm, fileNames]) => ({ numberForm, fileNames, reason: duplicateNumberReason(numberForm, fileNames) }))
}

/** Validation stage 4, a missing test-1 (b.uqm SR-2.3, SR-2.6): one failure when no script is numbered 1, else none. */
export function checkMissingTest1(entries: readonly IntegrationEntry[]): StageFailure[] {
  const test1 = numberFormOf(FIRST_SCRIPT_NUMBER)
  return namedScripts(entries).some((script) => script.numberForm === test1) ? [] : [{ reason: missingTest1Reason() }]
}

/**
 * The scripts of an entry list that passes stages 2 to 4 (b.uqm Terms): file
 * name, number and number form, in canonical order (b.uqm SR-3.3), so test-0
 * follows test-4. Entries that are not scripts are left out.
 */
export function scriptListOf(entries: readonly IntegrationEntry[]): Script[] {
  return sortScriptsCanonical(namedScripts(sortEntriesBytewise(entries)))
}

// Stage 5, the selection, and the run's scripts (b.uqm SR-2.3, Terms).

/** A run's selection: none for a full run, else the selected scripts, each once, in canonical order. */
export type ScriptSelection =
  | {
      readonly kind: 'full'
    }
  | {
      readonly kind: 'selective'
      readonly selected: readonly Script[]
    }

/** Validation stage 5's outcome: the selection, or the SCRIPT arguments that match no script, in argument order. */
export type SelectionStage =
  | {
      readonly ok: true
      readonly selection: ScriptSelection
    }
  | {
      readonly ok: false
      readonly failures: readonly SelectionFailure[]
    }

/**
 * The script a SCRIPT argument names, or null (b.uqm SR-2.3): a number form
 * matches only the script with exactly that number (`test-2` never matches
 * test-20), a file name only that whole file name, and anything else nothing.
 */
export function matchScript(argument: string, scripts: readonly Script[]): Script | null {
  const form = classifyScriptName(argument)
  if (form.kind === 'number-form') return scripts.find((script) => script.numberForm === form.numberForm) ?? null
  if (form.kind === 'file-name') return scripts.find((script) => script.fileName === argument) ?? null
  return null
}

/**
 * Validation stage 5, the selection (b.uqm SR-2.3, SR-2.6), over the SCRIPT
 * arguments in argument order (`Invocation.scripts`) and the script list. No
 * SCRIPT argument is a full run. Each SCRIPT argument that matches no script
 * is one failure naming it as given, in argument order. A script named more
 * than once, in either form or both, is selected once.
 */
export function selectScripts(scriptArguments: readonly string[], scripts: readonly Script[]): SelectionStage {
  if (scriptArguments.length === 0) return { ok: true, selection: { kind: 'full' } }
  const selected = new Map<string, Script>()
  const failures: SelectionFailure[] = []
  for (const [scriptIndex, argument] of scriptArguments.entries()) {
    const script = matchScript(argument, scripts)
    if (script === null) failures.push({ argument, scriptIndex, reason: unmatchedScriptReason(argument) })
    else selected.set(script.fileName, script)
  }
  if (failures.length > 0) return { ok: false, failures }
  return { ok: true, selection: { kind: 'selective', selected: sortScriptsCanonical([...selected.values()]) } }
}

/**
 * Each script's declared prerequisites (b.uqm SR-3.1, SR-3.4), keyed by the
 * declaring script's file name; each value is its direct prerequisites' file
 * names. Stage 6 (7/T2) builds it with one entry per script, test-1 excluded
 * from the values, in canonical order. Readers also accept a script that is
 * absent (no prerequisites) and a test-1 value (which changes nothing).
 */
export type PrerequisiteMap = ReadonlyMap<string, readonly string[]>

/**
 * The run's scripts (b.uqm Terms), in canonical order (b.uqm SR-3.3): for a
 * full run, every script of the list; for a selective run, the selected
 * scripts, their prerequisites followed transitively through `prerequisites`,
 * and test-1. Throws when a prerequisite names no script of the list, which
 * stage 6 refuses before this is asked.
 */
export function runScriptsOf(selection: ScriptSelection, scripts: readonly Script[], prerequisites: PrerequisiteMap): Script[] {
  if (selection.kind === 'full') return sortScriptsCanonical(scripts)
  const byFileName = new Map(scripts.map((script) => [script.fileName, script] as const))
  const included = new Map<string, Script>()
  const pending: Script[] = [...selection.selected]
  for (let script = pending.pop(); script !== undefined; script = pending.pop()) {
    if (included.has(script.fileName)) continue
    included.set(script.fileName, script)
    for (const name of prerequisites.get(script.fileName) ?? []) {
      const prerequisite = byFileName.get(name)
      if (prerequisite === undefined) {
        throw new Error(`runScriptsOf: ${shownArgument(script.fileName)} needs ${shownArgument(name)}, which is not one of the scripts`)
      }
      pending.push(prerequisite)
    }
  }
  const test1 = scripts.find((script) => script.numberForm === numberFormOf(FIRST_SCRIPT_NUMBER))
  if (test1 !== undefined) included.set(test1.fileName, test1)
  return sortScriptsCanonical([...included.values()])
}

// --- 7/T2 (E2 T2): prerequisite headers and units ---

// The `# ci-requires:` line (b.uqm SR-3.1). The parser is pure: it takes a
// script's file name and text and reads nothing, so E8's read-back runs the
// same parser over the image's script texts.

/** A prerequisite line as a reason names it, `# ci-requires:`. */
const PREREQUISITE_LINE_TEXT = `# ${CI_REQUIRES_KEYWORD}`
/** The first character of every line in a script's header comment block (b.uqm SR-3.1). */
const COMMENT_MARK = '#'
/** Optional spaces or tabs at the start of a text. */
const LEADING_BLANKS_PATTERN = /^[ \t]*/
/** One or more spaces or tabs, which separate a prerequisite line's words. */
const PREREQUISITE_WORD_SEPARATOR = /[ \t]+/

/** One prerequisite line found in a script's text (b.uqm SR-3.1). */
export interface PrerequisiteLine {
  /** Its line number in the script, from 1. */
  readonly lineNumber: number
  /** Its words after the colon, in order; none when it names no script. */
  readonly words: readonly string[]
}

/** One script's prerequisite lines, parsed (b.uqm SR-3.1). */
export interface PrerequisiteParse {
  /** The script's file name. */
  readonly fileName: string
  /** The counted line: the first prerequisite line inside the header comment block (so its `#` is the line's first character); null when there is none. Only it supplies names. */
  readonly counted: PrerequisiteLine | null
  /** Every further prerequisite line inside the header comment block, in line order. */
  readonly secondLines: readonly PrerequisiteLine[]
  /** Every prerequisite line outside the header comment block, in line order: below it, with a first character other than `#`, or on the first line. */
  readonly outsideLines: readonly PrerequisiteLine[]
}

/**
 * The words after the keyword when `line` is a prerequisite line: optional
 * leading spaces or tabs, `#`, optional spaces or tabs, then `ci-requires:` in
 * lowercase. Words are split on runs of spaces or tabs, so trailing spaces and
 * tabs give no word. Null for any other line.
 */
function prerequisiteLineWords(line: string): string[] | null {
  const unindented = line.replace(LEADING_BLANKS_PATTERN, '')
  if (!unindented.startsWith(COMMENT_MARK)) return null
  const afterMark = unindented.slice(COMMENT_MARK.length).replace(LEADING_BLANKS_PATTERN, '')
  if (!afterMark.startsWith(CI_REQUIRES_KEYWORD)) return null
  return afterMark
    .slice(CI_REQUIRES_KEYWORD.length)
    .split(PREREQUISITE_WORD_SEPARATOR)
    .filter((word) => word !== '')
}

/**
 * The index one past the header comment block: the block is the consecutive
 * lines whose first character is `#` after the first line (the shebang), up to
 * the first line whose first character is not `#` (b.uqm SR-3.1).
 */
function headerBlockEnd(lines: readonly string[]): number {
  let end = 1
  while (end < lines.length && lines[end].startsWith(COMMENT_MARK)) end += 1
  return end
}

/**
 * Parses one script's prerequisite lines from its text (b.uqm SR-3.1). Pure:
 * it takes the text, never a path, and reads nothing. A prerequisite line on
 * the first line is outside the header block, which follows the first line.
 */
export function parsePrerequisiteLines(fileName: string, text: string): PrerequisiteParse {
  const lines = text.split('\n')
  const headerEnd = headerBlockEnd(lines)
  let counted: PrerequisiteLine | null = null
  const secondLines: PrerequisiteLine[] = []
  const outsideLines: PrerequisiteLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const words = prerequisiteLineWords(lines[index])
    if (words === null) continue
    const found: PrerequisiteLine = { lineNumber: index + 1, words }
    if (index === 0 || index >= headerEnd) outsideLines.push(found)
    else if (counted === null) counted = found
    else secondLines.push(found)
  }
  return { fileName, counted, secondLines, outsideLines }
}

// Header refusals (b.uqm SR-3.1, SR-3.2; stage 6 of SR-2.6). Every script's
// header is checked in every run, full or selective. Every reason comes from
// an exported builder below, so tests import the text rather than type it.
// The map stage 6 returns is T1's `PrerequisiteMap`, with one entry per
// script: its direct prerequisites' file names, test-1 excluded, in canonical
// order (empty for a script with none).

/** A header refusal's kind (b.uqm SR-3.2), listed in the order one script's failures come in. */
export type HeaderFailureKind = 'unknown-name' | 'no-script-named' | 'cycle' | 'ordering' | 'extra-line'

/** A stage-6 failure: one header refusal (b.uqm SR-3.2). */
export interface HeaderFailure extends StageFailure {
  /** Its kind. */
  readonly kind: HeaderFailureKind
  /** The declaring script's file name; for a cycle, its first script in canonical order. */
  readonly script: string
}

/** Stage 6's outcome: the prerequisite map when every header is valid, else every failure in b.uqm SR-2.6's header order. */
export type HeaderCheck =
  | {
      readonly ok: true
      readonly prerequisites: PrerequisiteMap
    }
  | {
      readonly ok: false
      readonly failures: readonly HeaderFailure[]
    }

/** Which extra prerequisite lines one script holds besides its counted line (b.uqm SR-3.2). */
export type ExtraPrerequisiteLines = 'second' | 'outside' | 'both'

/** The rule a cycle breaks. */
const CYCLE_RULE_TEXT = 'a script may not require itself, directly or through other scripts'

/** `test-3-x.sh requires test-99, which is no script: …` (b.uqm SR-3.2). */
export function unknownPrerequisiteReason(script: string, name: string): string {
  return `${shownArgument(script)} requires ${shownArgument(name)}, which is no script: each word of a ${PREREQUISITE_LINE_TEXT} line must be a script's number form or whole file name`
}

/** `test-3-x.sh has a # ci-requires: line that names no script: …` (b.uqm SR-3.2). */
export function emptyPrerequisiteLineReason(script: string): string {
  return `${shownArgument(script)} has a ${PREREQUISITE_LINE_TEXT} line that names no script: a ${PREREQUISITE_LINE_TEXT} line must name at least one script`
}

/** A cycle, its scripts in canonical order: `test-5-x.sh requires itself: …` for one, `test-2-a.sh and test-3-b.sh form a prerequisite cycle: …` for more (b.uqm SR-3.2). */
export function prerequisiteCycleReason(scripts: readonly string[]): string {
  const names = joinedNames(scripts.map(shownArgument))
  const subject = scripts.length === 1 ? `${names} requires itself` : `${names} form a prerequisite cycle`
  return `${subject}: ${CYCLE_RULE_TEXT}`
}

/** `test-2-a.sh requires test-7-b.sh, which sorts after it: …` (b.uqm SR-3.2). */
export function prerequisiteOrderReason(dependent: string, prerequisite: string): string {
  return `${shownArgument(dependent)} requires ${shownArgument(prerequisite)}, which sorts after it: a prerequisite must come before its dependent in canonical order`
}

/** `test-3-x.sh has a second # ci-requires: line: a script may hold one prerequisite line, inside its header comment block` (b.uqm SR-3.2). */
export function extraPrerequisiteLineReason(script: string, extra: ExtraPrerequisiteLines): string {
  const what =
    extra === 'second'
      ? `a second ${PREREQUISITE_LINE_TEXT} line`
      : extra === 'outside'
        ? `a ${PREREQUISITE_LINE_TEXT} line outside its header comment block`
        : `a second ${PREREQUISITE_LINE_TEXT} line and one outside its header comment block`
  return `${shownArgument(script)} has ${what}: a script may hold one prerequisite line, inside its header comment block`
}

/** Whether a script is test-1. */
function isTest1(script: Script): boolean {
  return script.numberForm === numberFormOf(FIRST_SCRIPT_NUMBER)
}

/** One script's counted line resolved: its unknown names and its links, each in word order and once. */
interface ResolvedHeader {
  /** The words naming no script. */
  readonly unknownNames: readonly string[]
  /** The file names of the scripts it names, test-1 excluded. */
  readonly links: readonly string[]
  /** Whether it has a counted line with no words. */
  readonly namesNoScript: boolean
  /** Its extra lines, if any. */
  readonly extra: ExtraPrerequisiteLines | null
}

/** Resolves one script's parse against the script list (b.uqm SR-3.1, SR-3.2). Extra lines supply no links. */
function resolveHeader(parse: PrerequisiteParse | undefined, scripts: readonly Script[]): ResolvedHeader {
  const unknownNames: string[] = []
  const links: string[] = []
  for (const word of parse?.counted?.words ?? []) {
    const named = matchScript(word, scripts)
    if (named === null) {
      if (!unknownNames.includes(word)) unknownNames.push(word)
    } else if (!isTest1(named) && !links.includes(named.fileName)) {
      links.push(named.fileName)
    }
  }
  const second = (parse?.secondLines.length ?? 0) > 0
  const outside = (parse?.outsideLines.length ?? 0) > 0
  return {
    unknownNames,
    links,
    namesNoScript: parse?.counted?.words.length === 0,
    extra: second && outside ? 'both' : second ? 'second' : outside ? 'outside' : null,
  }
}

/** Every name reachable from `start` along `edges` in one or more steps; `start` itself only when a path leads back to it. */
function reachableFrom(start: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const reached = new Set<string>()
  const pending = [...(edges.get(start) ?? [])]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (reached.has(next)) continue
    reached.add(next)
    pending.push(...(edges.get(next) ?? []))
  }
  return reached
}

/**
 * The cycles of the link graph (b.uqm SR-3.2), each its file names in
 * canonical order, listed by their first script in canonical order: a group of
 * two or more scripts each reachable from every other, or a script naming
 * itself. test-1 is in none, since links to it are ignored.
 */
function prerequisiteCycles(ordered: readonly Script[], links: ReadonlyMap<string, readonly string[]>): string[][] {
  const reach = new Map(ordered.map((script) => [script.fileName, reachableFrom(script.fileName, links)]))
  const reaches = (from: string, to: string): boolean => reach.get(from)?.has(to) ?? false
  const placed = new Set<string>()
  const cycles: string[][] = []
  for (const { fileName } of ordered) {
    if (placed.has(fileName) || !reaches(fileName, fileName)) continue
    const members = ordered
      .map((script) => script.fileName)
      .filter((other) => other === fileName || (reaches(fileName, other) && reaches(other, fileName)))
    for (const member of members) placed.add(member)
    cycles.push(members)
  }
  return cycles
}

/** One script's failures in b.uqm SR-3.2's order: unknown names, a line naming no script, the cycle it declares first, ordering, extra lines. */
function scriptHeaderFailures(
  script: Script,
  header: ResolvedHeader,
  declaredCycle: readonly string[] | undefined,
  cycleOf: ReadonlyMap<string, readonly string[]>,
): HeaderFailure[] {
  const fileName = script.fileName
  const failures: HeaderFailure[] = header.unknownNames.map((name) => ({
    kind: 'unknown-name',
    script: fileName,
    reason: unknownPrerequisiteReason(fileName, name),
  }))
  if (header.namesNoScript) failures.push({ kind: 'no-script-named', script: fileName, reason: emptyPrerequisiteLineReason(fileName) })
  if (declaredCycle !== undefined) failures.push({ kind: 'cycle', script: fileName, reason: prerequisiteCycleReason(declaredCycle) })
  const ownCycle = cycleOf.get(fileName) ?? []
  for (const prerequisite of header.links) {
    if (ownCycle.includes(prerequisite)) continue
    if (compareCanonical(prerequisite, fileName) <= 0) continue
    failures.push({ kind: 'ordering', script: fileName, reason: prerequisiteOrderReason(fileName, prerequisite) })
  }
  if (header.extra !== null) failures.push({ kind: 'extra-line', script: fileName, reason: extraPrerequisiteLineReason(fileName, header.extra) })
  return failures
}

/**
 * Stage 6 of b.uqm SR-2.6: checks every script's prerequisite lines (b.uqm
 * SR-3.1, SR-3.2). Takes the script list and each script's parse (a script
 * without one has no prerequisite line), and gives either every failure, by
 * the declaring script's canonical order and then SR-3.2's order (several of
 * one kind in the line's word order), or the prerequisite map. Pure.
 */
export function checkPrerequisiteHeaders(scripts: readonly Script[], parses: readonly PrerequisiteParse[]): HeaderCheck {
  const ordered = sortScriptsCanonical(scripts)
  const parseOf = new Map(parses.map((parse) => [parse.fileName, parse]))
  const resolved = ordered.map((script) => ({ script, header: resolveHeader(parseOf.get(script.fileName), ordered) }))
  const links = new Map(resolved.map(({ script, header }) => [script.fileName, header.links]))
  const cycles = prerequisiteCycles(ordered, links)
  const cycleOf = new Map(cycles.flatMap((cycle) => cycle.map((member) => [member, cycle] as const)))
  const declaredCycles = new Map(cycles.map((cycle) => [cycle[0], cycle] as const))
  const failures = resolved.flatMap(({ script, header }) =>
    scriptHeaderFailures(script, header, declaredCycles.get(script.fileName), cycleOf),
  )
  if (failures.length > 0) return { ok: false, failures }
  const prerequisites = new Map(resolved.map(({ script, header }) => [script.fileName, sortCanonical(header.links)]))
  return { ok: true, prerequisites }
}

// Scheduling units and the effective N (b.uqm SR-3.4), found in the worktree
// before admission. E4's assignment takes the units in their order, and stage
// 7 checks fault shard numbers against the effective N.

/**
 * The scheduling units of the run's scripts (b.uqm SR-3.4): the connected
 * groups of the graph whose nodes are the run's scripts other than test-1 and
 * whose edges are the prerequisite links among them; a script with no link is
 * a unit of its own. Units come in the canonical order of their first scripts,
 * and each unit's scripts in canonical order. test-1 alone gives no unit. Pure.
 */
export function schedulingUnits(runScripts: readonly Script[], prerequisites: PrerequisiteMap): SchedulingUnit[] {
  const members = sortScriptsCanonical(runScripts.filter((script) => !isTest1(script)))
  const neighbours = new Map(members.map((script) => [script.fileName, [] as string[]]))
  for (const { fileName } of members) {
    for (const prerequisite of prerequisites.get(fileName) ?? []) {
      const theirs = neighbours.get(prerequisite)
      if (theirs === undefined || prerequisite === fileName) continue
      neighbours.get(fileName)?.push(prerequisite)
      theirs.push(fileName)
    }
  }
  const placed = new Set<string>()
  const units: SchedulingUnit[] = []
  for (const { fileName } of members) {
    if (placed.has(fileName)) continue
    const group = reachableFrom(fileName, neighbours)
    group.add(fileName)
    for (const member of group) placed.add(member)
    units.push({ scripts: members.filter((script) => group.has(script.fileName)) })
  }
  return units
}

/**
 * The effective N (b.uqm SR-3.4): the smaller of the requested N (`--shards`'
 * value, else `MAX_SHARDS`) and the number of units, but at least the lowest
 * N, 1, so a run of test-1 alone runs one shard.
 */
export function effectiveShardCount(requested: number | null, unitCount: number): number {
  return Math.max(OPTION_RANGE_MIN, Math.min(requested ?? MAX_SHARDS, unitCount))
}

// --- 7/T3 (E2 T3): stages and credentials ---
//
// Validation stage 7, the faults' scripts and shard numbers (b.uqm SR-2.4);
// stage 8, the credentials (b.uqm SR-15.1); and the stage driver, which takes
// all eight stages in b.uqm SR-2.6's order and gives either the refusal or the
// validated run that E4, E8, E12 and E13 build on. Stages 7 and 8 are pure and
// return their failures in their stage's order; the driver alone reads the
// worktree, through T1's reader and one read of each script's text. Every
// reason comes from an exported builder and shows typed values through
// `shownArgument`, so none holds a line break, and none holds a credential's
// value.

// Stage 7 (b.uqm SR-2.4; stage 7 of SR-2.6). It judges
// `Invocation.givenFaults`, every `--inject` value as typed and in argument
// order, never the normalized faults: a wrong file name normalizes to a real
// script's number form, de-duplication drops a repeat, and a shard number past
// 2^53 loses its digits in a `Number`. Each failing occurrence is one failure,
// a repeat included.

/** A stage-7 failure's kind. */
export type FaultFailureKind = 'no-such-script' | 'not-in-run' | 'shard-out-of-range'

/** A stage-7 failure: a fault whose script, or one of whose shard numbers, the run cannot act on (b.uqm SR-2.4). */
export interface FaultFailure extends StageFailure {
  readonly kind: FaultFailureKind
  /** The `--inject` option's index in the `/ci` arguments; failures come in this, the argument order. */
  readonly position: number
  /** The `--inject` value as typed. */
  readonly fault: string
  /** The script or the shard number it names, as typed. */
  readonly named: string
}

/** `--inject fail:test-999 names test-999, which is no script: …` (b.uqm SR-2.4), the fault and its script as typed. */
export function faultScriptMissingReason(fault: string, script: string): string {
  return `${INJECT_OPTION} ${shownArgument(fault)} names ${shownArgument(script)}, which is no script: a fault's <script> must be a script's number form, test-<n>, or its whole file name in ${INTEGRATION_DIR_PATH}`
}

/** `--inject fail:test-5 names test-5, which is not one of the run's scripts: …` (b.uqm SR-2.4), the fault and its script as typed. */
export function faultScriptNotInRunReason(fault: string, script: string): string {
  return `${INJECT_OPTION} ${shownArgument(fault)} names ${shownArgument(script)}, which is not one of the run's scripts: a fault's <script> must be a script the run runs, one selected, a prerequisite of one, or test-1`
}

/** `--inject kill:3 names shard 3, which is out of range: …` (b.uqm SR-2.4), the fault and the shard number as typed. */
export function faultShardOutOfRangeReason(fault: string, shard: string, effectiveShards: number): string {
  return `${INJECT_OPTION} ${shownArgument(fault)} names shard ${shownArgument(shard)}, which is out of range: a fault's shard must be a whole number from ${OPTION_RANGE_MIN} to the effective N, here ${effectiveShards}`
}

/** A fault value's operand as typed: the text after its first colon. */
function faultOperand(value: string): string {
  return value.slice(value.indexOf(':') + 1)
}

/**
 * Whether a shard number, as typed, lies from 1 to `effectiveShards`. A whole
 * number has no leading zero, so digits longer than the effective N's are
 * larger than it; only then is `Number` read, so digits past 2^53 never are.
 */
function shardDigitsInRange(digits: string, effectiveShards: number): boolean {
  if (!isWholeNumber(digits) || digits.length > String(effectiveShards).length) return false
  const shard = Number(digits)
  return shard >= OPTION_RANGE_MIN && shard <= effectiveShards
}

/**
 * Validation stage 7, the faults' scripts and shard numbers (b.uqm SR-2.4,
 * SR-2.6), over every given fault in argument order. A `fail:` or `timeout:`
 * whose typed `<script>` names no script of the list (a number form matching
 * no script's number, a file name no script's whole file name) is one failure;
 * one naming a script outside the run's scripts is another. A `leak`,
 * `image-drift` or `kill` shard number outside 1 to the effective N is one
 * failure per bad number, `leak`'s k before its j. `retag` has no check. Pure.
 */
export function checkFaults(
  given: readonly GivenFault[],
  scripts: readonly Script[],
  runScripts: readonly Script[],
  effectiveShards: number,
): FaultFailure[] {
  const inRun = new Set(runScripts.map((script) => script.fileName))
  const failures: FaultFailure[] = []
  for (const { position, value, fault } of given) {
    const operand = faultOperand(value)
    const fail = (kind: FaultFailureKind, named: string, reason: string): void => {
      failures.push({ kind, position, fault: value, named, reason })
    }
    switch (fault.kind) {
      case 'fail':
      case 'timeout': {
        const script = matchScript(operand, scripts)
        if (script === null) fail('no-such-script', operand, faultScriptMissingReason(value, operand))
        else if (!inRun.has(script.fileName)) fail('not-in-run', operand, faultScriptNotInRunReason(value, operand))
        break
      }
      case 'leak':
      case 'image-drift':
      case 'kill':
        for (const shard of fault.kind === 'leak' ? operand.split(',') : [operand]) {
          if (!shardDigitsInRange(shard, effectiveShards)) fail('shard-out-of-range', shard, faultShardOutOfRangeReason(value, shard, effectiveShards))
        }
        break
      case 'retag':
        break
    }
  }
  return failures
}

// Stage 8, the credentials (b.uqm SR-15.1; stage 8 of SR-2.6): `ANTHROPIC_API_KEY`
// and `GH_TOKEN`, read from the runner's environment. The base-build token is
// looked up and checked only in step 4 (E8). Nothing here looks a credential
// up or spawns, and no reason holds a credential's value.

/** A credential step 2 checks (b.uqm SR-15.1). */
export type CheckedCredential = 'ANTHROPIC_API_KEY' | 'GH_TOKEN'

/** The variables stage 8 reads. */
const API_KEY_VARIABLE = 'ANTHROPIC_API_KEY'
const GH_TOKEN_VARIABLE = 'GH_TOKEN'
const BASE_URL_VARIABLE = 'ANTHROPIC_BASE_URL'

/** A stage-8 failure's kind: a missing credential, or a bad one (b.uqm SR-15.1). */
export type CredentialFailureKind = 'missing' | 'bad'

/** Why `ANTHROPIC_API_KEY` is a missing credential (b.uqm SR-15.1). */
export type MissingApiKeyCause = 'unset' | 'empty' | 'not-raw-key'

/** A stage-8 failure: one credential, at most one failure each, `ANTHROPIC_API_KEY` first (b.uqm SR-2.6, SR-15.1). */
export interface CredentialFailure extends StageFailure {
  readonly kind: CredentialFailureKind
  readonly variable: CheckedCredential
}

/** How a missing-credential reason states each cause. */
const MISSING_API_KEY_CAUSE_TEXT: Readonly<Record<MissingApiKeyCause, string>> = {
  unset: 'it is unset',
  empty: 'it is empty',
  'not-raw-key': `it does not begin ${RAW_KEY_PREFIX} and ${BASE_URL_VARIABLE} is unset`,
}

/** `ANTHROPIC_API_KEY is a missing credential (it is unset): …` (b.uqm SR-15.1), naming the variable, the cause and the rule, never the value. */
export function missingApiKeyReason(cause: MissingApiKeyCause): string {
  return `${API_KEY_VARIABLE} is a missing credential (${MISSING_API_KEY_CAUSE_TEXT[cause]}): it must be set and not empty, and begin ${RAW_KEY_PREFIX} unless ${BASE_URL_VARIABLE} is set`
}

/** `GH_TOKEN is a bad credential (it is shorter than 8 characters): …` (b.uqm SR-15.1), naming the variable and the rule, never the value. */
export function badCredentialReason(variable: CheckedCredential): string {
  return `${variable} is a bad credential (it is shorter than ${SECRET_MIN_LENGTH} characters): a secret credential that is set and not empty must be at least ${SECRET_MIN_LENGTH} characters long`
}

/** Whether a set, non-empty secret is shorter than the minimum, counted in characters (code points). */
function isShortSecret(value: string): boolean {
  return Array.from(value).length < SECRET_MIN_LENGTH
}

/** Why `ANTHROPIC_API_KEY` is missing, or null when it is not. An empty `ANTHROPIC_BASE_URL` counts as unset. */
function missingApiKeyCause(key: string | undefined, baseUrl: string | undefined): MissingApiKeyCause | null {
  if (key === undefined) return 'unset'
  if (key === '') return 'empty'
  const baseUrlSet = baseUrl !== undefined && baseUrl !== ''
  return !baseUrlSet && !key.startsWith(RAW_KEY_PREFIX) ? 'not-raw-key' : null
}

/**
 * Validation stage 8, the credentials (b.uqm SR-15.1, SR-2.6), over the
 * runner's environment: `ANTHROPIC_API_KEY` missing (unset, empty, or not
 * beginning `sk-ant-` while `ANTHROPIC_BASE_URL` is unset), else bad (shorter
 * than the minimum); then `GH_TOKEN` bad when set, not empty and shorter than
 * the minimum. At most one failure per variable, missing before bad. Pure.
 */
export function checkCredentials(env: ChildEnvironmentSource): CredentialFailure[] {
  const failures: CredentialFailure[] = []
  const key = env[API_KEY_VARIABLE]
  const cause = missingApiKeyCause(key, env[BASE_URL_VARIABLE])
  if (cause !== null) failures.push({ kind: 'missing', variable: API_KEY_VARIABLE, reason: missingApiKeyReason(cause) })
  else if (key !== undefined && isShortSecret(key)) failures.push({ kind: 'bad', variable: API_KEY_VARIABLE, reason: badCredentialReason(API_KEY_VARIABLE) })
  const ghToken = env[GH_TOKEN_VARIABLE]
  if (ghToken !== undefined && ghToken !== '' && isShortSecret(ghToken)) {
    failures.push({ kind: 'bad', variable: GH_TOKEN_VARIABLE, reason: badCredentialReason(GH_TOKEN_VARIABLE) })
  }
  return failures
}

// The stage driver (b.uqm SR-2.6; step 2 of SR-5.3). Validation stops at the
// first stage that finds a failure: its first failure is the refusal's
// summary and each other failure of that stage one detail line, in the
// stage's order. A worktree read that fails is a refusal too, its one-line
// read error the summary; a missing `tests/integration` is an empty listing,
// so stage 4 refuses the missing test-1.

/** A run that passed every validation stage (b.uqm SR-2.6, SR-3.4): what step 2 hands to the rest of the run sequence (E4, E8, E12, E13). */
export interface ValidatedRun {
  /** The parsed `/ci` arguments. */
  readonly invocation: Invocation
  /** The run's kind (b.uqm SR-2.5, SR-6.2). */
  readonly kind: RunKind
  /** The selection: none for a full run, else the selected scripts in canonical order. */
  readonly selection: ScriptSelection
  /** The script list: every script in `tests/integration`, in canonical order. */
  readonly scripts: readonly Script[]
  /** Each script's direct prerequisites, one entry per script (stage 6). */
  readonly prerequisites: PrerequisiteMap
  /** The run's scripts, in canonical order (b.uqm Terms). */
  readonly runScripts: readonly Script[]
  /** The run's scheduling units, in order (b.uqm SR-3.4). */
  readonly units: readonly SchedulingUnit[]
  /** The requested N: `--shards`' value, else `MAX_SHARDS` (b.uqm SR-3.4). */
  readonly requestedShards: number
  /** The effective N (b.uqm SR-3.4). */
  readonly effectiveShards: number
}

/** The driver's outcome: the validated run, or the refusal step 2 records. */
export type RunValidation =
  | {
      readonly ok: true
      readonly validated: ValidatedRun
    }
  | {
      readonly ok: false
      readonly refusal: Refusal
    }

/** A failing stage's refusal (b.uqm SR-2.6, SR-5.8): no kind, the first failure's reason as the summary, each other one a detail line in order. */
export function stageRefusal(failures: readonly StageFailure[]): Refusal {
  const [first, ...rest] = failures
  if (first === undefined) throw new Error('stageRefusal: a stage refused with no failure')
  return buildRefusal(
    null,
    first.reason,
    rest.map((failure) => failure.reason),
  )
}

/** The error of a script whose text could not be read, naming its path. */
export function scriptReadFailedText(path: string, error: string): string {
  return `reading the script ${shownArgument(path)} failed: ${error}`
}

/** `tests/integration` listed by T1's reader, a missing directory (or worktree) giving an empty listing; any other failure stays one. */
function readDiscoveryEntries(worktreeRoot: string): DepRead<readonly IntegrationEntry[]> {
  const read = readIntegrationEntries(worktreeRoot)
  if (read.ok) return read
  try {
    lstatSync(join(worktreeRoot, INTEGRATION_DIR_PATH))
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { ok: true, value: [] }
  }
  return read
}

/** Every script's text read once and parsed for stage 6 (b.uqm SR-3.1), in the list's order; the first read that fails ends it. */
function readPrerequisiteParses(worktreeRoot: string, scripts: readonly Script[]): DepRead<readonly PrerequisiteParse[]> {
  const dirPath = join(worktreeRoot, INTEGRATION_DIR_PATH)
  const parses: PrerequisiteParse[] = []
  for (const script of scripts) {
    const path = join(dirPath, script.fileName)
    const text = readTextFile(path)
    if (!text.ok) return { ok: false, error: scriptReadFailedText(path, text.error) }
    parses.push(parsePrerequisiteLines(script.fileName, text.value))
  }
  return { ok: true, value: parses }
}

/**
 * Validation, step 2 of the run sequence (b.uqm SR-2.6, SR-5.3): stage 1, the
 * arguments (`argumentStage`); the worktree's `tests/integration` read afresh
 * under `worktreeRoot`; stages 2 to 5 over its entries; stage 6 over every
 * script's header, in a full or a selective run alike (b.uqm SR-3.1); then the
 * run's scripts, the units and the effective N; stage 7 against them; stage 8
 * over `env`. No stage after the first failing one is evaluated. Spawns
 * nothing and writes nothing.
 */
export function validateRun(args: readonly string[], worktreeRoot: string, env: ChildEnvironmentSource): RunValidation {
  const refused = (refusal: Refusal): RunValidation => ({ ok: false, refusal })
  const argumentsChecked = argumentStage(args)
  if (!argumentsChecked.ok) return refused(argumentsChecked.refusal)
  const invocation = argumentsChecked.invocation

  const entries = readDiscoveryEntries(worktreeRoot)
  if (!entries.ok) return refused(buildRefusal(null, entries.error))
  for (const check of [checkScriptNames, checkDuplicateNumbers, checkMissingTest1]) {
    const failures = check(entries.value)
    if (failures.length > 0) return refused(stageRefusal(failures))
  }
  const scripts = scriptListOf(entries.value)

  const selected = selectScripts(invocation.scripts, scripts)
  if (!selected.ok) return refused(stageRefusal(selected.failures))

  const parses = readPrerequisiteParses(worktreeRoot, scripts)
  if (!parses.ok) return refused(buildRefusal(null, parses.error))
  const headers = checkPrerequisiteHeaders(scripts, parses.value)
  if (!headers.ok) return refused(stageRefusal(headers.failures))

  const runScripts = runScriptsOf(selected.selection, scripts, headers.prerequisites)
  const units = schedulingUnits(runScripts, headers.prerequisites)
  const requestedShards = invocation.shards ?? MAX_SHARDS
  const effectiveShards = effectiveShardCount(requestedShards, units.length)

  const faultFailures = checkFaults(invocation.givenFaults, scripts, runScripts, effectiveShards)
  if (faultFailures.length > 0) return refused(stageRefusal(faultFailures))

  const credentialFailures = checkCredentials(env)
  if (credentialFailures.length > 0) return refused(stageRefusal(credentialFailures))

  return {
    ok: true,
    validated: {
      invocation,
      kind: runKindOf(invocation),
      selection: selected.selection,
      scripts,
      prerequisites: headers.prerequisites,
      runScripts,
      units,
      requestedShards,
      effectiveShards,
    },
  }
}

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

// --- 15/T1 (E11 T1): integrity checks 1–11, the evidence reader, the evidence rule and the skip rules ---
//
// Checks 1–11 of b.uqm SR-13.2. They judge plain inputs in E1's types
// (`IntegrityInputs`, filled by E13 at step 2 of the end of run, b.uqm
// SR-5.7) and the run directory as it stands then, read by
// `readIntegrityEvidence` with E1's readers and never through a link. Nothing
// here spawns a process or reads a container: isolation is judged only from
// the inspection data captured at each shard's start and from the shard
// subdirectories (b.uqm SR-13.1, SR-10.5). `runIntegrityChecks1To11` runs
// them in order; T2's entry adds check 12, `secret-scan`.
//
// Each failure reads `FAIL: integrity: <check>: <detail>` (`integrityFailure`)
// and is one problem found. A problem about one shard carries that shard's
// number; a problem about the run directory, a fault, or several shards at
// once carries null, and its detail names every shard involved. A file in
// shard j's subdirectory holding shard k's canary, and a mount of shard k's
// subdirectory in shard j, are problems found in shard j and carry j. A
// detail names shards, scripts, entries, mount targets or faults; it never
// holds a credential, a canary, a hash or file content. A name can still
// spell one: every run canary in a line is masked here, and T2's entry masks
// every scanned value in every line it returns.
//
// Order of the failures: by check, in SR-13.2's order
// (`INTEGRITY_CHECK_ORDER`). Inside a check, the failures carrying a shard
// number come first, by shard number, then the null-shard failures; each
// group keeps the order the check finds them in: faults in their normalized
// order; a shard's mounts in inspection order, then the mounts it lacks; a
// shard's entries by path; a shard's assigned scripts in run order, then the
// scripts it was not assigned in canonical order; null-shard scripts in
// canonical order.
//
// The evidence rule (b.uqm SR-13.1), for checks 5, 10 and 11: a shard's own
// canary, tarball hash or fingerprint that is missing or malformed fails only
// when the shard ended normally (E10's `endedNormally`, never recomputed
// here) and its test-1 passed. Evidence a shard did record that is wrong
// fails in any shard: another shard's canary, a well-formed hash that differs
// from the run's, well-formed fingerprints that differ.
//
// The skip rules (b.uqm SR-13.1, SR-5.6): see `integritySkippedChecks`. A
// stopped run is checked from whatever evidence exists, as a finished one is.

/** b.uqm SR-13.2's twelve checks, in order: E10 ranks integrity failures in it (b.uqm SR-12.4). */
export const INTEGRITY_CHECK_ORDER: readonly IntegrityCheck[] = [
  'fault-fired',
  'schedule-coverage',
  'isolation-mounts',
  'isolation-config',
  'results-canary',
  'results-ownership',
  'image-drift',
  'name-collision',
  'result-coverage',
  'package-hash',
  'dependency-set',
  'secret-scan',
]

/** The read-only tarball mount's target in a shard, the path test-1 installs from (b.uqm SR-10.3). */
export const INTEGRITY_TARBALL_MOUNT_TARGET = '/tmp/package.tgz'
/** The target of a shard's own subdirectory's mount (b.uqm SR-10.3). */
export const INTEGRITY_RESULTS_MOUNT_TARGET = '/test-results'
/** `fault-fired`'s reason for a fault that has no firing record: it counts as not fired (b.uqm SR-14.3). */
export const NO_FIRING_RECORD_REASON = 'no firing record exists'
/** `fault-fired`'s reason for a fault whose firing record was still due when the checks ran (b.uqm SR-14.3). */
export const STILL_DUE_FIRING_REASON = 'it was still due when the run ended'

/** A Docker namespace mode shared with the host (b.uqm SR-13.2 check 4). */
const INTEGRITY_HOST_MODE = 'host'
/** A Docker namespace mode's prefix when it joins another container's namespace, `container:<id>` (b.uqm SR-13.2 check 4). */
const INTEGRITY_CONTAINER_MODE_PREFIX = 'container:'
/** A shard subdirectory's name, `shard-<k>`, k from 1; group 1 is k (b.uqm SR-5.9). */
const INTEGRITY_SHARD_DIR_PATTERN = /^shard-([1-9][0-9]*)$/
/** A canary as the runner draws it: 32 lowercase hexadecimal characters (b.uqm SR-11.2). */
const INTEGRITY_CANARY_PATTERN = /^[0-9a-f]{32}$/

// The inputs (b.uqm SR-13.1, SR-13.2). E13 fills them at step 2 of the end of
// run from what E8, E9, E10 and E12 recorded; nothing here calls their code.

/** When the run's first run-level stop came, as the skip rules read it (b.uqm SR-5.6, SR-13.1). */
export type IntegrityStopTime = 'before-end-of-run' | 'during-end-of-run'

/** The run state the skip rules read (b.uqm SR-13.1). */
export interface IntegrityRunState {
  /** Whether the shards were scheduled (the status phase reached `shards`, b.uqm SR-5.2). */
  readonly shardsScheduled: boolean
  /** Whether the test or base image build failed: an image build failure, never a build a stop ended (b.uqm SR-5.6). */
  readonly imageBuildFailed: boolean
  /** When the first run-level stop came: before the end-of-run sequence started (before or after scheduling, as `shardsScheduled` tells), during it, or null for none. */
  readonly stopTime: IntegrityStopTime | null
}

/** What checks 1–11 read of one shard: E1's `ShardEvidence` fields, so E13 passes its evidence as it is. Its container started when `start.kind` is `started`. */
export type IntegrityShard = Pick<ShardEvidence, 'shard' | 'endedNormally' | 'start' | 'canary' | 'inspection'>

/** Everything checks 1–11 judge besides the run directory's files (b.uqm SR-13.2). */
export interface IntegrityInputs {
  /** The run directory: the only place the evidence reader reads. */
  readonly runDir: string
  /** The run's expected scripts, as file names. */
  readonly expectedScripts: readonly string[]
  /** The assignment; null when the shards were never scheduled. */
  readonly assignment: Assignment | null
  /** One entry per shard admission chose, started or not. */
  readonly shards: readonly IntegrityShard[]
  /** The pinned image ID (E8, `ImageState.pinnedId`). */
  readonly pinnedImageId: string | null
  /** The run's tarball hash, 64 lowercase hexadecimal characters (E8); null when none was packed. */
  readonly packageSha256: string | null
  /** The tarball's path on the host, in the run directory's `package/` (E8); null when none was packed. */
  readonly tarballPath: string | null
  /** The normalized faults, in order (b.uqm SR-2.4). */
  readonly faults: readonly Fault[]
  /** E12's firing records, one per normalized fault. */
  readonly firingRecords: readonly FiringRecord[]
  readonly runState: IntegrityRunState
}

/** An integrity failure, `FAIL: integrity: <check>: <detail>`, with its shard or null (b.uqm SR-13.1, SR-12.4). The detail must be one line. */
export function integrityFailure(check: IntegrityCheck, detail: string, shard: number | null): Failure {
  return {
    line: `${FAIL_PREFIX}integrity: ${check}: ${detail}`,
    shard,
    failureClass: { kind: 'integrity', check },
  }
}

/** Failures in the order inside a check: by shard number, then the null-shard ones, each group in its given order. */
export function inIntegrityShardOrder(failures: readonly Failure[]): Failure[] {
  return [...failures].sort((a, b) => (a.shard ?? Number.POSITIVE_INFINITY) - (b.shard ?? Number.POSITIVE_INFINITY))
}

/** `shard-<k>`: a shard's name in a detail, and its subdirectory's name (b.uqm SR-5.9). */
function integrityShardName(shard: number): string {
  return `${SHARD_DIR_PREFIX}${shard}`
}

/** A shard's assigned scripts in run order; none when the assignment does not hold it. */
function integrityAssigned(inputs: IntegrityInputs, shard: number): readonly string[] {
  return inputs.assignment?.find((entry) => entry.shard === shard)?.assigned ?? []
}

/** The run's shard numbers, in order: every shard admission chose and every shard the assignment holds. */
export function integrityShardNumbers(inputs: IntegrityInputs): number[] {
  const numbers = new Set<number>([...inputs.shards.map((s) => s.shard), ...(inputs.assignment ?? []).map((entry) => entry.shard)])
  return [...numbers].sort((a, b) => a - b)
}

/** Whether a script name is test-1's. */
function isTestOneName(name: string): boolean {
  return scriptNameNumber(name) === 1
}

// The chunked byte search, shared by `results-canary`'s search (the evidence
// reader) and T2's `secret-scan`: a file's bytes are read a chunk at a time,
// each read keeping the previous window's last bytes, so a needle across two
// reads is found and no file is ever held whole, however large its
// `docker.log` or script log.

/** How much of a searched file is read at a time. Each read keeps the previous window's last bytes, so a needle across two reads is found. */
const FILE_SEARCH_CHUNK_BYTES = 1024 * 1024

/** A file's bytes searched: the indices of the needles found in it, or why it could not be read. */
type FileSearchOutcome =
  | {
      readonly kind: 'searched'
      readonly found: ReadonlySet<number>
    }
  | {
      readonly kind: 'unreadable'
      readonly error: string
    }

/**
 * Searches a file's bytes for the needles, in chunks, so a large file is
 * searched whole without being held whole. The file is opened without
 * following a link and without blocking, and anything but a regular file is
 * unreadable. With `firstOnly` it stops at the first read that finds any
 * needle; otherwise it reads on until every needle is found or the file ends.
 * Never throws.
 */
function searchFileBytes(path: string, needles: readonly Buffer[], firstOnly: boolean): FileSearchOutcome {
  let fd: number
  try {
    fd = openScannedFile(path, scanFsConstants.O_RDONLY | scanFsConstants.O_NOFOLLOW | scanFsConstants.O_NONBLOCK)
  } catch (err) {
    return { kind: 'unreadable', error: dependencyErrorText(err) }
  }
  try {
    if (!statScannedFile(fd).isFile()) return { kind: 'unreadable', error: 'not a regular file' }
    const overlap = Math.max(0, ...needles.map((needle) => needle.length - 1))
    const window = Buffer.alloc(overlap + FILE_SEARCH_CHUNK_BYTES)
    const found = new Set<number>()
    let kept = 0
    for (;;) {
      const read = readScannedFile(fd, window, kept, FILE_SEARCH_CHUNK_BYTES, null)
      if (read === 0) return { kind: 'searched', found }
      const filled = window.subarray(0, kept + read)
      needles.forEach((needle, index) => {
        if (!found.has(index) && filled.includes(needle)) found.add(index)
      })
      if (found.size > 0 && (firstOnly || found.size === needles.length)) return { kind: 'searched', found }
      kept = Math.min(overlap, filled.length)
      window.copy(window, 0, filled.length - kept, filled.length)
    }
  } catch (err) {
    return { kind: 'unreadable', error: dependencyErrorText(err) }
  } finally {
    try {
      closeScannedFile(fd)
    } catch {
      // The outcome is already decided; a failed close changes nothing.
    }
  }
}

// The evidence reader (b.uqm SR-1.3, SR-11.3, SR-13.2). It reads only under
// the run directory it is given: listings and entry types by `lstat`, so a
// link is never followed. In a shard subdirectory it searches every regular
// file's bytes for the run's canaries with the chunked search, holding no
// file whole, and keeps text only for the four small in-shard records at the
// subdirectory's top (`canary.txt`, `package.sha256`,
// `dependency-fingerprint.txt`, `result.txt`), read with E1's `readFileText`
// and parsed by E1's rules (`parseHexRecord`, `parseResultFileText`). In the
// run directory's own listing it reads entry types only. Nothing it meets is
// an error that stops the checks: a missing, unreadable or malformed thing
// comes out as what it is.

/** An entry's type, read without following a link. */
export type EvidenceEntryType = 'file' | 'directory' | 'symlink' | 'other'

/** One entry under a directory the reader lists. */
export interface EvidenceEntry {
  /** Its path relative to the listed directory, `/`-separated. */
  readonly path: string
  readonly type: EvidenceEntryType
  /** A record's text, for the four in-shard records at a shard subdirectory's top only; null for every other entry and for a record that could not be read. */
  readonly text: string | null
  /** A shard subdirectory's regular file searched whole: the canaries it holds, of those the reader was given; null for every other entry and for a file that could not be searched. */
  readonly heldCanaries: readonly string[] | null
  /** Why a regular file could not be searched or its record text read, a directory listed or the entry's type read, on one line; null otherwise. */
  readonly error: string | null
}

/** A directory as the reader found it. */
export type EvidenceListing =
  | {
      readonly kind: 'listed'
      /** Its entries by path: the run directory's top level only; a shard subdirectory's whole tree. */
      readonly entries: readonly EvidenceEntry[]
    }
  | {
      readonly kind: 'missing'
    }
  | {
      /** Something else is at its path: a link, a file. */
      readonly kind: 'not-a-directory'
      readonly type: EvidenceEntryType
    }
  | {
      readonly kind: 'unreadable'
      readonly error: string
    }

/** One shard's files as read (b.uqm SR-11.3). */
export interface ShardFilesEvidence {
  readonly shard: number
  /** Its subdirectory, `shard-<k>`, with every entry under it. */
  readonly dir: EvidenceListing
  /** `canary.txt`. */
  readonly canary: HexRecordRead
  /** `package.sha256`. */
  readonly packageSha256: HexRecordRead
  /** `dependency-fingerprint.txt`. */
  readonly dependencyFingerprint: HexRecordRead
  /** `result.txt`, under E1's reading rule. */
  readonly resultFile: ResultFileRead
  /** Each script's count of `end … pass`, `end … fail` and `notrun` lines in the result file; empty when it could not be read. */
  readonly resultCounts: ReadonlyMap<string, number>
  /** Whether the result file holds `end <test-1> pass`. */
  readonly testOnePassed: boolean
}

/** The run directory as checks 5, 6 and 9–11 judge it. */
export interface IntegrityEvidence {
  /** The run directory's own entries. */
  readonly runDir: EvidenceListing
  /** Each of the run's shards, in shard order. */
  readonly shards: readonly ShardFilesEvidence[]
}

/** An entry's type by `lstat`, never following a link; or why it could not be read, and whether because nothing is there. */
function evidenceEntryType(path: string): { readonly type: EvidenceEntryType; readonly error: string | null; readonly missing: boolean } {
  try {
    const stats = lstatEvidenceEntry(path)
    if (stats.isSymbolicLink()) return { type: 'symlink', error: null, missing: false }
    if (stats.isDirectory()) return { type: 'directory', error: null, missing: false }
    if (stats.isFile()) return { type: 'file', error: null, missing: false }
    return { type: 'other', error: null, missing: false }
  } catch (err) {
    return { type: 'other', error: dependencyErrorText(err), missing: errnoCode(err) === 'ENOENT' }
  }
}

/** A directory's entry names, sorted; or why it could not be listed. */
function evidenceDirNames(path: string): { readonly ok: true; readonly names: string[] } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, names: listEvidenceDir(path).sort() }
  } catch (err) {
    return { ok: false, error: dependencyErrorText(err) }
  }
}

/** The canaries a shard subdirectory's files are searched for, with their bytes, index for index. */
interface EvidenceSearch {
  readonly canaries: readonly string[]
  readonly needles: readonly Buffer[]
}

/** The in-shard records whose text the reader keeps: each small, and only at a shard subdirectory's top (b.uqm SR-11.3). */
const EVIDENCE_RECORD_FILE_NAMES: readonly string[] = [CANARY_FILE_NAME, PACKAGE_SHA256_FILE_NAME, DEPENDENCY_FINGERPRINT_FILE_NAME, RESULT_FILE_NAME]

/** A shard subdirectory's regular file read: its bytes searched in chunks for the canaries, and its text kept when it is a record at the top. */
function readEvidenceFile(path: string, relative: string, search: EvidenceSearch): EvidenceEntry {
  const searched = searchFileBytes(path, search.needles, false)
  const heldCanaries = searched.kind === 'searched' ? search.canaries.filter((_, index) => searched.found.has(index)) : null
  let error = searched.kind === 'unreadable' ? searched.error : null
  let text: string | null = null
  if (EVIDENCE_RECORD_FILE_NAMES.includes(relative)) {
    const read = readFileText(path)
    if (read.kind === 'text') text = read.text
    else error ??= read.kind === 'missing' ? 'it vanished while being read' : read.error
  }
  return { path: relative, type: 'file', text, heldCanaries, error }
}

/** One entry read: with `search`, a regular file searched (`readEvidenceFile`) and a directory with its tree; without, its type only. */
function readEvidenceEntry(dir: string, relative: string, search: EvidenceSearch | null, out: EvidenceEntry[]): void {
  const path = join(dir, relative)
  const { type, error } = evidenceEntryType(path)
  if (error !== null) {
    out.push({ path: relative, type, text: null, heldCanaries: null, error })
    return
  }
  if (search !== null && type === 'file') {
    out.push(readEvidenceFile(path, relative, search))
    return
  }
  if (search === null || type !== 'directory') {
    out.push({ path: relative, type, text: null, heldCanaries: null, error: null })
    return
  }
  const listed = evidenceDirNames(path)
  out.push({ path: relative, type, text: null, heldCanaries: null, error: listed.ok ? null : listed.error })
  if (!listed.ok) return
  for (const name of listed.names) readEvidenceEntry(dir, `${relative}/${name}`, search, out)
}

/** A directory listed: with `search`, its whole tree with every regular file searched; without, its top-level entries' types only. */
function readEvidenceListing(path: string, search: EvidenceSearch | null): EvidenceListing {
  const { type, error, missing } = evidenceEntryType(path)
  if (missing) return { kind: 'missing' }
  if (error !== null) return { kind: 'unreadable', error }
  if (type !== 'directory') return { kind: 'not-a-directory', type }
  const listed = evidenceDirNames(path)
  if (!listed.ok) return { kind: 'unreadable', error: listed.error }
  const entries: EvidenceEntry[] = []
  for (const name of listed.names) readEvidenceEntry(path, name, search, entries)
  return { kind: 'listed', entries }
}

/** A shard file's top-level entry, when its subdirectory was listed and holds one. */
function topLevelEntry(dir: EvidenceListing, name: string): EvidenceEntry | 'no-entry' | 'no-listing' {
  if (dir.kind !== 'listed') return dir.kind === 'unreadable' ? 'no-listing' : 'no-entry'
  return dir.entries.find((entry) => entry.path === name) ?? 'no-entry'
}

/** An in-shard hex record from its subdirectory's listing, by E1's rule: a value, missing, or malformed (a link or a directory at its name included). */
function evidenceHexRecord(dir: EvidenceListing, name: string, length: number): HexRecordRead {
  const entry = topLevelEntry(dir, name)
  if (entry === 'no-entry') return { kind: 'missing' }
  if (entry === 'no-listing') return { kind: 'malformed', error: 'its subdirectory could not be listed' }
  if (entry.type !== 'file') return { kind: 'malformed', error: 'not a regular file' }
  if (entry.text === null) return { kind: 'malformed', error: entry.error ?? 'it could not be read' }
  const parsed = parseHexRecord(entry.text, length)
  return parsed.ok ? { kind: 'value', value: parsed.value } : { kind: 'malformed', error: parsed.error }
}

/** The result file from its subdirectory's listing, by E1's reading rule: events, missing, or unreadable (a link or a directory at its name included). */
function evidenceResultFile(dir: EvidenceListing): ResultFileRead {
  const entry = topLevelEntry(dir, RESULT_FILE_NAME)
  if (entry === 'no-entry') return { kind: 'missing' }
  if (entry === 'no-listing') return { kind: 'unreadable', error: 'its subdirectory could not be listed' }
  if (entry.type !== 'file') return { kind: 'unreadable', error: 'not a regular file' }
  if (entry.text === null) return { kind: 'unreadable', error: entry.error ?? 'it could not be read' }
  return parseResultFileText(entry.text)
}

/** One shard's files read (b.uqm SR-11.3). */
function readShardFilesEvidence(runDir: string, shard: number, search: EvidenceSearch): ShardFilesEvidence {
  const dir = readEvidenceListing(join(runDir, integrityShardName(shard)), search)
  const resultFile = evidenceResultFile(dir)
  const resultCounts = new Map<string, number>()
  let testOnePassed = false
  if (resultFile.kind === 'events') {
    for (const event of resultFile.events) {
      if (event.kind !== 'end' && event.kind !== 'notrun') continue
      resultCounts.set(event.fileName, (resultCounts.get(event.fileName) ?? 0) + 1)
      if (event.kind === 'end' && event.result === 'pass' && isTestOneName(event.fileName)) testOnePassed = true
    }
  }
  return {
    shard,
    dir,
    canary: evidenceHexRecord(dir, CANARY_FILE_NAME, CANARY_LENGTH),
    packageSha256: evidenceHexRecord(dir, PACKAGE_SHA256_FILE_NAME, SHA256_HEX_LENGTH),
    dependencyFingerprint: evidenceHexRecord(dir, DEPENDENCY_FINGERPRINT_FILE_NAME, SHA256_HEX_LENGTH),
    resultFile,
    resultCounts,
    testOnePassed,
  }
}

/**
 * The evidence checks 5, 6 and 9–11 judge, read from the run directory only,
 * never through a link (b.uqm SR-1.3, SR-13.1): the run directory's entries
 * with their types; each given shard's subdirectory, every entry under it
 * with its type, and every regular file's bytes searched in chunks for the
 * given canaries (no file held whole); and its `canary.txt`,
 * `package.sha256`, `dependency-fingerprint.txt` and `result.txt` read by
 * E1's rules, the only texts kept. Empty canaries are ignored; with none,
 * every file is still read through, so an unreadable one shows. Never throws.
 */
export function readIntegrityEvidence(runDir: string, shardNumbers: readonly number[], canaries: readonly string[] = []): IntegrityEvidence {
  const distinct = [...new Set(canaries)].filter((canary) => canary !== '')
  const search: EvidenceSearch = { canaries: distinct, needles: distinct.map((canary) => Buffer.from(canary, 'utf8')) }
  return {
    runDir: readEvidenceListing(runDir, null),
    shards: shardNumbers.map((shard) => readShardFilesEvidence(runDir, shard, search)),
  }
}

/** Whether a shard owes its own canary, tarball hash and fingerprint: it ended normally and its test-1 passed (b.uqm SR-13.1). */
function owesOwnEvidence(shard: IntegrityShard | undefined, files: ShardFilesEvidence): boolean {
  return shard !== undefined && shard.endedNormally && files.testOnePassed
}

// Checks 1–2: fault-fired and schedule-coverage (b.uqm SR-13.2, SR-14.3).

/**
 * Check 1, `fault-fired` (b.uqm SR-13.2, SR-14.3): one failure per normalized
 * fault that did not fire, `<fault> did not fire (<why>)`, in the faults'
 * order, shard null. `<why>` is E12's reason exactly as written; a fault with
 * no firing record counts as not fired. A run with no faults gives none.
 */
export function checkFaultFired(inputs: IntegrityInputs): Failure[] {
  const failures: Failure[] = []
  for (const fault of inputs.faults) {
    const text = faultText(fault)
    const records = inputs.firingRecords.filter((record) => faultText(record.fault) === text)
    if (records.some((record) => record.state === 'fired')) continue
    const notFired = records.find((record) => record.state === 'not-fired')
    let why: string
    if (notFired !== undefined) why = notFired.reason ?? NO_FIRING_RECORD_REASON
    else why = records.length > 0 ? STILL_DUE_FIRING_REASON : NO_FIRING_RECORD_REASON
    failures.push(integrityFailure('fault-fired', `${text} did not fire (${why})`, null))
  }
  return failures
}

/** Each script's shards in the assignment, one entry per time it is assigned. */
function assignedShardsByScript(assignment: Assignment): Map<string, number[]> {
  const byScript = new Map<string, number[]>()
  for (const entry of assignment) {
    for (const name of entry.assigned) byScript.set(name, [...(byScript.get(name) ?? []), entry.shard])
  }
  return byScript
}

/**
 * Check 2, `schedule-coverage` (b.uqm SR-13.2): test-1 exactly once in every
 * shard used, every other expected script in exactly one shard, and no
 * script that is not expected. A problem in one shard carries its number; a
 * script in no shard or in several carries null and names the shards.
 */
export function checkScheduleCoverage(inputs: IntegrityInputs): Failure[] {
  const assignment = inputs.assignment ?? []
  const expected = new Set(inputs.expectedScripts)
  const failures: Failure[] = []
  const testOne = inputs.expectedScripts.find(isTestOneName) ?? numberFormOf(1)
  for (const entry of [...assignment].sort((a, b) => a.shard - b.shard)) {
    const count = entry.assigned.filter((name) => name === testOne).length
    if (count === 0) failures.push(integrityFailure('schedule-coverage', `${shownArgument(testOne)} is not assigned to ${integrityShardName(entry.shard)}`, entry.shard))
    if (count > 1) failures.push(integrityFailure('schedule-coverage', `${shownArgument(testOne)} is assigned ${count} times to ${integrityShardName(entry.shard)}`, entry.shard))
  }
  const byScript = assignedShardsByScript(assignment)
  for (const name of sortCanonical([...byScript.keys()].filter((n) => !expected.has(n)))) {
    const shards = byScript.get(name) ?? []
    const distinct = [...new Set(shards)].sort((a, b) => a - b)
    const only = distinct.length === 1 ? (distinct[0] ?? null) : null
    failures.push(integrityFailure('schedule-coverage', `${shownArgument(name)} is not an expected script but is assigned to ${distinct.map(integrityShardName).join(', ')}`, only))
  }
  for (const name of sortCanonical(inputs.expectedScripts.filter((n) => n !== testOne))) {
    const shards = [...(byScript.get(name) ?? [])].sort((a, b) => a - b)
    if (shards.length === 0) failures.push(integrityFailure('schedule-coverage', `${shownArgument(name)} is assigned to no shard`, null))
    if (shards.length > 1) failures.push(integrityFailure('schedule-coverage', `${shownArgument(name)} is assigned more than once: ${shards.map(integrityShardName).join(', ')}`, null))
  }
  return inIntegrityShardOrder(failures)
}

// Checks 3, 4, 7, 8: isolation-mounts, isolation-config, image-drift,
// name-collision (b.uqm SR-13.2, SR-10.3, SR-10.5). Judged from E9's records
// only; a shard whose container never started is outside checks 3, 4 and 7.

/** The started shards, in shard order, with their inspection data or null. */
function startedShards(inputs: IntegrityInputs): { readonly shard: number; readonly inspection: InspectionData | null }[] {
  return inputs.shards
    .filter((s) => s.start?.kind === 'started')
    .map((s) => ({ shard: s.shard, inspection: s.inspection }))
    .sort((a, b) => a.shard - b.shard)
}

/** `shard-<k> could not be inspected`: checks 3, 4 and 7 for a started shard without inspection data (b.uqm SR-10.5). */
function notInspectedFailure(check: 'isolation-mounts' | 'isolation-config' | 'image-drift', shard: number): Failure {
  return integrityFailure(check, `${integrityShardName(shard)} could not be inspected`, shard)
}

/** The shard whose subdirectory of this run a mount source is or lies in; null for any other source. */
function mountedShardDir(source: string, runDir: string): number | null {
  const base = resolve(runDir)
  const path = resolve(source)
  if (!path.startsWith(`${base}/`)) return null
  const first = path.slice(base.length + 1).split('/')[0] ?? ''
  const match = INTEGRITY_SHARD_DIR_PATTERN.exec(first)
  return match?.[1] === undefined ? null : Number(match[1])
}

/** One shard's `isolation-mounts` failures from its inspected mounts, in mount order, then the mounts it lacks. */
function shardMountFailures(inputs: IntegrityInputs, shard: number, mounts: readonly ShardMount[]): Failure[] {
  const name = integrityShardName(shard)
  const ownDir = resolve(inputs.runDir, name)
  const tarball = inputs.tarballPath === null ? null : resolve(inputs.tarballPath)
  const failures: Failure[] = []
  const fail = (detail: string): void => {
    failures.push(integrityFailure('isolation-mounts', detail, shard))
  }
  let tarballSeen = false
  let resultsSeen = false
  for (const mount of mounts) {
    const source = resolve(mount.source)
    const other = mountedShardDir(source, inputs.runDir)
    if (other !== null && other !== shard) {
      fail(`${name} mounts ${integrityShardName(other)}'s results subdirectory`)
      continue
    }
    if (mount.target === INTEGRITY_RESULTS_MOUNT_TARGET && !resultsSeen) {
      resultsSeen = true
      if (source !== ownDir) fail(`${name} mounts something other than its results subdirectory at ${INTEGRITY_RESULTS_MOUNT_TARGET}`)
      continue
    }
    if (mount.target === INTEGRITY_TARBALL_MOUNT_TARGET && !tarballSeen) {
      tarballSeen = true
      if (source !== tarball) fail(`${name}'s mount at ${INTEGRITY_TARBALL_MOUNT_TARGET} is not the run's tarball`)
      if (!mount.readOnly) fail(`${name}'s tarball mount at ${INTEGRITY_TARBALL_MOUNT_TARGET} is not read-only`)
      continue
    }
    fail(`${name} has an extra mount at ${shownArgument(mount.target)}`)
  }
  if (!tarballSeen) fail(`${name} has no tarball mount at ${INTEGRITY_TARBALL_MOUNT_TARGET}`)
  if (!resultsSeen) fail(`${name} has no mount of its results subdirectory at ${INTEGRITY_RESULTS_MOUNT_TARGET}`)
  return failures
}

/**
 * Check 3, `isolation-mounts` (b.uqm SR-13.2, SR-10.3): each started shard
 * has exactly the run's tarball, read-only, at `/tmp/package.tgz` and its own
 * subdirectory at `/test-results`. A mount of another shard's subdirectory
 * gives exactly `shard-<j> mounts shard-<k>'s results subdirectory`, once,
 * and is not also an extra mount.
 */
export function checkIsolationMounts(inputs: IntegrityInputs): Failure[] {
  const failures: Failure[] = []
  for (const { shard, inspection } of startedShards(inputs)) {
    if (inspection === null) failures.push(notInspectedFailure('isolation-mounts', shard))
    else failures.push(...shardMountFailures(inputs, shard, inspection.mounts))
  }
  return failures
}

/** A namespace mode's sharing: with the host, with another container, or none. */
function sharedNamespace(mode: string): 'the host' | 'another container' | null {
  if (mode === INTEGRITY_HOST_MODE) return 'the host'
  if (mode.startsWith(INTEGRITY_CONTAINER_MODE_PREFIX)) return 'another container'
  return null
}

/**
 * Check 4, `isolation-config` (b.uqm SR-13.2): no started shard uses host
 * network or privileged mode, or shares a PID, IPC or network namespace with
 * the host or another container; one failure per forbidden mode.
 */
export function checkIsolationConfig(inputs: IntegrityInputs): Failure[] {
  const failures: Failure[] = []
  for (const { shard, inspection } of startedShards(inputs)) {
    if (inspection === null) {
      failures.push(notInspectedFailure('isolation-config', shard))
      continue
    }
    const name = integrityShardName(shard)
    const network = sharedNamespace(inspection.networkMode)
    if (network === 'the host') failures.push(integrityFailure('isolation-config', `${name} uses host network mode`, shard))
    else if (network !== null) failures.push(integrityFailure('isolation-config', `${name} shares its network namespace with ${network}`, shard))
    if (inspection.privileged) failures.push(integrityFailure('isolation-config', `${name} runs in privileged mode`, shard))
    const pid = sharedNamespace(inspection.pidMode)
    if (pid !== null) failures.push(integrityFailure('isolation-config', `${name} shares its PID namespace with ${pid}`, shard))
    const ipc = sharedNamespace(inspection.ipcMode)
    if (ipc !== null) failures.push(integrityFailure('isolation-config', `${name} shares its IPC namespace with ${ipc}`, shard))
  }
  return failures
}

/** Check 7, `image-drift` (b.uqm SR-13.2): every started shard's inspected image ID equals the pinned ID. The detail names no ID. */
export function checkImageDrift(inputs: IntegrityInputs): Failure[] {
  const failures: Failure[] = []
  for (const { shard, inspection } of startedShards(inputs)) {
    if (inspection === null) failures.push(notInspectedFailure('image-drift', shard))
    else if (inputs.pinnedImageId === null || inspection.imageId !== inputs.pinnedImageId) {
      failures.push(integrityFailure('image-drift', `${integrityShardName(shard)}'s image is not the pinned image`, shard))
    }
  }
  return failures
}

/** Check 8, `name-collision` (b.uqm SR-13.2): no shard's name was in use when it started, per E9's start record. */
export function checkNameCollision(inputs: IntegrityInputs): Failure[] {
  return inputs.shards
    .filter((s) => s.start?.nameInUse === true)
    .sort((a, b) => a.shard - b.shard)
    .map((s) => integrityFailure('name-collision', `${integrityShardName(s.shard)}'s container name was already in use when it started`, s.shard))
}

// Checks 5–6: results-canary and results-ownership (b.uqm SR-13.2, SR-5.9).
// They read the run directory as it stands at step 2 of the end of run: every
// `docker.log` saved, no `results.json`, `summary.txt` or `verdict.txt` yet.

/** An entry's type as a detail names it. */
function evidenceTypeWords(type: EvidenceEntryType): { readonly the: string; readonly a: string } {
  switch (type) {
    case 'file':
      return { the: 'the file', a: 'a regular file' }
    case 'directory':
      return { the: 'the directory', a: 'a directory' }
    case 'symlink':
      return { the: 'the symbolic link', a: 'a symbolic link' }
    case 'other':
      return { the: 'the special file', a: 'a special file' }
  }
}

/**
 * Check 5, `results-canary` (b.uqm SR-13.2, SR-13.1): no file anywhere in a
 * shard subdirectory holds another shard's canary (naming both shards, and
 * carrying the shard whose subdirectory holds it), and a shard that ended
 * normally with test-1 passed has a `canary.txt` holding exactly its canary
 * and one line feed. Another shard's own canary file is not judged. The
 * search is the evidence reader's (`readIntegrityEvidence`, given the run's
 * canaries), each file's bytes in chunks. An entry that could not be read (a
 * file not searched whole, a directory not listed, an entry whose type could
 * not be read) cannot be cleared, and fails naming the shard and the entry.
 * Only shard subdirectories are searched, never the runner log.
 */
export function checkResultsCanary(inputs: IntegrityInputs, evidence: IntegrityEvidence): Failure[] {
  const canaries = inputs.shards.filter((s) => INTEGRITY_CANARY_PATTERN.test(s.canary))
  const failures: Failure[] = []
  for (const files of evidence.shards) {
    const name = integrityShardName(files.shard)
    const own = inputs.shards.find((s) => s.shard === files.shard)
    const fail = (detail: string): void => {
      failures.push(integrityFailure('results-canary', detail, files.shard))
    }
    if (files.dir.kind === 'unreadable') fail(`${name}'s results subdirectory could not be read`)
    if (files.dir.kind === 'listed') {
      for (const entry of files.dir.entries) {
        const unread = entry.type === 'file' ? entry.heldCanaries === null : entry.error !== null
        if (unread) {
          fail(`${name}'s ${shownArgument(entry.path)} could not be read`)
          continue
        }
        if (entry.heldCanaries === null) continue
        for (const other of canaries) {
          if (other.shard === files.shard || other.canary === own?.canary) continue
          if (entry.heldCanaries.includes(other.canary)) fail(`${name}'s ${shownArgument(entry.path)} holds ${integrityShardName(other.shard)}'s canary`)
        }
      }
    }
    if (!owesOwnEvidence(own, files)) continue
    if (files.canary.kind === 'missing') fail(`${name} has no ${CANARY_FILE_NAME}`)
    else if (files.canary.kind !== 'value' || files.canary.value !== own?.canary) fail(`${name}'s ${CANARY_FILE_NAME} does not hold its canary`)
  }
  return inIntegrityShardOrder(failures)
}

/** The regular files a shard subdirectory may hold: its records, `docker.log` and its assigned scripts' logs (b.uqm SR-13.2 check 6). */
function ownedShardFileNames(inputs: IntegrityInputs, shard: number): Set<string> {
  return new Set([
    CANARY_FILE_NAME,
    RESULT_FILE_NAME,
    PACKAGE_SHA256_FILE_NAME,
    DEPENDENCY_FINGERPRINT_FILE_NAME,
    DOCKER_LOG_FILE_NAME,
    ...integrityAssigned(inputs, shard).map((fileName) => `${fileName}${SCRIPT_LOG_SUFFIX}`),
  ])
}

/** The run directory's `results-ownership` failures, each shard null. */
function runDirOwnershipFailures(inputs: IntegrityInputs, runDir: EvidenceListing): Failure[] {
  if (runDir.kind !== 'listed') return [integrityFailure('results-ownership', 'the run directory could not be listed', null)]
  const shardDirs = new Set(integrityShardNumbers(inputs).map(integrityShardName))
  const failures: Failure[] = []
  for (const entry of runDir.entries) {
    let expected: EvidenceEntryType | null = null
    if (entry.path === STATUS_FILE_NAME || entry.path === RUNNER_LOG_FILE_NAME) expected = 'file'
    if (entry.path === PACKAGE_DIR_NAME || shardDirs.has(entry.path)) expected = 'directory'
    const shown = shownArgument(entry.path)
    if (expected === null) {
      failures.push(integrityFailure('results-ownership', `the run directory holds ${evidenceTypeWords(entry.type).the} ${shown}, which is not one of its entries`, null))
    } else if (entry.type !== expected) {
      failures.push(integrityFailure('results-ownership', `the run directory's ${shown} is ${evidenceTypeWords(entry.type).a}, not ${evidenceTypeWords(expected).a}`, null))
    }
  }
  return failures
}

/**
 * Check 6, `results-ownership` (b.uqm SR-13.2, SR-5.9): a shard subdirectory
 * holds only its `canary.txt`, `result.txt`, `package.sha256`,
 * `dependency-fingerprint.txt`, `docker.log` and the logs of its assigned
 * scripts, each a regular file; every other entry, a directory or a link
 * included, fails naming the shard. The run directory holds only
 * `status.json`, `runner.log`, the directory `package/` (whose contents are
 * not judged) and the run's shard subdirectories; every other entry fails
 * naming the run directory.
 */
export function checkResultsOwnership(inputs: IntegrityInputs, evidence: IntegrityEvidence): Failure[] {
  const failures: Failure[] = []
  for (const files of evidence.shards) {
    const name = integrityShardName(files.shard)
    if (files.dir.kind === 'unreadable') failures.push(integrityFailure('results-ownership', `${name}'s results subdirectory could not be listed`, files.shard))
    if (files.dir.kind !== 'listed') continue
    const owned = ownedShardFileNames(inputs, files.shard)
    for (const entry of files.dir.entries) {
      if (entry.path.includes('/')) continue
      const shown = shownArgument(entry.path)
      if (!owned.has(entry.path)) {
        failures.push(integrityFailure('results-ownership', `${name} holds ${evidenceTypeWords(entry.type).the} ${shown}, which is not one of its files`, files.shard))
      } else if (entry.type !== 'file') {
        failures.push(integrityFailure('results-ownership', `${name}'s ${shown} is ${evidenceTypeWords(entry.type).a}, not a regular file`, files.shard))
      }
    }
  }
  return inIntegrityShardOrder([...failures, ...runDirOwnershipFailures(inputs, evidence.runDir)])
}

// Checks 9–11: result-coverage, package-hash, dependency-set (b.uqm SR-13.2,
// SR-13.1).

/**
 * Check 9, `result-coverage` (b.uqm SR-13.2): in every shard that ended
 * normally, each assigned script, test-1 included, has exactly one `pass`,
 * `fail` or `notrun`, and no script has a result there unless assigned there.
 * Shards that did not end normally are not judged.
 */
export function checkResultCoverage(inputs: IntegrityInputs, evidence: IntegrityEvidence): Failure[] {
  const failures: Failure[] = []
  for (const shard of [...inputs.shards].filter((s) => s.endedNormally).sort((a, b) => a.shard - b.shard)) {
    const name = integrityShardName(shard.shard)
    const fail = (detail: string): void => {
      failures.push(integrityFailure('result-coverage', detail, shard.shard))
    }
    const files = evidence.shards.find((f) => f.shard === shard.shard)
    if (files === undefined || files.resultFile.kind === 'missing') {
      fail(`${name} has no ${RESULT_FILE_NAME}`)
      continue
    }
    if (files.resultFile.kind === 'unreadable') {
      fail(`${name}'s ${RESULT_FILE_NAME} could not be read`)
      continue
    }
    const assigned = [...new Set(integrityAssigned(inputs, shard.shard))]
    for (const script of assigned) {
      const count = files.resultCounts.get(script) ?? 0
      if (count === 0) fail(`${shownArgument(script)} has no result in ${name}`)
      if (count > 1) fail(`${shownArgument(script)} has ${count} results in ${name}`)
    }
    for (const script of sortCanonical([...files.resultCounts.keys()].filter((s) => !assigned.includes(s)))) {
      fail(`${shownArgument(script)} has a result in ${name}, which it is not assigned to`)
    }
  }
  return failures
}

/** A record's failures under the evidence rule: a missing or malformed one only when the shard owes it. */
function ownRecordFailure(record: HexRecordRead, owes: boolean, name: string, fileName: string): string | null {
  if (!owes || record.kind === 'value') return null
  return record.kind === 'missing' ? `${name} has no ${fileName}` : `${name}'s ${fileName} is malformed`
}

/**
 * Check 10, `package-hash` (b.uqm SR-13.2, SR-13.1): a well-formed recorded
 * tarball hash that differs from the run's fails in any shard; a missing or
 * malformed one fails only for a shard that ended normally with test-1
 * passed. The detail names no hash.
 */
export function checkPackageHash(inputs: IntegrityInputs, evidence: IntegrityEvidence): Failure[] {
  const failures: Failure[] = []
  for (const files of evidence.shards) {
    const name = integrityShardName(files.shard)
    const record = files.packageSha256
    if (record.kind === 'value' && record.value !== inputs.packageSha256) {
      failures.push(integrityFailure('package-hash', `${name}'s ${PACKAGE_SHA256_FILE_NAME} differs from the run's tarball hash`, files.shard))
    }
    const own = ownRecordFailure(record, owesOwnEvidence(inputs.shards.find((s) => s.shard === files.shard), files), name, PACKAGE_SHA256_FILE_NAME)
    if (own !== null) failures.push(integrityFailure('package-hash', own, files.shard))
  }
  return failures
}

/**
 * Check 11, `dependency-set` (b.uqm SR-13.2, SR-13.1): well-formed recorded
 * fingerprints that are not all the same give one null-shard failure naming
 * the shards in groups of equal fingerprints, ordered by their lowest shard;
 * a missing or malformed fingerprint fails only for a shard that ended
 * normally with test-1 passed (a test-1 that failed in its install wrote
 * none). The detail names no fingerprint.
 */
export function checkDependencySet(inputs: IntegrityInputs, evidence: IntegrityEvidence): Failure[] {
  const failures: Failure[] = []
  const groups = new Map<string, number[]>()
  for (const files of evidence.shards) {
    const record = files.dependencyFingerprint
    if (record.kind === 'value') groups.set(record.value, [...(groups.get(record.value) ?? []), files.shard])
    const name = integrityShardName(files.shard)
    const own = ownRecordFailure(record, owesOwnEvidence(inputs.shards.find((s) => s.shard === files.shard), files), name, DEPENDENCY_FINGERPRINT_FILE_NAME)
    if (own !== null) failures.push(integrityFailure('dependency-set', own, files.shard))
  }
  if (groups.size > 1) {
    const shown = [...groups.values()]
      .map((shards) => [...shards].sort((a, b) => a - b))
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
      .map((shards) => `(${shards.map(integrityShardName).join(', ')})`)
    failures.push(integrityFailure('dependency-set', `the dependency fingerprints differ between ${shown.join(', ')}`, null))
  }
  return inIntegrityShardOrder(failures)
}

// The ordered run of checks 1–11, with the skip rules (b.uqm SR-13.1,
// SR-13.2). T2's entry adds check 12 after them.

/**
 * The checks a run skips (b.uqm SR-13.1, SR-5.6), in SR-13.2's order:
 * - `schedule-coverage` when the image build failed, or a run-level stop
 *   came, before the shards were scheduled;
 * - `fault-fired` on an image build failure, and on a run-level stop that
 *   came before the end-of-run sequence started, injected run or not.
 * A stop during the sequence skips nothing. A skipped check runs nothing,
 * gives no failure, and is named here; a run with no faults that skips
 * nothing gets no `fault-fired` failure and no name.
 */
export function integritySkippedChecks(state: IntegrityRunState): IntegrityCheck[] {
  const stoppedBeforeSequence = state.stopTime === 'before-end-of-run'
  const skipped = new Set<IntegrityCheck>()
  if (state.imageBuildFailed || (stoppedBeforeSequence && !state.shardsScheduled)) skipped.add('schedule-coverage')
  if (state.imageBuildFailed || stoppedBeforeSequence) skipped.add('fault-fired')
  return INTEGRITY_CHECK_ORDER.filter((check) => skipped.has(check))
}

/** Checks 1–11's outcome: the failures in order, and the checks skipped. */
export interface IntegrityChecksResult {
  /** By check in SR-13.2's order; inside a check by shard number, then the null-shard ones. */
  readonly failures: readonly Failure[]
  /** The skipped checks' names, in SR-13.2's order. */
  readonly skippedChecks: readonly IntegrityCheck[]
}

/** One of checks 1–11 run; `secret-scan` is T2's and gives nothing here. */
function runOneIntegrityCheck(check: IntegrityCheck, inputs: IntegrityInputs, evidence: IntegrityEvidence): Failure[] {
  switch (check) {
    case 'fault-fired':
      return checkFaultFired(inputs)
    case 'schedule-coverage':
      return checkScheduleCoverage(inputs)
    case 'isolation-mounts':
      return checkIsolationMounts(inputs)
    case 'isolation-config':
      return checkIsolationConfig(inputs)
    case 'results-canary':
      return checkResultsCanary(inputs, evidence)
    case 'results-ownership':
      return checkResultsOwnership(inputs, evidence)
    case 'image-drift':
      return checkImageDrift(inputs)
    case 'name-collision':
      return checkNameCollision(inputs)
    case 'result-coverage':
      return checkResultCoverage(inputs, evidence)
    case 'package-hash':
      return checkPackageHash(inputs, evidence)
    case 'dependency-set':
      return checkDependencySet(inputs, evidence)
    case 'secret-scan':
      return []
  }
}

/** A failure line with every run canary in it masked, so no detail (an entry name, a mount target) ever shows one. */
function withoutCanaries(failure: Failure, canaries: readonly string[]): Failure {
  let line = failure.line
  for (const canary of canaries) line = line.split(canary).join(REDACTION_PLACEHOLDER)
  return line === failure.line ? failure : { ...failure, line }
}

/**
 * Integrity checks 1–11 (b.uqm SR-13.1, SR-13.2): reads the evidence from
 * the run directory, applies the skip rules, and runs each check not skipped
 * in SR-13.2's order. Returns the failures by check, inside a check by shard
 * number then the null-shard ones, and the skipped checks' names. A stopped
 * run is checked from whatever evidence exists. Spawns nothing, writes
 * nothing, and never throws on what it reads.
 */
export function runIntegrityChecks1To11(inputs: IntegrityInputs): IntegrityChecksResult {
  const skippedChecks = integritySkippedChecks(inputs.runState)
  const canaries = inputs.shards.map((s) => s.canary).filter((canary) => INTEGRITY_CANARY_PATTERN.test(canary))
  const evidence = readIntegrityEvidence(inputs.runDir, integrityShardNumbers(inputs), canaries)
  const failures: Failure[] = []
  for (const check of INTEGRITY_CHECK_ORDER) {
    if (skippedChecks.includes(check)) continue
    for (const failure of inIntegrityShardOrder(runOneIntegrityCheck(check, inputs, evidence))) failures.push(withoutCanaries(failure, canaries))
  }
  return { failures, skippedChecks }
}

// --- 15/T2 (E11 T2): the scanned values and their masking, the runner log's masking switch-on, secret-scan, the masked end files, the integrity entry ---
//
// One masking rule serves three things (b.uqm SR-15.3): `secret-scan`'s
// match, the runner log's lines from the scan's start, and the end files. It
// is E1's runner-log pattern (`redactionPattern`), so all three mask alike.
// The scanned values are E1's secret-credential set (b.uqm SR-15.1), held in
// memory only: nothing here logs or writes one.
//
// From the scan's start nothing writes `status.json` or a shard file, and E13
// writes the three end files only through this sub-banner's exports
// (b.uqm SR-5.7, SR-15.3, SR-16.1):
// - `results.json` and `summary.txt` through E10's writer, given
//   `createEndFileRedactor(values)`, at end-of-run step 5 and again on the
//   rewrite after a stop during the sequence (b.uqm SR-5.6);
// - `verdict.txt` through `writeRedactedVerdictFile`, at step 6.
//
// `runIntegrity` is the one integrity entry E13 calls, at end-of-run step 2,
// after every `docker.log` is saved (b.uqm SR-5.7, SR-13.2). It takes
// `IntegrityEntryInputs`: T1's `IntegrityInputs` (the run directory, the
// tarball's path and the rest checks 1–11 judge), the scanned values and the
// runner-log writer. It runs checks 1–11, then `secret-scan`; the runner
// log's masking is on from the scan's start, so after checks 1–11 have run.
// It returns T1's failures in their order, then `secret-scan`'s, every line
// with every scanned value masked, and T1's skipped names; `secret-scan` is
// never skipped.

/**
 * The run's scanned values (b.uqm SR-15.1, SR-15.2): E1's secret-credential
 * set, so `ANTHROPIC_API_KEY`, `GH_TOKEN` when set and the base-build token
 * when step 4 looked one up. Never an empty string, and never the value of
 * `ANTHROPIC_BASE_URL` or `ANTHROPIC_MODEL` as such.
 */
export function scannedSecretValues(env: ChildEnvironmentSource, extras: SecretSetExtras = {}): readonly string[] {
  return [...secretCredentialSet(env, extras)].filter((value) => value !== '')
}

/** The distinct non-empty values among `values`. */
function distinctScannedValues(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value !== '')
}

/** A function masking the values in a text, built once for many texts. */
function scannedValueMasker(values: Iterable<string>): (text: string) => string {
  const pattern = redactionPattern(distinctScannedValues(values))
  if (pattern === null) return (text) => text
  return (text) => text.replace(pattern, REDACTION_PLACEHOLDER)
}

/**
 * `text` with every occurrence of every value replaced by `<redacted>`
 * (b.uqm SR-15.3), in one pass, longer values first, so a value holding
 * another is masked whole. Empty values are ignored, and a text holding no
 * value comes back unchanged.
 */
export function maskScannedValues(text: string, values: Iterable<string>): string {
  return scannedValueMasker(values)(text)
}

/**
 * Switches on the runner log's masking at `secret-scan`'s start (b.uqm
 * SR-15.3; contributes to SR-5.4): from then on every line the writer
 * appends, child-process output and error lines included, holds `<redacted>`
 * in place of every value, for the rest of the run. Calling it again only
 * adds values. E1's writer masks each whole line as it appends it, and a
 * child's output reaches it only as whole lines (the spawn binding joins a
 * stream's chunks before handing on a line; `childOutput` splits a text at
 * its line feeds), so a value that arrives in two parts is masked whole.
 */
export function switchOnRunnerLogRedaction(log: RunnerLogWriter, values: Iterable<string>): void {
  log.redactValues(distinctScannedValues(values))
}

/** One scanned entry's outcome. */
type ScannedEntryOutcome =
  | {
      readonly kind: 'clean' | 'match'
    }
  | {
      readonly kind: 'unreadable'
      readonly error: string
    }

/** What the walk found: paths relative to the run directory. */
interface SecretScanFindings {
  readonly matches: string[]
  readonly unreadable: string[]
}

/**
 * Searches a file's bytes for any value with T1's chunked search
 * (`searchFileBytes`), stopping at the first read that finds one, so a large
 * `docker.log` is searched whole without being held whole. The file is opened
 * without following a link and without blocking, and anything but a regular
 * file is unreadable.
 */
function scanFileForValues(path: string, needles: readonly Buffer[]): ScannedEntryOutcome {
  const searched = searchFileBytes(path, needles, true)
  if (searched.kind === 'unreadable') return searched
  return searched.found.size > 0 ? { kind: 'match' } : { kind: 'clean' }
}

/** Searches a symbolic link's own target text for any value; the link is never followed. */
function scanLinkForValues(path: string, needles: readonly Buffer[]): ScannedEntryOutcome {
  try {
    const target = readlinkSync(path, { encoding: 'buffer' })
    return needles.some((needle) => target.includes(needle)) ? { kind: 'match' } : { kind: 'clean' }
  } catch (err) {
    return { kind: 'unreadable', error: dependencyErrorText(err) }
  }
}

/** Walks `dir` (`relDir` relative to the run directory, `''` for the run directory) depth first, never following a link, skipping only the file at `skip`. */
function walkScannedDir(
  dir: string,
  relDir: string,
  skip: string | null,
  needles: readonly Buffer[],
  findings: SecretScanFindings,
  noteUnreadable: (relPath: string, error: string) => void,
): void {
  const listed = ((): ScannedDirEntry[] | { readonly error: string } => {
    try {
      return listScannedDir(dir, { withFileTypes: true })
    } catch (err) {
      return { error: dependencyErrorText(err) }
    }
  })()
  if (!Array.isArray(listed)) {
    noteUnreadable(relDir === '' ? '.' : relDir, listed.error)
    return
  }
  for (const entry of listed) {
    const path = join(dir, entry.name)
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      walkScannedDir(path, relPath, skip, needles, findings, noteUnreadable)
      continue
    }
    if (path === skip) continue
    const outcome = entry.isSymbolicLink() ? scanLinkForValues(path, needles) : scanFileForValues(path, needles)
    if (outcome.kind === 'match') findings.matches.push(relPath)
    if (outcome.kind === 'unreadable') noteUnreadable(relPath, outcome.error)
  }
}

/** Orders texts by their UTF-8 bytes. */
function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Paths in bytewise order, each shown on one line, joined with `, `. */
function shownScanPaths(paths: readonly string[]): string {
  return [...paths].sort(compareUtf8Bytes).map(shownArgument).join(', ')
}

/**
 * `secret-scan`, integrity check 12 (b.uqm SR-13.2, SR-15.2, SR-15.3).
 *
 * It first switches on the runner log's masking (`switchOnRunnerLogRedaction`).
 * It then reads every file under `runDir` but the tarball at `tarballPath`
 * (absolute, or relative to `runDir`; null when none was packed), each as it
 * stands when read, and searches each whole file's bytes for each value. It
 * never follows a symbolic link; a link's own target text is searched.
 *
 * It returns at most two failures, each with shard null (a path is shown as
 * it is; `runIntegrity` masks every value in every line it returns): first
 * `FAIL: integrity: secret-scan: <file(s)>`, naming every file
 * holding a value; then `FAIL: integrity: secret-scan: <path(s)> not
 * readable`, naming every file or directory it could not read, so nothing is
 * passed as clean unread. Paths are relative to `runDir`, in bytewise order,
 * joined with `, `. It writes nothing but one runner-log line for each path
 * it could not read, through the now-masking writer; a log that throws loses
 * only its line.
 */
export function secretScan(runDir: string, values: Iterable<string>, tarballPath: string | null, log: RunnerLogWriter): Failure[] {
  const distinct = distinctScannedValues(values)
  switchOnRunnerLogRedaction(log, distinct)
  const root = resolve(runDir)
  const skip = tarballPath === null ? null : resolve(root, tarballPath)
  const needles = distinct.map((value) => Buffer.from(value, 'utf8'))
  const findings: SecretScanFindings = { matches: [], unreadable: [] }
  walkScannedDir(root, '', skip, needles, findings, (relPath, error) => {
    findings.unreadable.push(relPath)
    try {
      log(`secret-scan: could not read ${shownArgument(relPath)}: ${error}`)
    } catch {
      // The log's own failure loses this line only; the failure still names the path.
    }
  })
  const failures: Failure[] = []
  if (findings.matches.length > 0) failures.push(integrityFailure('secret-scan', shownScanPaths(findings.matches), null))
  if (findings.unreadable.length > 0) failures.push(integrityFailure('secret-scan', `${shownScanPaths(findings.unreadable)} not readable`, null))
  return failures
}

/** What the integrity entry takes: checks 1–11's inputs, plus the scanned values and the runner-log writer `secret-scan` switches to masking. */
export interface IntegrityEntryInputs extends IntegrityInputs {
  /** The run's scanned values (`scannedSecretValues`). */
  readonly values: readonly string[]
  /** The runner-log writer; it masks every value from the scan's start. */
  readonly log: RunnerLogWriter
}

/**
 * The integrity entry E13 calls at end-of-run step 2 (b.uqm SR-5.7,
 * SR-13.2): checks 1–11 (`runIntegrityChecks1To11`), then `secret-scan` over
 * `inputs.runDir` without `inputs.tarballPath`, which first switches on the
 * runner log's masking. Returns checks 1–11's failures in their order, then
 * any `secret-scan` failures, and checks 1–11's skipped names. `secret-scan`
 * is never skipped and never among them, on any outcome. Every returned
 * line, checks 1–12 alike, has every scanned value masked
 * (`maskScannedValues`), so an entry named after a value never shows it
 * (b.uqm SR-15.3); each failure's shard and class are kept as they are.
 */
export function runIntegrity(inputs: IntegrityEntryInputs): IntegrityChecksResult {
  const checks = runIntegrityChecks1To11(inputs)
  const scanFailures = secretScan(inputs.runDir, inputs.values, inputs.tarballPath, inputs.log)
  const mask = scannedValueMasker(inputs.values)
  const masked = (failure: Failure): Failure => {
    const line = mask(failure.line)
    return line === failure.line ? failure : { ...failure, line }
  }
  return {
    failures: [...checks.failures, ...scanFailures].map(masked),
    skippedChecks: checks.skippedChecks.filter((check) => check !== 'secret-scan'),
  }
}

/** Masks the values in the end files' content (b.uqm SR-15.3, SR-16.1); E13 hands it to E10's `results.json` and `summary.txt` writer. */
export interface EndFileRedactor {
  /** The results object with every string in it masked, `verdict` and object keys included; numbers, booleans and nulls are unchanged. */
  results(results: Results): Results
  /** The summary text, masked. */
  summary(text: string): string
}

/** `value` with every string in it, object keys included, passed through `mask`. */
function maskEveryString(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value)
  if (Array.isArray(value)) return value.map((item) => maskEveryString(item, mask))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), maskEveryString(item, mask)]))
  }
  return value
}

/**
 * The redactor for `results.json` and `summary.txt` (b.uqm SR-15.3, SR-16.1):
 * every occurrence of every value becomes `<redacted>`. The masked results
 * object keeps its shape, so it still serializes and parses through E1's
 * `serializeResults` and `parseResults`.
 */
export function createEndFileRedactor(values: Iterable<string>): EndFileRedactor {
  const mask = scannedValueMasker(values)
  return {
    results: (results: Results): Results => maskEveryString(results, mask) as Results,
    summary: mask,
  }
}

/** Writes `verdict.txt` (b.uqm SR-5.7, SR-15.3): the line masked, then E1's atomic whole-file verdict write, which refuses a line break. */
export function writeRedactedVerdictFile(runDir: string, line: string, values: Iterable<string>): WriteResult {
  return writeVerdictFile(runDir, maskScannedValues(line, values))
}

// ---------------------------------------------------------------------------
// 16. Faults (E12)
// ---------------------------------------------------------------------------

// --- 16/T1 (E12 T1): fault targets, the --fail lists, the reason builders and the fault controller ---
//
// Faults come only from the parsed `--inject` faults, `Invocation.faults`,
// normalized and in order (b.uqm SR-2.4, SR-14.1): nothing here reads an
// environment variable or a file to decide which faults exist, and a
// controller built from no faults is inert. The controller decides and never
// acts: it stops nothing, sends no signal, calls no docker and takes no final
// reading. Each `timeout:` or `kill:` firing is one `FaultDecision`, and each
// end marker a fault poll finds is one notice, handed to the one handler the
// driver (E13) supplies; E13 carries them out through E9's retirement. Causes
// are `ShardCause` values that E10 renders; no cause text is written here.
// The nine reasons a fault did not fire are written only by the builders
// below (b.uqm SR-14.3); E11 renders the `fault-fired` line from the records.

/** A `leak:<k>,<j>` fault's mount target in shard j, `/leak-shard-<k>`, where shard k's subdirectory is mounted read-only (b.uqm SR-10.3, SR-14.2). */
export function leakMountTarget(sourceShard: number): string {
  return `/leak-shard-${sourceShard}`
}

/** A shard's name in a reason, `shard-<k>` (b.uqm Terms). */
function faultShardName(shard: number): string {
  return `${SHARD_DIR_PREFIX}${shard}`
}

/** Shard k's subdirectory of the run directory, which holds its result file (b.uqm SR-5.9, SR-11.3). */
function faultShardDir(runDir: string, shard: number): string {
  return join(runDir, faultShardName(shard))
}

/** Where the assignment places a script, by its number form: the lowest-numbered shard holding it, so test-1, in every shard, gives shard 1. */
function faultScriptPlace(numberForm: string, assignment: Assignment): { readonly shard: number; readonly fileName: string } | null {
  let place: { readonly shard: number; readonly fileName: string } | null = null
  for (const entry of assignment) {
    const fileName = entry.assigned.find((name) => fileNameNumberForm(name) === numberForm)
    if (fileName !== undefined && (place === null || entry.shard < place.shard)) place = { shard: entry.shard, fileName }
  }
  return place
}

/**
 * The shard a fault acts on (b.uqm SR-14.2): for `fail:` and `timeout:`, the
 * shard the assignment gives the script (shard 1 for test-1); for
 * `leak:<k>,<j>`, j; for `image-drift:<k>` and `kill:<k>`, k. Null for
 * `retag`, and for a script the assignment does not place.
 */
export function faultTargetShard(fault: Fault, assignment: Assignment): number | null {
  switch (fault.kind) {
    case 'fail':
    case 'timeout':
      return faultScriptPlace(fault.script, assignment)?.shard ?? null
    case 'leak':
      return fault.targetShard
    case 'image-drift':
    case 'kill':
      return fault.shard
    case 'retag':
      return null
  }
}

/**
 * Shard k's `--fail` list (b.uqm SR-14.1, SR-11.2): the file names of the
 * `fail:` faults that act on it, in normalized fault order. No other fault,
 * and no `fail:` aimed at another shard, adds to it.
 */
export function shardFailFileNames(faults: readonly Fault[], assignment: Assignment, shard: number): string[] {
  const fileNames: string[] = []
  for (const fault of faults) {
    if (fault.kind !== 'fail') continue
    const place = faultScriptPlace(fault.script, assignment)
    if (place !== null && place.shard === shard) fileNames.push(place.fileName)
  }
  return fileNames
}

// The nine reasons a fault did not fire (b.uqm SR-14.3), the only place these
// texts are written. k is the shard the fault acts on (j for `leak:<k>,<j>`).

/** `image-drift:<k>`'s reason when the drift image's build failed (b.uqm SR-14.2). */
export function driftBuildFailedReason(exitCode: number): string {
  return `drift image build failed (exit ${exitCode})`
}

/** `retag`'s reason when the retag image's build failed (b.uqm SR-14.2). */
export function retagBuildFailedReason(exitCode: number): string {
  return `retag image build failed (exit ${exitCode})`
}

/** `retag`'s reason when the `-test` tag's move failed (b.uqm SR-14.2). */
export function tagMoveFailedReason(exitCode: number): string {
  return `tag move failed (exit ${exitCode})`
}

/** The reason when the fault's shard's start was attempted and its container did not start. */
export function shardNeverStartedReason(shard: number): string {
  return `${faultShardName(shard)} never started`
}

/** A `leak` or `image-drift` fault's reason when its shard started without the mount or the drift image, no build having failed. */
export function shardStartedWithoutItReason(shard: number): string {
  return `${faultShardName(shard)} started without it`
}

/** The reason when the fault's shard ended before the fault's moment came. */
export function shardEndedFirstReason(shard: number): string {
  return `${faultShardName(shard)} ended first`
}

/** The reason when the fault's shard reached its wall-time limit first. */
export function shardLimitReachedFirstReason(shard: number): string {
  return `${faultShardName(shard)} reached its wall-time limit first`
}

/** The reason when a run-level stop came first, or the run stopped before the fault's shard start or the tag move was attempted. */
export function runStoppedFirstReason(): string {
  return 'the run was stopped first'
}

/** The reason when another fault stopped the shard first, naming it in its normalized form (b.uqm SR-14.3). */
export function faultStoppedShardFirstReason(fault: Fault, shard: number): string {
  return `${faultText(fault)} stopped ${faultShardName(shard)} first`
}

/**
 * A `timeout:` firing's m (b.uqm SR-14.2): the shard's elapsed time since its
 * container start, rounded up to whole minutes (3 s gives 1, exactly 60 s
 * gives 1, 60.001 s gives 2), and at least 1. Not SR-4.3's halves-up rounding,
 * which is for limits.
 */
export function faultTimeoutMinutes(elapsedMs: number): number {
  return Math.max(1, Math.ceil(elapsedMs / MS_PER_MINUTE))
}

/** What the controller hands its one handler: a `timeout:` or `kill:` firing to carry out, or a fault poll's find of shard k's end marker, so its final reading can be taken now (b.uqm SR-10.6). */
export type FaultNotice =
  | {
      readonly kind: 'decision'
      readonly decision: FaultDecision
    }
  | {
      readonly kind: 'end-marker'
      readonly shard: number
    }

/** The driver's one handler for the controller's notices. */
export type FaultNoticeHandler = (notice: FaultNotice) => void

/** What a fault controller is built from, and nothing else. */
export interface FaultControllerOptions {
  /** The normalized faults in order, `Invocation.faults`: the only source of activation (b.uqm SR-14.1). */
  readonly faults: readonly Fault[]
  readonly assignment: Assignment
  /** The clock and timers (`RunnerDeps.clock`): every fault poll is scheduled through them. */
  readonly clock: RunnerClock
  /** The run directory: shard k's result file is read from its `shard-<k>` subdirectory by E1's rule (`readResultFile`). */
  readonly runDir: string
  /** Receives every decision and end-marker notice. */
  readonly handler: FaultNoticeHandler
}

/**
 * The fault controller (b.uqm SR-14.1, SR-14.2, SR-14.3). E13 builds it
 * unconditionally once the shards are scheduled, reports what happens through
 * the `note*` entry points, and calls `finalize` after every shard's final
 * reading and retirement, before E11's checks.
 */
export interface FaultController {
  /** Every fault's firing record so far, in normalized fault order. */
  records(): readonly FiringRecord[]
  /** Shard k's `--fail` file names (see `shardFailFileNames`). */
  failFileNames(shard: number): readonly string[]
  /** A shard's start outcome (E9); a later outcome for the same shard changes nothing. A started shard with a due `timeout:` or `kill:` is polled. */
  noteShardStart(start: ShardStart): void
  /** The drift image's build outcome (E8). */
  noteDriftBuild(outcome: BuildOutcome): void
  /** The retag image's build outcome (E8). */
  noteRetagBuild(outcome: BuildOutcome): void
  /** The `-test` tag's move (E8). */
  noteTagMove(outcome: TagMoveOutcome): void
  /** Shard k ended: its end marker found at a sample or a limit check, or its container ended on its own. */
  noteShardEnded(shard: number): void
  /** Shard k reached its wall-time limit. */
  noteShardLimit(shard: number): void
  /** A run-level stop: every started shard without an end state takes it, and every pending poll is cancelled. */
  noteRunStop(): void
  /** Ends the controller: fires each `fail:` whose script its shard reached, gives every still-due fault its reason, and answers every record, in normalized fault order. Idempotent. */
  finalize(): readonly FiringRecord[]
}

/** A fault's record while the controller holds it: due until it fires or gets its reason, then never changed. */
interface FaultSlot {
  readonly fault: Fault
  readonly shard: number | null
  readonly leakSourceShard: number | null
  state: FiringState
  reason: string | null
}

/** How a shard ended, as far as the faults are concerned. */
type FaultShardEnd =
  | {
      readonly kind: 'ended'
    }
  | {
      readonly kind: 'limit'
    }
  | {
      readonly kind: 'run-stopped'
    }
  | {
      readonly kind: 'never-started'
    }
  | {
      readonly kind: 'stopped-by-fault'
      readonly fault: TimeoutFault | KillFault
    }

/** A shard whose start was reported: its container start (null when it did not start) and its end state, the first event's (null while it runs). */
interface FaultShardState {
  readonly startedAtMs: number | null
  end: FaultShardEnd | null
}

/** The number forms of the scripts a result file shows in progress: a complete `start` line, no `end` line and no end marker (b.uqm SR-14.2). A missing or unreadable file shows none. */
function faultScriptsInProgress(read: ResultFileRead): string[] {
  if (read.kind !== 'events' || read.events.some((event) => event.kind === 'done')) return []
  const started = read.events.flatMap((event) => (event.kind === 'start' ? [event.fileName] : []))
  const ended = new Set(read.events.flatMap((event) => (event.kind === 'end' ? [event.fileName] : [])))
  return started.filter((fileName) => !ended.has(fileName)).flatMap((fileName) => fileNameNumberForm(fileName) ?? [])
}

/** The number forms of the scripts a result file holds the given complete line for, `start` or `end`, in file order. */
function faultScriptsWith(read: ResultFileRead, kind: 'start' | 'end'): string[] {
  if (read.kind !== 'events') return []
  return read.events.flatMap((event) => (event.kind === kind ? (fileNameNumberForm(event.fileName) ?? []) : []))
}

/** Whether a started shard has the `leak:<k>,<j>` mount: shard k's subdirectory, read-only, at `/leak-shard-<k>` (b.uqm SR-10.3). */
function hasFaultLeakMount(start: ShardStarted, runDir: string, sourceShard: number): boolean {
  const source = resolve(faultShardDir(runDir, sourceShard))
  return start.mounts.some((mount) => mount.readOnly && mount.target === leakMountTarget(sourceShard) && resolve(mount.source) === source)
}

/** Builds the fault controller: one record per fault, each due. With no faults it has no records, schedules no timer, reads no file and never calls its handler. */
export function createFaultController(options: FaultControllerOptions): FaultController {
  const { faults, assignment, clock, runDir, handler } = options
  const slots: FaultSlot[] = faults.map((fault) => ({
    fault,
    shard: faultTargetShard(fault, assignment),
    leakSourceShard: fault.kind === 'leak' ? fault.sourceShard : null,
    state: 'due',
    reason: null,
  }))
  const shards = new Map<number, FaultShardState>()
  const polls = new Map<number, unknown>()
  let driftImageId: string | null = null
  let runStopped = false
  let finalized = false

  function markFired(slot: FaultSlot): void {
    if (slot.state !== 'due') return
    slot.state = 'fired'
  }

  function markNotFired(slot: FaultSlot, reason: string): void {
    if (slot.state !== 'due') return
    slot.state = 'not-fired'
    slot.reason = reason
  }

  function dueSlots(kind: FaultKind, shard: number | null): FaultSlot[] {
    return slots.filter((slot) => slot.state === 'due' && slot.fault.kind === kind && (shard === null || slot.shard === shard))
  }

  function readShardResult(shard: number): ResultFileRead {
    return readResultFile(faultShardDir(runDir, shard))
  }

  function setEnd(shard: number, end: FaultShardEnd): void {
    const state = shards.get(shard)
    if (state === undefined || state.end !== null) return
    state.end = end
    cancelPoll(shard)
  }

  function cancelPoll(shard: number): void {
    if (!polls.has(shard)) return
    clock.clearTimeout(polls.get(shard))
    polls.delete(shard)
  }

  function cancelAllPolls(): void {
    for (const shard of [...polls.keys()]) cancelPoll(shard)
  }

  /** Polls shard k every fault-poll interval while it runs with a `timeout:` or `kill:` aimed at it still due. */
  function schedulePoll(shard: number): void {
    if (finalized || runStopped || polls.has(shard)) return
    const state = shards.get(shard)
    if (state === undefined || state.startedAtMs === null || state.end !== null) return
    if (dueSlots('timeout', shard).length === 0 && dueSlots('kill', shard).length === 0) return
    polls.set(
      shard,
      clock.setTimeout(() => poll(shard), FAULT_POLL_INTERVAL_MS),
    )
  }

  function poll(shard: number): void {
    polls.delete(shard)
    const state = shards.get(shard)
    if (finalized || state === undefined || state.end !== null) return
    decide(shard, state, readShardResult(shard))
    schedulePoll(shard)
  }

  /**
   * The decision step for one shard's reading (b.uqm SR-14.2). An end marker
   * ends the shard and is handed on. Otherwise, with a script in progress, a
   * due `kill:` fires before any `timeout:`, whatever the argument order
   * (b.uqm SR-2.2), since its moment is never later; else a due `timeout:`
   * whose script is in progress fires. A firing stops the shard for good.
   */
  function decide(shard: number, state: FaultShardState, read: ResultFileRead): void {
    if (read.kind === 'events' && read.events.some((event) => event.kind === 'done')) {
      setEnd(shard, { kind: 'ended' })
      handler({ kind: 'end-marker', shard })
      return
    }
    const inProgress = faultScriptsInProgress(read)
    if (inProgress.length === 0 || state.startedAtMs === null) return
    const kill = dueSlots('kill', shard)[0]
    if (kill !== undefined && kill.fault.kind === 'kill') {
      fire(shard, kill, kill.fault, { kind: 'killed', fixedByRunner: true })
      return
    }
    for (const slot of dueSlots('timeout', shard)) {
      if (slot.fault.kind !== 'timeout' || !inProgress.includes(slot.fault.script)) continue
      fire(shard, slot, slot.fault, { kind: 'wall-time-limit', minutes: faultTimeoutMinutes(clock.now() - state.startedAtMs), fixedByRunner: true })
      return
    }
  }

  function fire(shard: number, slot: FaultSlot, fault: TimeoutFault | KillFault, cause: ShardCause): void {
    markFired(slot)
    setEnd(shard, { kind: 'stopped-by-fault', fault })
    handler({ kind: 'decision', decision: { shard, fault, cause } })
  }

  function noteShardStart(start: ShardStart): void {
    if (finalized || shards.has(start.shard)) return
    const started = start.kind === 'started' ? start : null
    shards.set(start.shard, { startedAtMs: started?.startedAtMs ?? null, end: started === null ? { kind: 'never-started' } : null })
    for (const slot of [...dueSlots('leak', start.shard), ...dueSlots('image-drift', start.shard)]) {
      if (started === null) {
        markNotFired(slot, shardNeverStartedReason(start.shard))
        continue
      }
      const withIt =
        slot.leakSourceShard !== null ? hasFaultLeakMount(started, runDir, slot.leakSourceShard) : driftImageId !== null && started.imageId === driftImageId
      if (withIt) markFired(slot)
      else markNotFired(slot, shardStartedWithoutItReason(start.shard))
    }
    if (started !== null && runStopped) setEnd(start.shard, { kind: 'run-stopped' })
    schedulePoll(start.shard)
  }

  function noteDriftBuild(outcome: BuildOutcome): void {
    if (outcome.kind === 'built' && driftImageId === null) driftImageId = outcome.imageId
    if (outcome.kind !== 'failed') return
    for (const slot of dueSlots('image-drift', null)) markNotFired(slot, driftBuildFailedReason(outcome.exitCode))
  }

  function noteRetagBuild(outcome: BuildOutcome): void {
    if (outcome.kind !== 'failed') return
    for (const slot of dueSlots('retag', null)) markNotFired(slot, retagBuildFailedReason(outcome.exitCode))
  }

  function noteTagMove(outcome: TagMoveOutcome): void {
    for (const slot of dueSlots('retag', null)) {
      if (outcome.kind === 'moved') markFired(slot)
      else if (outcome.kind === 'failed') markNotFired(slot, tagMoveFailedReason(outcome.exitCode))
    }
  }

  function noteRunStop(): void {
    runStopped = true
    for (const [shard, state] of shards) if (state.startedAtMs !== null) setEnd(shard, { kind: 'run-stopped' })
    cancelAllPolls()
  }

  /** Shard k's result file as finalization reads it: once per shard, and only when needed. */
  const finalReads = new Map<number, ResultFileRead>()
  function finalRead(shard: number): ResultFileRead {
    let read = finalReads.get(shard)
    if (read === undefined) {
      read = readShardResult(shard)
      finalReads.set(shard, read)
    }
    return read
  }

  /**
   * The fired `fail:` in a shard that ended which stopped it before this
   * fault's moment could have come, or null: for a `fail:` whose script was not
   * reached; for a `timeout:` whose script has no `end` line; for a `kill:`
   * whose shard's first started script is the `fail:` script.
   */
  function failStopper(slot: FaultSlot, shard: number): Fault | null {
    const stopper = slots.find((other) => other.fault.kind === 'fail' && other.state === 'fired' && other.shard === shard)?.fault
    if (stopper === undefined || stopper.kind !== 'fail') return null
    switch (slot.fault.kind) {
      case 'fail':
        return stopper
      case 'timeout':
        return faultScriptsWith(finalRead(shard), 'end').includes(slot.fault.script) ? null : stopper
      case 'kill':
        return faultScriptsWith(finalRead(shard), 'start')[0] === stopper.script ? stopper : null
      default:
        return null
    }
  }

  /** A still-due fault's reason, from its shard's end state; a started shard with none counts as ended (b.uqm SR-14.3). */
  function reasonFor(slot: FaultSlot): string {
    const shard = slot.shard
    const state = shard === null ? undefined : shards.get(shard)
    if (shard === null || state === undefined) return runStoppedFirstReason()
    const end = state.end ?? { kind: 'ended' }
    switch (end.kind) {
      case 'never-started':
        return shardNeverStartedReason(shard)
      case 'stopped-by-fault':
        return faultStoppedShardFirstReason(end.fault, shard)
      case 'limit':
        return shardLimitReachedFirstReason(shard)
      case 'run-stopped':
        return runStoppedFirstReason()
      case 'ended': {
        const stopper = failStopper(slot, shard)
        return stopper === null ? shardEndedFirstReason(shard) : faultStoppedShardFirstReason(stopper, shard)
      }
    }
  }

  function records(): readonly FiringRecord[] {
    return slots.map((slot) => ({
      fault: slot.fault,
      shard: slot.shard,
      leakSourceShard: slot.leakSourceShard,
      state: slot.state,
      reason: slot.reason,
    }))
  }

  function finalize(): readonly FiringRecord[] {
    if (finalized) return records()
    finalized = true
    cancelAllPolls()
    // `fail:` fires on its script's complete `start` line in its shard (b.uqm SR-14.2, SR-11.3).
    for (const slot of dueSlots('fail', null)) {
      const state = slot.shard === null ? undefined : shards.get(slot.shard)
      if (slot.shard === null || state === undefined || state.startedAtMs === null || slot.fault.kind !== 'fail') continue
      if (faultScriptsWith(finalRead(slot.shard), 'start').includes(slot.fault.script)) markFired(slot)
    }
    // A reason rests only on end states and fired `fail:` faults, so the order of these does not matter.
    for (const slot of slots) if (slot.state === 'due') markNotFired(slot, reasonFor(slot))
    return records()
  }

  return {
    records,
    failFileNames: (shard) => shardFailFileNames(faults, assignment, shard),
    noteShardStart,
    noteDriftBuild,
    noteRetagBuild,
    noteTagMove,
    noteShardEnded: (shard) => setEnd(shard, { kind: 'ended' }),
    noteShardLimit: (shard) => setEnd(shard, { kind: 'limit' }),
    noteRunStop,
    finalize,
  }
}

// ---------------------------------------------------------------------------
// 17. Run lifecycle (E1 steps 1–2, E13 the rest)
// ---------------------------------------------------------------------------

// --- 17/T5 (E1 T5): run-sequence steps 1–2: the run directory, the status file, the log's first line, the argument stage ---

/** A run from the end of step 1 on: the run directory exists and holds the status file and the runner log's first line. */
export interface RunContext {
  readonly runId: string
  /** The run directory, as `runDirPath` derives it from the injected environment (b.uqm SR-5.1). */
  readonly runDir: string
  /** The `/ci` arguments as given (b.uqm SR-2.1). */
  readonly args: readonly string[]
  /** The runner log: everything the run reports goes through it (b.uqm SR-5.4). */
  readonly log: RunnerLogWriter
  /** What every status write of the run shares; E13 replaces it when the deadline moves (b.uqm SR-5.5). */
  basis: StatusBasis
}

/** The `usage: ` line of a runner whose first argument is missing or is not a RUN_ID, naming the argument (b.uqm SR-5.1). */
export function usageLine(firstArgument: string | undefined): string {
  const why = firstArgument === undefined ? 'the RUN_ID is missing' : `${shownArgument(firstArgument)} is not a RUN_ID`
  return `${USAGE_PREFIX}bun ${RUNNER_PATH_SUFFIX} <RUN_ID> [/ci arguments]: ${why}: a RUN_ID is <YYYYMMDD>t<HHMMSS>z-<suffix>, a real UTC moment, then 8 lowercase letters or digits`
}

/** The line of a runner that finds something already at its run directory's path, naming the path (b.uqm SR-5.1). */
export function existingPathLine(path: string): string {
  return `ci-run: ${shownArgument(path)} already exists: a run directory is never reused; launch the run again with a new RUN_ID`
}

/** The line of a runner whose run directory could not be created for any other reason, naming the path. */
export function runDirectoryFailedLine(path: string, error: string): string {
  return `ci-run: creating the run directory ${shownArgument(path)} failed: ${error}`
}

/** What creating the run directory found: created, something already at the path, or another failure on one line. */
export type RunDirectoryCreation =
  | {
      readonly kind: 'created'
    }
  | {
      readonly kind: 'exists'
    }
  | {
      readonly kind: 'failed'
      readonly error: string
    }

/**
 * Creates the run directory exclusively (b.uqm SR-5.1): one `mkdir`, never
 * recursive, which fails when anything is at the path (a file, a directory or
 * a symlink, dangling or not) and never follows or replaces it, so nothing is
 * written there.
 */
export function createRunDirectory(path: string): RunDirectoryCreation {
  try {
    mkdirSync(path, { mode: RUN_DIR_MODE })
    return { kind: 'created' }
  } catch (err) {
    return errnoCode(err) === 'EEXIST' ? { kind: 'exists' } : { kind: 'failed', error: dependencyErrorText(err) }
  }
}

/**
 * The rest of run-sequence step 1 once `createRunDirectory` has created the
 * run directory (b.uqm SR-5.1, SR-5.3, SR-5.4): sets its mode to exactly 0700,
 * whatever the umask took from `mkdir`'s; takes the run's start from the
 * clock; writes the status file in phase `build` with the deadline at start + B
 * (b.uqm SR-5.2, SR-5.5); then writes the runner log's first line. Throws on a
 * failure, before the first line is written; main then writes the first line
 * and the error to the log (b.uqm SR-5.4).
 */
export function beginRun(deps: RunnerDeps, runId: string, runDir: string, args: readonly string[], log: RunnerLogWriter): RunContext {
  chmodSync(runDir, RUN_DIR_MODE)
  const startMs = deps.clock.now()
  const basis: StatusBasis = {
    runId,
    pid: deps.pid,
    startMs,
    deadline: statusDeadline(startMs, BUILD_ALLOWANCE_MINUTES),
  }
  const written = writeStatusFile(runDir, buildStatus(basis, 'build'))
  if (!written.ok) throw new Error(written.error)
  log(formatRunnerLogFirstLine(runId, deps.pid, args))
  return { runId, runDir, args, log, basis }
}

/** Validation stage 1's outcome: the invocation, or the refusal its bad arguments give. */
export type ArgumentStage =
  | {
      readonly ok: true
      readonly invocation: Invocation
    }
  | {
      readonly ok: false
      readonly refusal: Refusal
    }

/**
 * Validation stage 1, the arguments (b.uqm SR-2.2, SR-2.4, SR-2.6): the first
 * bad argument's reason is the refusal's summary, and each other bad
 * argument's reason follows as one detail line, in argument order. The
 * refusal has no kind (b.uqm SR-5.8).
 */
export function argumentStage(args: readonly string[]): ArgumentStage {
  const parsed = parseCiArguments(args)
  if (parsed.ok) return { ok: true, invocation: parsed.invocation }
  const [first, ...rest] = parsed.failures
  if (first === undefined) throw new Error('argumentStage: the arguments were refused with no bad argument')
  return {
    ok: false,
    refusal: buildRefusal(
      null,
      first.reason,
      rest.map((failure) => failure.reason),
    ),
  }
}

/**
 * The error text of a valid invocation, which stops after validation until
 * E13 builds the rest of the run sequence. It is written as one `error: `
 * line, never a `NOT RUN: ` line; E13 removes it with the stop.
 */
export const STOPPED_AFTER_VALIDATION_TEXT =
  'the run stops after validation: steps 3 to 13 of the run sequence are not built yet, so nothing was checked, packed, locked, reserved or built'

/**
 * The run sequence from step 2 on (b.uqm SR-5.3), once step 1 is done.
 * Answers main's exit status. A refusal is recorded by `recordRefusal` as the
 * run's last act. Step 2 is E2's `validateRun`, over the worktree at
 * `deps.worktreeRoot` and the runner's environment; E13 replaces the stop
 * after validation with steps 3–13.
 */
export async function runSequence(deps: RunnerDeps, run: RunContext): Promise<number> {
  // Step 2: validation stages 1–8, the run's scripts, the units and the
  // effective N (b.uqm SR-2.6, SR-3.4). It spawns nothing and touches no
  // docker, lock, cgroup or reservation.
  const validation = validateRun(run.args, deps.worktreeRoot, deps.env)
  if (!validation.ok) return recordRefusal(run, validation.refusal)
  // E1's stop after validation. E13 replaces it, from here on, with steps
  // 3–13. Until then a valid invocation touches no docker, lock, cgroup or
  // reservation: it writes one error line to the runner log and exits 1.
  run.log.error(STOPPED_AFTER_VALIDATION_TEXT)
  return FAILURE_EXIT_STATUS
}

// --- 17/E13: the rest of the run sequence, stops and the end of run ---

// ---------------------------------------------------------------------------
// 18. Main entry (E1)
// ---------------------------------------------------------------------------

// --- 18/T5 (E1 T5): main, the refusal recorder and error capture ---

/**
 * Records a refusal as the run's last act (b.uqm SR-5.8): writes its
 * `NOT RUN: <reason>` line and each detail line to the runner log, then
 * replaces the status file with phase `refused` and the refusal. Nothing is
 * written after it. Answers the exit status main returns: `REFUSAL_EXIT_STATUS`,
 * or `FAILURE_EXIT_STATUS` when the status write failed, its error then in the
 * log. A caller first releases the lock and its reservation and removes the
 * containers, tags and images the run made (E5, E8, E13). Validation stage 1
 * calls it here, E2's stages 2–8 and E13's refusals likewise.
 */
export function recordRefusal(run: RunContext, refusal: Refusal): number {
  run.log(refusalLine(refusal))
  for (const detail of refusal.details) run.log(detail)
  const written = writeStatusFile(run.runDir, buildRefusedStatus(run.basis, refusal))
  if (written.ok) return REFUSAL_EXIT_STATUS
  run.log.error(written.error, 'recording the refusal')
  return FAILURE_EXIT_STATUS
}

/** What main tells its caller as it runs. */
export interface MainOptions {
  /** Told the runner log once step 1 has written its first line, so the entry block writes an uncaught error there (b.uqm SR-5.4). */
  readonly onRunLog?: (log: RunnerLogWriter) => void
}

/**
 * The runner (b.uqm SR-5.1, SR-5.3, SR-5.4), driven in process through its
 * dependencies. `argv` is the RUN_ID, then the `/ci` arguments as given.
 * Resolves with the exit status and never rejects; only the entry block
 * exits the process.
 *
 * - A first argument that is missing or not a RUN_ID: one `usage: ` line on
 *   standard error, nothing created, `USAGE_EXIT_STATUS` (64).
 * - Anything already at the run directory's path: one line on standard error
 *   naming the path, nothing written there, `FAILURE_EXIT_STATUS` (1); so too
 *   when the run directory cannot be created at all.
 * - Otherwise step 1, then `runSequence`: a refusal gives
 *   `REFUSAL_EXIT_STATUS` (2); until E13 a valid invocation gives 1.
 * - Any error met once the run directory exists is written to the runner log
 *   (after its first line) before main resolves with 1.
 */
export async function main(argv: readonly string[], deps: RunnerDeps, options: MainOptions = {}): Promise<number> {
  const stderrLine = (line: string): void => {
    try {
      deps.writeStderr(`${line}\n`)
    } catch {
      // Standard error is the last place left to report to.
    }
  }
  const [runId, ...args] = argv
  if (runId === undefined || !isRunId(runId)) {
    stderrLine(usageLine(runId))
    return USAGE_EXIT_STATUS
  }
  let runDir: string
  let created: RunDirectoryCreation
  try {
    runDir = runDirPath(deps.env, runId)
    created = createRunDirectory(runDir)
  } catch (err) {
    stderrLine(`ci-run: ${dependencyErrorText(err)}`)
    return FAILURE_EXIT_STATUS
  }
  if (created.kind === 'exists') {
    stderrLine(existingPathLine(runDir))
    return FAILURE_EXIT_STATUS
  }
  if (created.kind === 'failed') {
    stderrLine(runDirectoryFailedLine(runDir, created.error))
    return FAILURE_EXIT_STATUS
  }
  const logPath = join(runDir, RUNNER_LOG_FILE_NAME)
  const log = createRunnerLog(logPath, {
    onAppendError: (error) => stderrLine(`ci-run: appending to ${shownArgument(logPath)} failed: ${error}`),
  })
  let run: RunContext | null = null
  try {
    run = beginRun(deps, runId, runDir, args, log)
    options.onRunLog?.(log)
    return await runSequence(deps, run)
  } catch (err) {
    if (run === null) log(formatRunnerLogFirstLine(runId, deps.pid, args))
    log.error(err)
    return FAILURE_EXIT_STATUS
  }
}

// The one main-module entry block: the only top-level statement that is not
// a declaration, import or export, and the last thing in the file, so every
// declaration it reaches is already initialised. It binds the real
// dependencies, writes an uncaught exception or rejection to the runner log
// once the run directory exists (to standard error before that), runs main
// with the process arguments and exits with its status. Nothing here runs on
// import; the signal traps are E13's (b.uqm SR-1.3, SR-5.4).
if (import.meta.main) {
  let runLog: RunnerLogWriter | null = null
  const fail: (err: unknown, origin: string) => never = (err, origin) => {
    if (runLog !== null) runLog.error(err, origin)
    else writeSync(2, `ci-run: ${origin}: ${dependencyErrorText(err)}\n`)
    process.exit(FAILURE_EXIT_STATUS)
  }
  process.on('uncaughtException', (err) => fail(err, 'uncaught exception'))
  process.on('unhandledRejection', (reason) => fail(reason, 'unhandled rejection'))
  let deps: RunnerDeps
  try {
    deps = createRealRunnerDeps()
  } catch (err) {
    fail(err, 'binding the dependencies')
  }
  main(process.argv.slice(2), deps, {
    onRunLog: (log) => {
      runLog = log
    },
  }).then(
    (status) => process.exit(status),
    (err: unknown) => fail(err, 'main'),
  )
}
