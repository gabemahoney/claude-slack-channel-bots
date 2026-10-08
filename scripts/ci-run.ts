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
// E5 T1's admission lock: the account's home, the lock file's descriptor and its holder record.
import { closeSync, constants as fsConstants, fchmodSync, ftruncateSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
// E5 T2's reservations: the remover. The reader's listing and type check use
// `lstatSync` and `readdirSync`, imported once by E2 T1's worktree reader (section 7).
import { unlinkSync } from 'node:fs'
// E6 T3's /ci-live lock read: read-only, non-blocking, fstat'd, bounded, always closed.
// Aliased so that no other lane's import of the same names from node:fs collides with these bindings.
import {
  closeSync as closeCiLiveLock,
  constants as ciLiveLockFsConstants,
  fstatSync as fstatCiLiveLock,
  openSync as openCiLiveLock,
  readSync as readCiLiveLock,
} from 'node:fs'
// E6 T5's results-directory listing: entries and sizes by lstat, no link followed.
// Aliased so that no other lane's import of the same names from node:fs collides with these bindings.
import { lstatSync as lstatResultsEntry, readdirSync as listResultsDir } from 'node:fs'

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
  /** Its owner, read from its file name (E5 T2). */
  readonly owner: Owner
  readonly ownerAlive: boolean
}

/** A reservation file that cannot be used (b.uqm SR-6.2). */
export interface BadReservationFile {
  readonly fileName: string
  /** Its owner, read from its file name (E5 T2). */
  readonly owner: Owner
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

// --- 8/T1 (E4 T1): the duration table, its notes and the assignment ---
//
// The duration table's text, handed over unparsed by the image read-back
// (b.uqm SR-9.4), gives one estimate per script of the pinned image's list
// (b.uqm SR-4.1). Nothing in it ever drops a script: a bad line is ignored and
// noted, a script with no entry gets the default, and an unreadable table
// gives every script the default with one note. The run's units are then
// placed longest first in the shard with the smallest expected total
// (b.uqm SR-4.2). Every function here is pure. The table's line order counts:
// of two entries for one script the first is used, and a used line out of
// canonical order is noted. The order of the pinned list and of the units
// changes nothing.

/** The duration table's header line, `script<TAB>seconds` (b.uqm SR-4.1). */
export const DURATION_TABLE_HEADER = 'script\tseconds'

/**
 * The duration table as the image read-back hands it to scheduling
 * (b.uqm SR-4.1, SR-9.4): the file's text, missing, or unreadable with its
 * error. It is `readFileText`'s answer, so a read of the table copied out of
 * the pinned image hands over as is. A missing table is no read-back failure.
 */
export type DurationTableSource = FileTextRead

/** Why a table line other than the header is ignored (b.uqm SR-4.1). */
export type DurationLineProblem =
  | {
      /** The line holds a carriage return, so it matches no form. */
      readonly kind: 'carriage-return'
    }
  | {
      readonly kind: 'empty'
    }
  | {
      /** No tab separates the script from its seconds. */
      readonly kind: 'no-tab'
    }
  | {
      /** The text before the first tab is no number form `test-<n>`. */
      readonly kind: 'bad-script'
      readonly script: string
    }
  | {
      /** The text after the first tab is no whole number above 0, or one above `Number.MAX_SAFE_INTEGER`. */
      readonly kind: 'bad-seconds'
      readonly seconds: string
    }
  | {
      /** The script is already listed on an earlier line of the table's form. */
      readonly kind: 'repeated'
      readonly numberForm: string
      readonly firstLine: number
    }
  | {
      /** The script is not in the pinned image's list. */
      readonly kind: 'not-listed'
      readonly numberForm: string
    }

/** Every table note's opening words. */
const DURATION_TABLE_NOTE_PREFIX = `duration table ${DURATION_TABLE_PATH}`

/** The tail of each unreadable-table note: what every script gets instead. */
const DEFAULT_ESTIMATE_TEXT = `every script gets the default estimate, ${DEFAULT_ESTIMATE_SECONDS} s`

/** The note for a missing table (b.uqm SR-4.1, SR-9.4). */
export function durationTableMissingNote(): string {
  return `${DURATION_TABLE_NOTE_PREFIX} is missing: ${DEFAULT_ESTIMATE_TEXT}`
}

/** The note for a table that cannot be read, its error on one line (b.uqm SR-4.1). */
export function durationTableReadFailedNote(error: string): string {
  return `${DURATION_TABLE_NOTE_PREFIX} cannot be read (${dependencyErrorText(error)}): ${DEFAULT_ESTIMATE_TEXT}`
}

/** The note for a table whose first line is not the header: an empty file and a header holding a carriage return included (b.uqm SR-4.1). */
export function durationTableWrongHeaderNote(): string {
  return `${DURATION_TABLE_NOTE_PREFIX} is unreadable: line 1 is not the header ${JSON.stringify(DURATION_TABLE_HEADER)}: ${DEFAULT_ESTIMATE_TEXT}`
}

/** A line's field as a note shows it: JSON-quoted when it has leading or trailing spaces, so they stay visible; else as an argument is shown. */
function shownTableField(field: string): string {
  return field === field.trim() ? shownArgument(field) : JSON.stringify(field)
}

/** Why a line is ignored, as its note states it. */
function durationLineProblemText(problem: DurationLineProblem): string {
  switch (problem.kind) {
    case 'carriage-return':
      return 'it holds a carriage return'
    case 'empty':
      return 'it is empty'
    case 'no-tab':
      return 'no tab separates the script from its seconds'
    case 'bad-script':
      return `${shownTableField(problem.script)} is not a number form test-<n>, n a whole number`
    case 'bad-seconds':
      // The bound is named only for a whole number past it.
      return isWholeNumber(problem.seconds) && !Number.isSafeInteger(Number(problem.seconds))
        ? `seconds ${shownTableField(problem.seconds)} is not a whole number above 0 and at most ${Number.MAX_SAFE_INTEGER}`
        : `seconds ${shownTableField(problem.seconds)} is not a whole number above 0`
    case 'repeated':
      return `${problem.numberForm} is already listed on line ${problem.firstLine}`
    case 'not-listed':
      return `${problem.numberForm} is not in the test image's script list`
  }
}

/** The note for an ignored line, with its 1-based line number and why (b.uqm SR-4.1). */
export function durationLineIgnoredNote(line: number, problem: DurationLineProblem): string {
  return `${DURATION_TABLE_NOTE_PREFIX} line ${line} ignored: ${durationLineProblemText(problem)}`
}

/** The note for a used line out of canonical order: it sorts before the script of an earlier used line, named with that line (b.uqm SR-4.1, SR-3.3). */
export function durationLineOutOfOrderNote(line: number, numberForm: string, after: string, afterLine: number): string {
  return `${DURATION_TABLE_NOTE_PREFIX} line ${line} is out of canonical order: ${numberForm} follows ${after} on line ${afterLine}; its entry is used`
}

/** The duration table parsed against the pinned list (b.uqm SR-4.1). */
export interface DurationTable {
  /** Whether the table was read and its first line is the header. */
  readonly readable: boolean
  /** One estimate in seconds per script of the pinned list, keyed by file name, in canonical order. */
  readonly estimates: ReadonlyMap<string, number>
  /** The table's used entries, seconds keyed by number form, in canonical order: only pinned scripts' entries (T2's block takes them). */
  readonly entries: ReadonlyMap<string, number>
  /** The notes: one when the table is unreadable; else one per noted line, in line order. */
  readonly notes: readonly string[]
}

/** Splits a table's text into lines at each line feed; a final line feed ends the last line and may be absent (b.uqm SR-4.1). */
function durationTableLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * A seconds field's value: its digits as a Number when they are a whole number
 * above 0 that a Number holds exactly (at most `Number.MAX_SAFE_INTEGER`);
 * else null, so a longer digit string is malformed rather than rounded.
 */
function durationSeconds(text: string): number | null {
  if (!isWholeNumber(text)) return null
  const seconds = Number(text)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null
}

/** A table line's form: its number form and seconds, or the problem that makes it of no form. */
function durationLineForm(
  line: string,
): { readonly ok: true; readonly numberForm: string; readonly seconds: number } | { readonly ok: false; readonly problem: DurationLineProblem } {
  if (line.includes('\r')) return { ok: false, problem: { kind: 'carriage-return' } }
  if (line === '') return { ok: false, problem: { kind: 'empty' } }
  const tab = line.indexOf('\t')
  if (tab < 0) return { ok: false, problem: { kind: 'no-tab' } }
  const script = line.slice(0, tab)
  const seconds = line.slice(tab + 1)
  // A number form is built from its digits as typed, so the script text is its own number form.
  if (!NUMBER_FORM_PATTERN.test(script)) return { ok: false, problem: { kind: 'bad-script', script } }
  const value = durationSeconds(seconds)
  if (value === null) return { ok: false, problem: { kind: 'bad-seconds', seconds } }
  return { ok: true, numberForm: script, seconds: value }
}

/** The pinned file names in canonical order, each keyed by its number form; throws for a name that is no script file name. */
function pinnedByNumberForm(pinned: readonly string[]): Map<string, string> {
  const byNumberForm = new Map<string, string>()
  for (const fileName of sortCanonical(pinned)) {
    const numberForm = fileNameNumberForm(fileName)
    if (numberForm === null) throw new Error(`duration table: pinned name is no script file name: ${JSON.stringify(fileName)}`)
    byNumberForm.set(numberForm, fileName)
  }
  return byNumberForm
}

/**
 * Parses the duration table against the pinned image's script list, given as
 * file names (b.uqm SR-4.1). A missing or unreadable source, or a first line
 * that is not exactly the header, gives every script the default and one
 * note. Otherwise each other line is used when it is `test-<n><TAB><seconds>`
 * (seconds a whole number above 0, at most `Number.MAX_SAFE_INTEGER`), names a script no earlier line of that
 * form names, and names a pinned script; else it is ignored and noted. A used
 * line that sorts before an earlier used line is noted too. A pinned script
 * with no entry gets the default, without a note.
 */
export function parseDurationTable(source: DurationTableSource, pinned: readonly string[]): DurationTable {
  const byNumberForm = pinnedByNumberForm(pinned)
  const defaults = (note: string): DurationTable => ({
    readable: false,
    estimates: new Map([...byNumberForm.values()].map((fileName) => [fileName, DEFAULT_ESTIMATE_SECONDS])),
    entries: new Map(),
    notes: [note],
  })
  if (source.kind === 'missing') return defaults(durationTableMissingNote())
  if (source.kind === 'unreadable') return defaults(durationTableReadFailedNote(source.error))
  const lines = durationTableLines(source.text)
  if (lines[0] !== DURATION_TABLE_HEADER) return defaults(durationTableWrongHeaderNote())

  const notes: string[] = []
  /** Each number form listed on a line of the table's form, with that line's number. */
  const listedOn = new Map<string, number>()
  const used = new Map<string, number>()
  /** The used line whose script sorts last so far, for the order note. */
  let latest: { readonly numberForm: string; readonly line: number } | null = null
  for (const [index, text] of lines.entries()) {
    if (index === 0) continue
    const line = index + 1
    const form = durationLineForm(text)
    if (!form.ok) {
      notes.push(durationLineIgnoredNote(line, form.problem))
      continue
    }
    const firstLine = listedOn.get(form.numberForm)
    if (firstLine !== undefined) {
      notes.push(durationLineIgnoredNote(line, { kind: 'repeated', numberForm: form.numberForm, firstLine }))
      continue
    }
    listedOn.set(form.numberForm, line)
    if (!byNumberForm.has(form.numberForm)) {
      notes.push(durationLineIgnoredNote(line, { kind: 'not-listed', numberForm: form.numberForm }))
      continue
    }
    used.set(form.numberForm, form.seconds)
    if (latest !== null && compareCanonical(form.numberForm, latest.numberForm) < 0) {
      notes.push(durationLineOutOfOrderNote(line, form.numberForm, latest.numberForm, latest.line))
    } else {
      latest = { numberForm: form.numberForm, line }
    }
  }

  const estimates = new Map<string, number>()
  const entries = new Map<string, number>()
  for (const [numberForm, fileName] of byNumberForm) {
    const seconds = used.get(numberForm)
    estimates.set(fileName, seconds ?? DEFAULT_ESTIMATE_SECONDS)
    if (seconds !== undefined) entries.set(numberForm, seconds)
  }
  return { readable: true, estimates, entries, notes }
}

/** The scheduling entry point's inputs (b.uqm SR-4.1, SR-4.2); E13 passes them once, after the read-back. */
export interface SchedulingInput {
  /** The pinned image's script list, as file names, test-1 among them. */
  readonly pinned: readonly string[]
  /** The pinned image's duration table, unparsed. */
  readonly table: DurationTableSource
  /** The run's scheduling units (b.uqm SR-3.4). */
  readonly units: readonly SchedulingUnit[]
  /** The invocation: `--shard-timeout` sets every shard's limit (b.uqm SR-4.3). */
  readonly invocation: Invocation
  /** The admitted N: at least 1, at most the effective N. */
  readonly shards: number
}

/** The scheduling result: the parsed table, the assignment and the limits (b.uqm SR-4.1, SR-4.2, SR-4.3). */
export interface Schedule {
  /** Whether the table was read and its first line is the header. */
  readonly readable: boolean
  /** One estimate in seconds per pinned script, keyed by file name, in canonical order: its keys are the pinned list. */
  readonly estimates: ReadonlyMap<string, number>
  /** The table's used entries, seconds keyed by number form, in canonical order. */
  readonly entries: ReadonlyMap<string, number>
  /** The table notes, in their fixed order. */
  readonly notes: readonly string[]
  /** One entry per shard, from shard 1; each holds its limit in exact minutes. */
  readonly assignment: Assignment
  /** Each shard's limit as a duration on the clock, in whole milliseconds, keyed by shard number, from shard 1: what its limit timer is armed with. */
  readonly limitsMs: ReadonlyMap<number, number>
  /** T, the run's largest shard limit, in exact minutes (b.uqm SR-5.5). */
  readonly largestLimitMinutes: number
  /** T in whole milliseconds. */
  readonly largestLimitMs: number
}

/**
 * Assigns the units to shards by expected duration (b.uqm SR-4.2). Every
 * shard starts with test-1's estimate; units are taken longest first, ties in
 * the canonical order of each unit's first script, and each goes to the shard
 * with the smallest total, the lowest shard number on a tie. Each shard's list
 * is test-1, then its scripts in canonical order. With no units there is one
 * shard holding test-1 alone. Throws when N is above the number of units
 * holding a script, or 1 when there is none: the admitted N never is.
 */
export function assignShards(
  test1FileName: string,
  estimates: ReadonlyMap<string, number>,
  units: readonly SchedulingUnit[],
  shards: number,
  shardTimeoutMinutes: number | null,
): Assignment {
  if (!Number.isSafeInteger(shards) || shards < OPTION_RANGE_MIN) throw new Error(`assignShards: N is no whole number of at least ${OPTION_RANGE_MIN}: ${shards}`)
  const estimateOf = (script: Script): number => estimates.get(script.fileName) ?? DEFAULT_ESTIMATE_SECONDS
  const placed = units
    .map((unit) => {
      const scripts = [...unit.scripts].sort((a, b) => compareCanonicalNumbers(a.number, b.number))
      return { scripts, seconds: scripts.reduce((sum, script) => sum + estimateOf(script), 0) }
    })
    .filter((unit) => unit.scripts.length > 0)
    .sort((a, b) => b.seconds - a.seconds || compareCanonicalNumbers(a.scripts[0].number, b.scripts[0].number))

  const most = Math.max(OPTION_RANGE_MIN, placed.length)
  if (shards > most) throw new Error(`assignShards: N ${shards} is above ${most}, the most shards ${placed.length} units fill`)
  const test1Seconds = estimates.get(test1FileName) ?? DEFAULT_ESTIMATE_SECONDS
  const totals: number[] = Array.from({ length: shards }, () => test1Seconds)
  const members: Script[][] = Array.from({ length: shards }, () => [])
  for (const unit of placed) {
    let target = 0
    for (let k = 1; k < shards; k++) if (totals[k] < totals[target]) target = k
    totals[target] += unit.seconds
    members[target].push(...unit.scripts)
  }
  return members.map((scripts, index) => ({
    shard: index + 1,
    assigned: [test1FileName, ...scripts.sort((a, b) => compareCanonicalNumbers(a.number, b.number)).map((script) => script.fileName)],
    expectedSeconds: totals[index],
    limitMinutes: shardLimitMinutes(totals[index], shardTimeoutMinutes),
  }))
}

/**
 * The scheduling entry point (b.uqm SR-4.1, SR-4.2, SR-4.3): parses the
 * pinned image's duration table against its script list, assigns the run's
 * units to N shards, and gives each shard's limit and T, the largest. Throws
 * when the pinned list holds no test-1, which the read-back's checks have
 * already refused.
 */
export function scheduleRun(input: SchedulingInput): Schedule {
  const table = parseDurationTable(input.table, input.pinned)
  const test1 = numberFormOf(FIRST_SCRIPT_NUMBER)
  const test1FileName = input.pinned.find((fileName) => fileNameNumberForm(fileName) === test1)
  if (test1FileName === undefined) throw new Error(`scheduleRun: the pinned script list holds no ${test1}`)
  const timeout = input.invocation.shardTimeoutMinutes
  const assignment = assignShards(test1FileName, table.estimates, input.units, input.shards, timeout)
  const limitsMs = new Map(assignment.map((entry) => [entry.shard, shardLimitMs(entry.expectedSeconds, timeout)]))
  const largestLimitMs = Math.max(...limitsMs.values())
  return {
    readable: table.readable,
    estimates: table.estimates,
    entries: table.entries,
    notes: table.notes,
    assignment,
    limitsMs,
    largestLimitMinutes: largestLimitMs / MS_PER_MINUTE,
    largestLimitMs,
  }
}

// --- 8/T2 (E4 T2): shard limits, the limit timer, timing, the slow: lines and the duration-table block ---
//
// Each shard's wall-time limit and its own timer (b.uqm SR-4.3), and every
// run's timing values and report lines (b.uqm SR-4.4): E13 arms the timers and
// fills the timing record; E10 places the values and the ready lines in
// `results.json`, `summary.txt` and the timing summary (b.uqm SR-16.1,
// SR-16.2). Every duration is computed in whole milliseconds; only messages
// round, minutes halves up through `roundMinutesHalfUp`, seconds up.

/**
 * A shard's wall-time limit in whole milliseconds, a duration on the clock
 * (b.uqm SR-4.3): 2 × its expected total + 15 min, at least 30 min;
 * `--shard-timeout`'s minutes, with no floor, when given.
 */
export function shardLimitMs(expectedSeconds: number, shardTimeoutMinutes: number | null): number {
  if (shardTimeoutMinutes !== null) return shardTimeoutMinutes * MS_PER_MINUTE
  return Math.max(LIMIT_FLOOR_MINUTES * MS_PER_MINUTE, LIMIT_FACTOR * expectedSeconds * MS_PER_SECOND + LIMIT_ADDEND_MINUTES * MS_PER_MINUTE)
}

/**
 * A shard's wall-time limit in exact minutes (b.uqm SR-4.3), `shardLimitMs`
 * in minutes: one division of whole milliseconds, so a half minute is exact.
 * Only messages round it.
 */
export function shardLimitMinutes(expectedSeconds: number, shardTimeoutMinutes: number | null): number {
  return shardLimitMs(expectedSeconds, shardTimeoutMinutes) / MS_PER_MINUTE
}

/**
 * The cause the runner fixes for a shard over its limit (b.uqm SR-4.3,
 * SR-12.1): its minutes are the limit's, rounded halves up (93.4 gives 93,
 * 84.5 gives 85). E10 renders its text, `wall-time limit of <m> min exceeded`.
 */
export function wallTimeLimitCause(limitMinutes: number): WallTimeLimitCause {
  return { kind: 'wall-time-limit', minutes: roundMinutesHalfUp(limitMinutes), fixedByRunner: true }
}

/** `shard-<k>`: a shard's subdirectory name, and its name in a timing line (b.uqm Terms, SR-5.9). */
function scheduleShardName(shard: number): string {
  return `${SHARD_DIR_PREFIX}${shard}`
}

/** A limit timer's outcome when it fires (b.uqm SR-4.3, SR-10.6). */
export type LimitTimerOutcome =
  | {
      /** The result file's end marker line is complete: the shard is not over its limit, and its final reading is due now. */
      readonly kind: 'ended'
      readonly shard: number
    }
  | {
      /** Anything else (no file, an unreadable file, a partial last line, no marker): the shard is over its limit. */
      readonly kind: 'over-limit'
      readonly shard: number
    }

/** What one shard's limit timer is armed with. */
export interface LimitTimerOptions {
  /** The clock and timers (`RunnerDeps.clock`): the timer is scheduled only through them. */
  readonly clock: RunnerClock
  /** The run directory: the shard's result file is read from its `shard-<k>` subdirectory by E1's rule (`readResultFile`). */
  readonly runDir: string
  readonly shard: number
  /** The shard container's start, epoch milliseconds (`ShardStarted.startedAtMs`). */
  readonly startedAtMs: number
  /** The shard's limit in whole milliseconds (`Schedule.limitsMs`). */
  readonly limitMs: number
  /** Called once, when the timer fires, with its outcome; never after `cancel`. */
  readonly onFire: (outcome: LimitTimerOutcome) => void
}

/** An armed limit timer. */
export interface LimitTimer {
  /** Cancels it: it never fires after this. Idempotent, and harmless after it fired. */
  cancel(): void
}

/**
 * The runtime's largest timer delay: 2^31 − 1 ms, about 24.8 days, a signed
 * 32-bit count. Bun and Node run a timer asked for more after 1 ms, so a limit
 * timer never asks for more: a longer wait is taken in steps of at most this,
 * and the limit still fires at its own moment.
 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** A limit timer option's value as its error names it: a number as is, a string JSON-quoted, anything else as `String` gives it. */
function shownTimerValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/**
 * Arms one shard's limit timer (b.uqm SR-4.3): it fires at the container's
 * start + the limit, on its own timer, never waiting for a sample; armed after
 * that moment, it fires on the next timer tick, at least 1 ms later. When it
 * fires it reads the shard's result file and reports `ended` when the end
 * marker line is complete, else `over-limit`. It stops no container, fixes no
 * cause and writes nothing: E13 acts on the outcome. Throws when `startedAtMs`
 * or `limitMs` is no finite number, `limitMs` is negative, or `shard` is no
 * whole number of at least 1: a wiring mistake, never an over-limit shard.
 */
export function armShardLimitTimer(options: LimitTimerOptions): LimitTimer {
  const { clock, runDir, shard, onFire, startedAtMs, limitMs } = options
  if (!Number.isFinite(startedAtMs)) throw new Error(`armShardLimitTimer: startedAtMs ${shownTimerValue(startedAtMs)} is not a finite number`)
  if (!Number.isFinite(limitMs)) throw new Error(`armShardLimitTimer: limitMs ${shownTimerValue(limitMs)} is not a finite number`)
  if (limitMs < 0) throw new Error(`armShardLimitTimer: limitMs ${limitMs} is negative`)
  if (!Number.isInteger(shard) || shard < 1) throw new Error(`armShardLimitTimer: shard ${shownTimerValue(shard)} is not a whole number of at least 1`)
  const dueAtMs = startedAtMs + limitMs
  let handle: unknown = null
  let done = false

  function arm(): void {
    const remainingMs = Math.max(0, dueAtMs - clock.now())
    handle = clock.setTimeout(fire, Math.min(remainingMs, MAX_TIMER_DELAY_MS))
  }

  function fire(): void {
    handle = null
    if (done) return
    if (clock.now() < dueAtMs) {
      arm()
      return
    }
    done = true
    const read = readResultFile(join(runDir, scheduleShardName(shard)))
    const ended = read.kind === 'events' && read.events.some((event) => event.kind === 'done')
    onFire(ended ? { kind: 'ended', shard } : { kind: 'over-limit', shard })
  }

  arm()
  return {
    cancel(): void {
      done = true
      if (handle !== null) clock.clearTimeout(handle)
      handle = null
    },
  }
}

/** One shard's moments and result file, as E13 records them (b.uqm SR-4.4). */
export interface ShardTimingRecord {
  readonly shard: number
  /** Its container's start, epoch milliseconds; null when it never started. */
  readonly startedAtMs: number | null
  /** Its final reading's moment, epoch milliseconds; null when it had none (b.uqm SR-10.6). */
  readonly finalReadingAtMs: number | null
  /** Its result file as read at its final reading by E1's rule (`readResultFile`): its script outcomes and seconds. */
  readonly resultFile: ResultFileRead
}

/**
 * The timing record E13 fills (b.uqm SR-4.4): every moment in epoch
 * milliseconds from the injected clock. A step that never started is null; a
 * step that started and never ended runs to the verdict.
 */
export interface TimingRecord {
  /** The runner's start. */
  readonly runnerStartAtMs: number
  /** The start of packing; null when packing never started. */
  readonly packingStartAtMs: number | null
  /** The base-build step's own run: null when the step did not run; its end null when it never ended. */
  readonly baseBuild: {
    readonly startedAtMs: number
    readonly endedAtMs: number | null
  } | null
  /** The moment the pinned image ID is known; null when it never was. */
  readonly pinnedKnownAtMs: number | null
  /** One per shard of the assignment, in shard order; none when the run was never scheduled. */
  readonly shards: readonly ShardTimingRecord[]
  /** The verdict's moment. */
  readonly verdictAtMs: number
}

/** One shard's wall time. */
export interface ShardSeconds {
  readonly shard: number
  /** From its container's start to its final reading; null when either moment is missing. */
  readonly seconds: number | null
}

/** One script's wall time in one shard, to the millisecond (b.uqm SR-4.4, SR-11.3). */
export interface ScriptTime {
  readonly shard: number
  /** Its file name. */
  readonly script: string
  readonly result: ScriptResult
  /** Its time in whole milliseconds. */
  readonly ms: number
  /** Its time in seconds, three decimals at most: `ms` / 1000. */
  readonly seconds: number
}

/** The timing values (b.uqm SR-4.4, SR-16.1). */
export interface TimingValues {
  /** `timing`: every value a number. */
  readonly timing: ResultsTiming
  /** `shards[].seconds`, one per shard of the record, in shard order. */
  readonly shards: readonly ShardSeconds[]
  /** `scripts[].seconds`: each script with an `end` line, in shard order, then result-file order; test-1 once per shard. */
  readonly scripts: readonly ScriptTime[]
}

/** Whole milliseconds from one moment to a later one; never below 0. */
function elapsedMs(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round(toMs - fromMs))
}

/** Whole milliseconds in seconds. */
function msToSeconds(ms: number): number {
  return ms / MS_PER_SECOND
}

/** Whole milliseconds rounded up to whole seconds, in integer arithmetic: 35000 gives 35, 35001 gives 36, 0 gives 0. */
function ceilSeconds(ms: number): number {
  return Math.floor((ms + MS_PER_SECOND - 1) / MS_PER_SECOND)
}

/** A shard's script times from its result file's `end` lines, in file order, the first `end` line per script. */
function shardScriptTimes(record: ShardTimingRecord): ScriptTime[] {
  if (record.resultFile.kind !== 'events') return []
  const seen = new Set<string>()
  const times: ScriptTime[] = []
  for (const event of record.resultFile.events) {
    if (event.kind !== 'end' || seen.has(event.fileName)) continue
    seen.add(event.fileName)
    const ms = Math.round(event.seconds * MS_PER_SECOND)
    times.push({ shard: record.shard, script: event.fileName, result: event.result, ms, seconds: msToSeconds(ms) })
  }
  return times
}

/**
 * The timing values from the record (b.uqm SR-4.4). The build runs from the
 * start of packing to the moment the pinned ID is known, the base build
 * included; the base build is its step's own run, 0 when it did not run; the
 * total runs from the runner's start to the verdict. One rule makes every
 * value a number in every run: a step that never started counts 0, and a step
 * that started and never ended (a build whose pinned ID was never known, a
 * base build cut short) runs to the verdict. A shard's seconds are null when
 * its container start or its final reading is missing.
 */
export function timingValues(record: TimingRecord): TimingValues {
  const { packingStartAtMs, baseBuild, verdictAtMs } = record
  const buildMs = packingStartAtMs === null ? 0 : elapsedMs(packingStartAtMs, record.pinnedKnownAtMs ?? verdictAtMs)
  const baseBuildMs = baseBuild === null ? 0 : elapsedMs(baseBuild.startedAtMs, baseBuild.endedAtMs ?? verdictAtMs)
  const shards = [...record.shards].sort((a, b) => a.shard - b.shard)
  return {
    timing: {
      buildSeconds: msToSeconds(buildMs),
      baseBuildSeconds: msToSeconds(baseBuildMs),
      totalSeconds: msToSeconds(elapsedMs(record.runnerStartAtMs, verdictAtMs)),
    },
    shards: shards.map((shard) => ({
      shard: shard.shard,
      seconds: shard.startedAtMs === null || shard.finalReadingAtMs === null ? null : msToSeconds(elapsedMs(shard.startedAtMs, shard.finalReadingAtMs)),
    })),
    scripts: shards.flatMap(shardScriptTimes),
  }
}

/** `build: <s> s (base build <b> s)`: the build time with its base-build part (b.uqm SR-4.4, SR-16.2). */
export function buildTimeLine(buildSeconds: number, baseBuildSeconds: number): string {
  return `build: ${formatResultSeconds(buildSeconds)} s (base build ${formatResultSeconds(baseBuildSeconds)} s)`
}

/** `shard-<k>: <s> s`, or `shard-<k>: not timed` when its seconds are null (b.uqm SR-4.4, SR-16.2). */
export function shardTimeLine(shard: number, seconds: number | null): string {
  return `${scheduleShardName(shard)}: ${seconds === null ? 'not timed' : `${formatResultSeconds(seconds)} s`}`
}

/** `total: <s> s`: the runner's start to the verdict (b.uqm SR-4.4, SR-16.2). */
export function totalTimeLine(totalSeconds: number): string {
  return `total: ${formatResultSeconds(totalSeconds)} s`
}

/** `shard-<k> <file name>: <s> s (pass|fail)`: one script's time in one shard (b.uqm SR-4.4, SR-16.2). */
export function scriptTimeLine(time: ScriptTime): string {
  return `${scheduleShardName(time.shard)} ${time.script}: ${formatResultSeconds(time.seconds)} s (${time.result})`
}

/** The timing lines, in this order: the build time with its base-build part, each shard's time in shard order, the total (b.uqm SR-16.2). */
export function timingLines(values: TimingValues): string[] {
  return [
    buildTimeLine(values.timing.buildSeconds, values.timing.baseBuildSeconds),
    ...values.shards.map((shard) => shardTimeLine(shard.shard, shard.seconds)),
    totalTimeLine(values.timing.totalSeconds),
  ]
}

/** Each script's time line, in the values' order: shard order, then result-file order (b.uqm SR-16.2). */
export function scriptTimeLines(values: TimingValues): string[] {
  return values.scripts.map(scriptTimeLine)
}

/** Each script's highest time over the shards, in whole milliseconds, keyed by file name. */
function highestScriptMs(times: readonly ScriptTime[]): Map<string, number> {
  const highest = new Map<string, number>()
  for (const time of times) highest.set(time.script, Math.max(highest.get(time.script) ?? 0, time.ms))
  return highest
}

/** `slow: <file name> took <s> s, estimate <e> s`, s whole seconds rounded up (b.uqm SR-4.4). */
export function slowLine(fileName: string, tookSeconds: number, estimateSeconds: number): string {
  return `slow: ${fileName} took ${tookSeconds} s, estimate ${estimateSeconds} s`
}

/**
 * The `slow:` lines (b.uqm SR-4.4), in canonical order: one for each script
 * whose time is strictly more than 1.5 × its estimate (the default for a
 * script with none). A script in several shards, test-1, is judged and shown
 * once, with its highest time. A script with no recorded time has no line.
 */
export function slowLines(estimates: ReadonlyMap<string, number>, times: readonly ScriptTime[]): string[] {
  const lines: string[] = []
  const highest = highestScriptMs(times)
  for (const script of sortCanonical([...highest.keys()])) {
    const ms = highest.get(script) ?? 0
    const estimate = estimates.get(script) ?? DEFAULT_ESTIMATE_SECONDS
    if (ms > SLOW_FACTOR * estimate * MS_PER_SECOND) lines.push(slowLine(script, ceilSeconds(ms), estimate))
  }
  return lines
}

/** The line introducing the duration-table block, naming how many lines follow it (b.uqm SR-4.4). */
export function durationTableBlockIntro(blockLineCount: number): string {
  return `duration table block, the next ${blockLineCount} lines: paste them as ${DURATION_TABLE_PATH} to refresh the table`
}

/**
 * The duration-table block (b.uqm SR-4.4): the header, then one
 * `test-<n><TAB><seconds>` line per pinned script (the estimates' keys), in
 * canonical order: this run's time, rounded up to whole seconds and never
 * below 1, for a script that passed in every shard of the assignment holding
 * it (test-1: every shard), with its highest time; else the table's used
 * entry; else no line. Exactly `tests/ci-durations.tsv`'s lines; each ends in
 * a line feed when written. The introducing line is not part of it.
 */
export function durationTableBlock(schedule: Pick<Schedule, 'estimates' | 'entries' | 'assignment'>, times: readonly ScriptTime[]): string[] {
  const passedIn = new Map<string, Map<number, number>>()
  for (const time of times) {
    if (time.result !== 'pass') continue
    const shards = passedIn.get(time.script) ?? new Map<number, number>()
    shards.set(time.shard, Math.max(shards.get(time.shard) ?? 0, time.ms))
    passedIn.set(time.script, shards)
  }
  const lines = [DURATION_TABLE_HEADER]
  for (const fileName of sortCanonical([...schedule.estimates.keys()])) {
    const numberForm = fileNameNumberForm(fileName)
    if (numberForm === null) throw new Error(`durationTableBlock: pinned name is no script file name: ${JSON.stringify(fileName)}`)
    const holders = schedule.assignment.filter((entry) => entry.assigned.includes(fileName)).map((entry) => entry.shard)
    const passed = passedIn.get(fileName)
    const measuredMs =
      holders.length > 0 && passed !== undefined && holders.every((shard) => passed.has(shard)) ? Math.max(...holders.map((shard) => passed.get(shard) ?? 0)) : null
    const seconds = measuredMs !== null ? Math.max(1, ceilSeconds(measuredMs)) : schedule.entries.get(numberForm)
    if (seconds !== undefined) lines.push(`${numberForm}\t${seconds}`)
  }
  return lines
}

/** The timing report's values and ready lines; E10 places them in SR-16.2's order (b.uqm SR-4.4, SR-16.1, SR-16.2). */
export interface TimingReport {
  readonly values: TimingValues
  /** The build time with its base-build part, each shard's time, the total. */
  readonly timingLines: readonly string[]
  /** Each script's time. */
  readonly scriptLines: readonly string[]
  /** The introducing line, then the block; none for a run that was never scheduled. */
  readonly blockLines: readonly string[]
  readonly slowLines: readonly string[]
  /** The table notes; none for a run that was never scheduled. */
  readonly notes: readonly string[]
}

/**
 * The timing report from the record and the scheduling result (b.uqm SR-4.4).
 * A run that never got a pinned list, so was never scheduled (a build failure,
 * a stop before the read-back), passes null: it has no block, no `slow:`
 * lines and no table notes, and its timing values are numbers all the same.
 */
export function timingReport(record: TimingRecord, schedule: Schedule | null): TimingReport {
  const values = timingValues(record)
  const block = schedule === null ? [] : durationTableBlock(schedule, values.scripts)
  return {
    values,
    timingLines: timingLines(values),
    scriptLines: scriptTimeLines(values),
    blockLines: schedule === null ? [] : [durationTableBlockIntro(block.length), ...block],
    slowLines: schedule === null ? [] : slowLines(schedule.estimates, values.scripts),
    notes: schedule === null ? [] : schedule.notes,
  }
}

// ---------------------------------------------------------------------------
// 9. Lock, reservations and sweep (E5)
// ---------------------------------------------------------------------------

// --- 9/T1 (E5 T1): the account's home and the admission lock ---
//
// Admission happens one run at a time across every worktree, lane and session
// of the account (b.uqm SR-6.1). The lock is an exclusive `flock(2)` that the
// runner process itself holds on `admission.lock` in `.config/cscb-ci/` under
// the account's home, so the kernel frees it when the runner dies, and every
// worktree finds it at the same path.
//
// - The account's home comes from the first password-file line for the
//   runner's user ID (`accountHomeFrom`, the same rule as the test helper's
//   `passwdHomeFrom`), read through `RunnerDeps.readPasswordFile`; never from
//   `$HOME`, `os.homedir()` or `os.userInfo()`. Nothing here reads at import.
// - The flock is libc's, reached through `bun:ffi`, which is loaded, with
//   libc, on the first lock attempt. The lock file's descriptor is opened
//   close-on-exec, so no child holds it.
// - Take waits at most `LOCK_WAIT_MS` on the injected clock, retrying every
//   `LOCK_POLL_MS` with the last try at the wait's end exactly, then refuses
//   naming the holder recorded in the file. Once the flock is taken, the
//   runner's own `<RUN_ID>-<PID>` is written into the file in place, for
//   messages only: the flock alone decides who holds the lock.
// - The lock file is never renamed, replaced or removed: a new inode would let
//   two runs each hold "the" lock.
//
// E13 binds the real lock directory (`admissionLockDir` of the resolved home)
// at step 6, takes the lock there, and releases it at step 11 and on every
// refusal and stop that holds it. E6 takes the account's home from E13's
// composition for `/ci-live`'s real-run lock.

/** The admission lock's file name in the lock directory (b.uqm SR-6.1); never a reservation name. */
export const LOCK_FILE_NAME = 'admission.lock'
/** The lock directory below the account's home (b.uqm SR-6.1). */
export const LOCK_DIR_SUBPATH = '.config/cscb-ci'
/** How often take retries a busy lock on the injected clock, well under `LOCK_WAIT_MS`; the last try falls at the wait's end exactly. */
export const LOCK_POLL_MS = 250

/** A password-file entry's fields: at least seven, the user ID third and the home sixth (passwd(5)). */
const PASSWORD_ENTRY_FIELDS = 7
const PASSWORD_UID_FIELD = 2
const PASSWORD_HOME_FIELD = 5

/** The first password-file line whose user-ID field is exactly `uid` in decimal, split into its fields; undefined when there is none. */
function firstPasswordEntry(passwordText: string, uid: number): readonly string[] | undefined {
  if (typeof passwordText !== 'string' || !Number.isSafeInteger(uid) || uid < 0) return undefined
  const wanted = String(uid)
  for (const line of passwordText.split('\n')) {
    const fields = line.split(':')
    if (fields[PASSWORD_UID_FIELD] === wanted) return fields
  }
  return undefined
}

/** The home one password-file entry gives: its sixth field, when the entry has at least seven fields and that field is an absolute path. */
function passwordEntryHome(fields: readonly string[]): string | undefined {
  const home = fields[PASSWORD_HOME_FIELD]
  return fields.length >= PASSWORD_ENTRY_FIELDS && home !== undefined && isAbsolute(home) ? home : undefined
}

/**
 * The account's home by the password-file rule (b.uqm SR-6.1, SR-21.5): the
 * first line whose user-ID field equals `uid` written in decimal decides (a
 * leading zero or a space does not match); it gives its sixth field when it
 * has at least seven fields and that field is absolute, else undefined. A
 * later line for the same user ID is never used. Pure; the same rule as
 * `passwdHomeFrom` in `tests/test-helpers/host-safe-env.ts`.
 */
export function accountHomeFrom(passwordText: string, uid: number): string | undefined {
  const fields = firstPasswordEntry(passwordText, uid)
  return fields === undefined ? undefined : passwordEntryHome(fields)
}

/** Why the account's home could not be found: the password file unreadable, no line for the user ID, or a first such line that gives no home. */
export type AccountHomeFailure =
  | {
      readonly kind: 'unreadable'
      readonly error: string
    }
  | {
      readonly kind: 'no-entry'
    }
  | {
      readonly kind: 'no-home'
    }

/** The not-runnable refusal for an account's home that could not be found (kind null), naming the user ID and `/etc/passwd` (b.uqm SR-6.1). */
export function accountHomeRefusal(uid: number, failure: AccountHomeFailure): Refusal {
  const cause =
    failure.kind === 'unreadable'
      ? `${REAL_PASSWORD_FILE} could not be read: ${dependencyErrorText(failure.error)}`
      : failure.kind === 'no-entry'
        ? `${REAL_PASSWORD_FILE} has no line for user ID ${uid}`
        : `the first line of ${REAL_PASSWORD_FILE} for user ID ${uid} gives no absolute home in its sixth of at least seven fields`
  return buildRefusal(null, `the account's home for user ID ${uid} could not be found in ${REAL_PASSWORD_FILE}`, [cause])
}

/** The account's home, or the refusal that it could not be found. */
export type AccountHomeResolution =
  | {
      readonly ok: true
      readonly home: string
    }
  | {
      readonly ok: false
      readonly refusal: Refusal
    }

/** The account's home: the password file read through the injected dependency, by `accountHomeFrom` for the injected user ID (b.uqm SR-6.1). */
export function resolveAccountHome(deps: Pick<RunnerDeps, 'uid' | 'readPasswordFile'>): AccountHomeResolution {
  const text = deps.readPasswordFile()
  if (!text.ok) return { ok: false, refusal: accountHomeRefusal(deps.uid, { kind: 'unreadable', error: text.error }) }
  const fields = firstPasswordEntry(text.value, deps.uid)
  if (fields === undefined) return { ok: false, refusal: accountHomeRefusal(deps.uid, { kind: 'no-entry' }) }
  const home = passwordEntryHome(fields)
  if (home === undefined) return { ok: false, refusal: accountHomeRefusal(deps.uid, { kind: 'no-home' }) }
  return { ok: true, home }
}

/** The lock directory under an account's home, `<home>/.config/cscb-ci` (b.uqm SR-6.1). */
export function admissionLockDir(accountHome: string): string {
  return join(accountHome, LOCK_DIR_SUBPATH)
}

/** The lock file in a lock directory, `<lockDir>/admission.lock` (b.uqm SR-6.1). */
export function admissionLockPath(lockDir: string): string {
  return join(lockDir, LOCK_FILE_NAME)
}

/** The lock file's holder record: the holder's `<RUN_ID>-<PID>` and a line feed. */
export function formatLockHolder(holder: Owner): string {
  return `${formatOwner(holder)}\n`
}

/** The holder a lock file's text records: one `<RUN_ID>-<PID>` line, its line feed optional; null for any other text. */
export function parseLockHolder(text: string): Owner | null {
  const line = text.endsWith('\n') ? text.slice(0, -1) : text
  if (LINE_BREAK_PATTERN.test(line)) return null
  return parseOwner(line)
}

/** The busy-lock refusal (b.uqm SR-6.8), kind null, naming the PID and RUN_ID recorded in the lock file; an unknown holder when none could be read. */
export function busyLockRefusal(holder: Owner | null): Refusal {
  const named = holder === null ? 'an unknown run holds it' : `run ${holder.runId} (PID ${holder.pid}) holds it`
  return buildRefusal(null, `the admission lock stayed busy for ${LOCK_WAIT_MS / 1000} s: ${named}`, [
    'another /ci run is being admitted; try again once its admission is done',
  ])
}

/** libc's `flock` operations (`<sys/file.h>`). */
const LIBC_LOCK_EXCLUSIVE = 2
const LIBC_LOCK_NON_BLOCKING = 4
const LIBC_LOCK_UNLOCK = 8
/** The C library `flock` is loaded from. */
const LIBC_FILE_NAME = 'libc.so.6'
/** Linux's `O_CLOEXEC`, which `node:fs` constants do not export: no child inherits the descriptor. */
const OPEN_CLOSE_ON_EXEC = 0o2000000
/** How many times one lock try repeats a `flock` a signal interrupted. */
const FLOCK_INTERRUPTED_TRIES = 3
/** The most of a lock file's text read for its holder record. */
const LOCK_RECORD_MAX_BYTES = 4096

/** libc's `flock` and the calling thread's `errno`. */
interface LibcFlock {
  flock(fd: number, operation: number): number
  errno(): number
}

let libcFlockBinding: LibcFlock | null = null

/** libc's `flock`, with `bun:ffi` and libc loaded on first use, never at import. Throws when libc cannot be loaded. */
function libcFlock(): LibcFlock {
  if (libcFlockBinding === null) {
    const ffi = require('bun:ffi') as typeof import('bun:ffi')
    const libc = ffi.dlopen(LIBC_FILE_NAME, {
      flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
      __errno_location: { args: [], returns: ffi.FFIType.ptr },
    })
    libcFlockBinding = {
      flock: (fd, operation) => libc.symbols.flock(fd, operation),
      errno: () => {
        const at = libc.symbols.__errno_location()
        return at === null ? 0 : ffi.read.i32(at, 0)
      },
    }
  }
  return libcFlockBinding
}

/** An errno's name, such as `ENOLCK`, or its number. */
function errnoName(errno: number): string {
  const entry = Object.entries(osConstants.errno).find(([, value]) => value === errno)
  return entry === undefined ? `errno ${errno}` : entry[0]
}

/** One exclusive, non-blocking flock try: taken; held by another descriptor; or failed for another reason, never reported as held. */
export type FlockAttempt =
  | {
      readonly kind: 'taken'
    }
  | {
      readonly kind: 'held'
    }
  | {
      readonly kind: 'error'
      readonly error: string
    }

/** An open lock file: one close-on-exec, read-write descriptor that flocks and records the holder in place. */
export interface LockFile {
  readonly path: string
  /** Whether opening it created the file. */
  readonly created: boolean
  /** Tries an exclusive, non-blocking flock on the descriptor. */
  tryLock(): FlockAttempt
  /** The file's text (at most 4 KiB of it), read through the descriptor. */
  readText(): DepRead<string>
  /** Replaces the file's text in place through the descriptor: same inode, never a rename. */
  writeText(text: string): DepRead<null>
  /** Unlocks and closes the descriptor; later calls do nothing, and later tries and reads fail. */
  release(): void
}

/** Opens a lock file read-write and close-on-exec, creating it 0600 when missing; throws on failure. */
function openLockDescriptor(path: string): { fd: number; created: boolean } {
  const flags = fsConstants.O_RDWR | OPEN_CLOSE_ON_EXEC
  try {
    const fd = openSync(path, flags | fsConstants.O_CREAT | fsConstants.O_EXCL, WRITTEN_FILE_MODE)
    try {
      fchmodSync(fd, WRITTEN_FILE_MODE)
    } catch (err) {
      closeSync(fd)
      throw err
    }
    return { fd, created: true }
  } catch (err) {
    if (errnoCode(err) !== 'EEXIST') throw err
  }
  return { fd: openSync(path, flags), created: false }
}

/**
 * The flock primitive (b.uqm SR-6.1): opens `path` on a descriptor no child
 * inherits, creating the file 0600 when it is missing (an existing file is
 * used as it is), or answers why it could not. Locking loads libc on first
 * use. Two descriptors on one file contend, in one process as in two.
 */
export function openLockFile(path: string): DepRead<LockFile> {
  let opened: { fd: number; created: boolean }
  try {
    opened = openLockDescriptor(path)
  } catch (err) {
    return { ok: false, error: `the lock file could not be opened: ${dependencyErrorText(err)}` }
  }
  let fd: number | null = opened.fd
  const releasedError = `the lock file is released: ${path}`
  return {
    ok: true,
    value: {
      path,
      created: opened.created,
      tryLock() {
        if (fd === null) return { kind: 'error', error: releasedError }
        let libc: LibcFlock
        try {
          libc = libcFlock()
        } catch (err) {
          return { kind: 'error', error: `flock could not be loaded: ${dependencyErrorText(err)}` }
        }
        let errno = 0
        for (let attempt = 0; attempt < FLOCK_INTERRUPTED_TRIES; attempt++) {
          if (libc.flock(fd, LIBC_LOCK_EXCLUSIVE | LIBC_LOCK_NON_BLOCKING) === 0) return { kind: 'taken' }
          errno = libc.errno()
          if (errno === osConstants.errno.EWOULDBLOCK) return { kind: 'held' }
          if (errno !== osConstants.errno.EINTR) break
        }
        return { kind: 'error', error: `flock failed on ${path}: ${errnoName(errno)}` }
      },
      readText() {
        if (fd === null) return { ok: false, error: releasedError }
        try {
          const bytes = new Uint8Array(LOCK_RECORD_MAX_BYTES)
          const count = readSync(fd, bytes, 0, bytes.length, 0)
          return { ok: true, value: new TextDecoder().decode(bytes.subarray(0, count)) }
        } catch (err) {
          return { ok: false, error: `the lock file could not be read: ${dependencyErrorText(err)}` }
        }
      },
      writeText(text) {
        if (fd === null) return { ok: false, error: releasedError }
        try {
          const bytes = new TextEncoder().encode(text)
          let written = 0
          while (written < bytes.length) {
            const count = writeSync(fd, bytes, written, bytes.length - written, written)
            if (count <= 0) throw new Error(`no bytes written to ${path}`)
            written += count
          }
          ftruncateSync(fd, bytes.length)
          return { ok: true, value: null }
        } catch (err) {
          return { ok: false, error: `the lock file could not be written: ${dependencyErrorText(err)}` }
        }
      },
      release() {
        if (fd === null) return
        const held = fd
        fd = null
        // libc is loaded only once a try was made; before that no flock can be held.
        libcFlockBinding?.flock(held, LIBC_LOCK_UNLOCK)
        try {
          closeSync(held)
        } catch {
          // Closing frees the flock in any case; there is nothing to report on a release path.
        }
      },
    },
  }
}

/** Creates the lock directory 0700 when missing (its missing parents too); an existing one is used as it is. */
function ensureLockDir(lockDir: string): DepRead<null> {
  try {
    const created = mkdirSync(lockDir, { recursive: true, mode: RUN_DIR_MODE })
    if (created !== undefined) chmodSync(lockDir, RUN_DIR_MODE)
    return { ok: true, value: null }
  } catch (err) {
    return { ok: false, error: `the lock directory could not be created: ${dependencyErrorText(err)}` }
  }
}

/** A held admission lock. */
export interface AdmissionLock {
  /** The lock file's path. */
  readonly path: string
  /** Unlocks and closes; the file stays where it is. A second call does nothing, so refusal and stop paths may call it freely. */
  release(): void
}

/**
 * What take found: the lock taken; busy past the wait, with the recorded
 * holder (null when unreadable) and the busy-lock refusal; or an error
 * creating, opening, locking or recording, which is not busy and was never
 * retried as busy.
 */
export type LockTake =
  | {
      readonly kind: 'taken'
      readonly lock: AdmissionLock
    }
  | {
      readonly kind: 'busy'
      readonly holder: Owner | null
      readonly refusal: Refusal
    }
  | {
      readonly kind: 'error'
      readonly error: string
    }

/** Waits `delayMs` on the injected clock. */
function clockDelay(clock: RunnerClock, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, delayMs)
  })
}

/**
 * Takes the admission lock in `lockDir` for `holder` (b.uqm SR-6.1): creates
 * the directory (0700) and the file (0600) when missing, tries the flock at
 * once and then every `LOCK_POLL_MS` on `clock` until `LOCK_WAIT_MS` has
 * passed, the last try at that mark exactly, and once taken records the
 * holder in the file in place. A free lock is taken with no wait, whatever the
 * file records. Never resolves rejected.
 */
export async function takeAdmissionLock(lockDir: string, holder: Owner, clock: RunnerClock): Promise<LockTake> {
  const dir = ensureLockDir(lockDir)
  if (!dir.ok) return { kind: 'error', error: dir.error }
  const opened = openLockFile(admissionLockPath(lockDir))
  if (!opened.ok) return { kind: 'error', error: opened.error }
  const file = opened.value
  const deadline = clock.now() + LOCK_WAIT_MS
  for (;;) {
    const attempt = file.tryLock()
    if (attempt.kind === 'taken') {
      const recorded = file.writeText(formatLockHolder(holder))
      if (!recorded.ok) {
        file.release()
        return { kind: 'error', error: recorded.error }
      }
      return { kind: 'taken', lock: { path: file.path, release: () => file.release() } }
    }
    if (attempt.kind === 'error') {
      file.release()
      return { kind: 'error', error: attempt.error }
    }
    const left = deadline - clock.now()
    if (left <= 0) {
      const text = file.readText()
      const recordedHolder = text.ok ? parseLockHolder(text.value) : null
      file.release()
      return { kind: 'busy', holder: recordedHolder, refusal: busyLockRefusal(recordedHolder) }
    }
    await clockDelay(clock, Math.min(LOCK_POLL_MS, left))
  }
}

// --- 9/T2 (E5 T2): reservations: write, remove and read ---
//
// A reservation is `<RUN_ID>-<PID>.json` in the lock directory (b.uqm SR-6.2).
// Its names, shape, serializer and parser are E1's (section 5, T3); this
// sub-banner writes, removes and reads the files. Holding the lock while
// writing is the caller's duty (E13, step 10). None of these touches any file
// in the lock directory whose name is not the reservation name in question.

/** What a reservation records for one run: its owner, N, the per-shard cap and the run kind (b.uqm SR-6.2). */
export interface ReservationRequest {
  readonly owner: Owner
  /** N. */
  readonly shards: number
  /** The per-shard memory cap in bytes. */
  readonly memoryCapBytes: number
  readonly kind: RunKind
}

/** The reservation a spec gives: memory N × the cap, CPUs `CPUS_PER_SHARD` × N (b.uqm SR-6.2). */
export function buildReservation(spec: ReservationRequest): Reservation {
  return {
    version: RESERVATION_FORMAT_VERSION,
    runId: spec.owner.runId,
    pid: spec.owner.pid,
    shards: spec.shards,
    memoryBytes: spec.shards * spec.memoryCapBytes,
    cpus: CPUS_PER_SHARD * spec.shards,
    kind: spec.kind,
  }
}

/**
 * Writes the owner's reservation into `lockDir` whole (b.uqm SR-6.2): E1's
 * `writeWholeFile` writes `reservationTempFileName(owner)`, which is never a
 * reservation name, then renames it to `reservationFileName(owner)`, so the
 * reservation-named file appears only by the rename. A failure is returned,
 * never thrown: a spec the serializer refuses writes nothing, and a failed
 * write leaves no reservation-named file of its own and removes its temporary
 * file where it can. The caller holds the lock and decides how the run ends.
 */
export function writeReservation(lockDir: string, spec: ReservationRequest): WriteResult {
  const fileName = reservationFileName(spec.owner)
  let text: string
  try {
    text = serializeReservation(buildReservation(spec))
  } catch (err) {
    return { ok: false, error: `writing ${join(lockDir, fileName)} failed: ${dependencyErrorText(err)}` }
  }
  return writeWholeFile(lockDir, fileName, text)
}

/** A reservation removal's outcome: removed, already gone (no failure), or failed with its cleanup-failure line (b.uqm SR-9.3). */
export type ReservationRemoval =
  | {
      readonly kind: 'removed'
    }
  | {
      readonly kind: 'absent'
    }
  | {
      readonly kind: 'failed'
      /** The cleanup-failure line, already written to the runner log; the caller lists it (`RunState.cleanupFailures`). */
      readonly line: string
    }

/**
 * Removes one owner's reservation from `lockDir` (b.uqm SR-6.2): E13's own in
 * cleanup and refusals, T3's sweep for dead owners. A file already gone is no
 * failure. Any other failure is written to the runner log and returned as a
 * cleanup failure, never thrown (b.uqm SR-9.3).
 */
export function removeReservation(lockDir: string, owner: Owner, log: RunnerLogSink): ReservationRemoval {
  const path = join(lockDir, reservationFileName(owner))
  try {
    unlinkSync(path)
    return { kind: 'removed' }
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { kind: 'absent' }
    const line = `removing reservation ${path} failed: ${dependencyErrorText(err)}`
    log(line)
    return { kind: 'failed', line }
  }
}

/** One reservation-named entry as read: valid, bad with its reason, or gone since the listing. */
type ReservationEntryRead =
  | {
      readonly kind: 'valid'
      readonly reservation: Reservation
    }
  | {
      readonly kind: 'bad'
      readonly reason: string
    }
  | {
      readonly kind: 'gone'
    }

/** Reads and parses one reservation-named entry. Only a regular file is read, never through a link; a parsed file whose `runId` and `pid` are not its file name's owner is bad. */
function readReservationEntry(path: string, owner: Owner): ReservationEntryRead {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false })
    if (stats === undefined) return { kind: 'gone' }
    if (!stats.isFile()) return { kind: 'bad', reason: 'not a regular file' }
  } catch (err) {
    return { kind: 'bad', reason: dependencyErrorText(err) }
  }
  const read = readFileText(path)
  if (read.kind === 'missing') return { kind: 'gone' }
  if (read.kind === 'unreadable') return { kind: 'bad', reason: read.error }
  const parsed = parseReservation(read.text)
  if (!parsed.ok) return { kind: 'bad', reason: parsed.error }
  const named = { runId: parsed.value.runId, pid: parsed.value.pid }
  if (named.runId !== owner.runId || named.pid !== owner.pid) {
    return { kind: 'bad', reason: `it names the owner ${formatOwner(named)}, not its file name's ${formatOwner(owner)}` }
  }
  return { kind: 'valid', reservation: parsed.value }
}

/**
 * Reads every reservation in `lockDir` (b.uqm SR-6.2), for T3's sweep and E6's
 * admission readings; it removes nothing and formats no refusal.
 * - Only reservation names are read (`reservationOwnerFromFileName`); every
 *   other entry, `admission.lock` and temporary write names among them, is
 *   ignored.
 * - Each entry carries its owner, read from its file name, and that owner's
 *   liveness (E1's `isOwnerAlive`, b.uqm SR-6.3).
 * - Valid: parsed by E1's `parseReservation`, naming its file name's owner.
 *   Bad: not a regular file, unreadable, unparseable, of another version or
 *   shape, or naming another owner, with its reason on one line.
 * - An entry gone by the time it is read is absent, with no error.
 * - A directory that cannot be listed is `{ kind: 'failed', error }`, the
 *   error on one line; E6 turns it into a failed reading, T3 into a cleanup
 *   failure.
 * Both lists are in file-name order.
 */
export function readReservations(lockDir: string, probe: OwnerLivenessProbe): ReservationListing {
  let names: string[]
  try {
    names = readdirSync(lockDir)
  } catch (err) {
    return { kind: 'failed', error: dependencyErrorText(err) }
  }
  const valid: ListedReservation[] = []
  const bad: BadReservationFile[] = []
  for (const fileName of names.sort()) {
    const owner = reservationOwnerFromFileName(fileName)
    if (owner === null) continue
    const entry = readReservationEntry(join(lockDir, fileName), owner)
    if (entry.kind === 'gone') continue
    const ownerAlive = isOwnerAlive(owner, probe)
    if (entry.kind === 'valid') valid.push({ fileName, reservation: entry.reservation, owner, ownerAlive })
    else bad.push({ fileName, owner, ownerAlive, reason: entry.reason })
  }
  return { kind: 'listed', valid, bad }
}

// --- 9/T3 (E5 T3): the sweep and the image-removal primitives ---
//
// The image-removal primitives (b.uqm SR-9.3), which E8's cleanup reuses, and
// the sweep of dead runs' leftovers (b.uqm SR-6.4), which E13 calls at step 7
// under the lock.
//
// Only two kinds of image removal exist, both held here:
// - `removeRunPrivateTag`: one run-private tag removed by its name, the tag
//   built from an owner and a role, so it can never be an ID, a digest or a
//   tag of any other shape;
// - `removeOwnerUntaggedImages`: a listing of untagged images carrying exactly
//   one owner label, then, only when it found one, a prune of untagged images
//   filtered on that label, retried `PRUNE_RETRIES` times `PRUNE_RETRY_INTERVAL_MS`
//   apart on the injected clock while Docker answers it is already running.
// Neither forces. Each writes its failure to the runner log and returns the
// cleanup-failure line (`RunState.cleanupFailures`); none throws, and a runner
// log sink that throws loses only its line.
//
// The sweep lists (`listSweepLeftovers`), selects (`selectSweepLeftovers`,
// pure) and removes (`sweepLeftovers`) in the fixed order: containers,
// reservations, tags, untagged images. It never refuses the run, and touches
// no file but dead owners' reservations in the lock directory: never the
// system temp directory nor any run directory.

/** Writes a cleanup-failure line to the runner log; a sink that throws loses only this line, so no failure is thrown past the caller. */
function logCleanupFailure(log: RunnerLogSink, line: string): string {
  try {
    log(line)
  } catch {
    // The line is still returned and listed; the log's own failure is not the sweep's.
  }
  return line
}

/** A run-private tag removal's outcome: removed, already gone (no failure), or failed with its cleanup-failure line, already logged. */
export type RunPrivateTagRemoval =
  | {
      readonly kind: 'removed'
    }
  | {
      readonly kind: 'absent'
    }
  | {
      readonly kind: 'failed'
      /** The cleanup-failure line, already written to the runner log; the caller lists it (`RunState.cleanupFailures`). */
      readonly line: string
    }

/**
 * Removes one run-private tag by its name (b.uqm SR-9.3, SR-6.4): the tag
 * `cscb-ci-run:<RUN_ID>-<PID>-<role>` built from `tag`'s owner and role,
 * through E1's tag-removal form, never forced. Docker deletes the image with
 * its last tag when no container uses it (b.uqm SR-23.6). A tag Docker does
 * not know is absent, not a failure. Any other failure is written to the
 * runner log as `removing image tag <tag> failed: <error>` and returned.
 */
export async function removeRunPrivateTag(docker: DockerContext, tag: RunTag, log: RunnerLogSink): Promise<RunPrivateTagRemoval> {
  const name = formatRunTag(tag.owner, tag.role)
  const removed = await removeImageTag(docker, name)
  if (removed.ok) return { kind: 'removed' }
  if (removed.exitCode !== null && removed.error.includes(DOCKER_NO_SUCH_IMAGE_TEXT)) return { kind: 'absent' }
  return { kind: 'failed', line: logCleanupFailure(log, `removing image tag ${name} failed: ${removed.error}`) }
}

/** The filters of the listing a prune needs: untagged images carrying exactly this owner label value. */
export function ownerUntaggedImageFilters(ownerLabelValue: string): ImageListFilter[] {
  return [{ kind: 'dangling' }, { kind: 'label', key: OWNER_LABEL, value: ownerLabelValue }]
}

/** An owner's untagged-image removal: none found (no prune made), pruned (after `tries` tries), or failed with its cleanup-failure line, already logged. */
export type OwnerUntaggedImageRemoval =
  | {
      readonly kind: 'none-found'
    }
  | {
      readonly kind: 'pruned'
      /** The prune tries made, 1 to `PRUNE_RETRIES` + 1. */
      readonly tries: number
    }
  | {
      readonly kind: 'failed'
      /** The cleanup-failure line, already written to the runner log; the caller lists it (`RunState.cleanupFailures`). */
      readonly line: string
    }

/**
 * Removes the untagged images carrying exactly the owner label
 * `cscb-ci-owner=<ownerLabelValue>` (b.uqm SR-9.3, SR-6.4); E8 passes its own
 * owner's `formatOwner` text, the sweep a dead owner's label value as found.
 * - It lists the untagged images with exactly that label first. When the
 *   listing finds none, nothing more is done; when it fails, no prune is
 *   made, and the failure is `listing untagged images labelled
 *   cscb-ci-owner=<value> failed: <error>`.
 * - Only after a listing that found one does it prune untagged images
 *   filtered on that one label (no `--all`; its `--force` only skips the
 *   prompt). A prune that leaves an image a container uses has not failed.
 * - A prune Docker refuses as already running is tried again
 *   `PRUNE_RETRY_INTERVAL_MS` after the refused try, at most `PRUNE_RETRIES`
 *   times, on `clock`. Only when every try is refused is it a failure:
 *   `pruning untagged images labelled cscb-ci-owner=<value> failed: refused
 *   as already running on all <tries> tries: <error>`. Any other prune failure
 *   is `pruning untagged images labelled cscb-ci-owner=<value> failed: <error>`,
 *   with no retry.
 * Every failure is written to the runner log and returned; none is thrown.
 */
export async function removeOwnerUntaggedImages(
  docker: DockerContext,
  ownerLabelValue: string,
  clock: RunnerClock,
  log: RunnerLogSink,
): Promise<OwnerUntaggedImageRemoval> {
  const labelText = `${OWNER_LABEL}=${ownerLabelValue}`
  const listed = await listImages(docker, ownerUntaggedImageFilters(ownerLabelValue))
  if (!listed.ok) return { kind: 'failed', line: logCleanupFailure(log, `listing untagged images labelled ${labelText} failed: ${listed.error}`) }
  const found = listed.value.some((image) => image.tags.length === 0 && image.ownerLabel === ownerLabelValue)
  if (!found) return { kind: 'none-found' }
  const pruneLine = `pruning untagged images labelled ${labelText} failed`
  for (let tries = 1; ; tries++) {
    const outcome = await pruneUntaggedImages(docker, ownerLabelValue)
    if (outcome.kind === 'done') return { kind: 'pruned', tries }
    if (outcome.kind === 'failed') return { kind: 'failed', line: logCleanupFailure(log, `${pruneLine}: ${outcome.error}`) }
    if (tries > PRUNE_RETRIES) {
      return { kind: 'failed', line: logCleanupFailure(log, `${pruneLine}: refused as already running on all ${tries} tries: ${outcome.error}`) }
    }
    await clockDelay(clock, PRUNE_RETRY_INTERVAL_MS)
  }
}

/** What the sweep's listings found: every container (stopped ones included) with its labels, the reservations beside the lock, every image carrying a `cscb-ci-run` tag, and every untagged image carrying the owner label. */
export interface SweepListings {
  readonly containers: DockerAnswer<readonly ContainerState[]>
  readonly reservations: ReservationListing
  readonly runTaggedImages: DockerAnswer<readonly ImageListEntry[]>
  readonly ownerLabelledUntaggedImages: DockerAnswer<readonly ImageListEntry[]>
}

/** The filters of the sweep's tag listing: images with a tag in the `cscb-ci-run` repository. */
export function runTaggedImageFilters(): ImageListFilter[] {
  return [{ kind: 'reference', pattern: RUN_TAG_REPOSITORY }]
}

/** The filters of the sweep's untagged-image listing: untagged images carrying the owner label, whatever its value. */
export function ownerLabelledUntaggedImageFilters(): ImageListFilter[] {
  return [{ kind: 'dangling' }, { kind: 'label', key: OWNER_LABEL, value: null }]
}

/**
 * The sweep's listings (b.uqm SR-6.4), through E1's docker forms and T2's
 * reservation reader: every container with its labels (`--all`), the
 * reservations in `lockDir`, every image carrying a `cscb-ci-run` tag, and
 * every untagged image carrying the owner label. It removes nothing; a failed
 * listing is answered, not thrown.
 */
export async function listSweepLeftovers(docker: DockerContext, lockDir: string, probe: OwnerLivenessProbe): Promise<SweepListings> {
  const containers = await listContainers(docker)
  const reservations = readReservations(lockDir, probe)
  const runTaggedImages = await listImages(docker, runTaggedImageFilters())
  const ownerLabelledUntaggedImages = await listImages(docker, ownerLabelledUntaggedImageFilters())
  return { containers, reservations, runTaggedImages, ownerLabelledUntaggedImages }
}

/** A container the sweep removes: a `cscb-ci=1` container whose owner is dead, or whose owner label is missing or malformed (owner null). */
export interface SweptContainer {
  readonly id: string
  readonly name: string
  /** Whether it was running when listed: a running one is killed with SIGKILL before its removal. */
  readonly running: boolean
  readonly owner: Owner | null
}

/** A reservation file the sweep removes: valid or bad, its owner (read from its file name) dead. */
export interface SweptReservation {
  readonly fileName: string
  readonly owner: Owner
}

/** The cleanup-failure line of each failed sweep listing (not yet logged); null for a listing that succeeded. */
export interface SweepListingFailures {
  readonly containers: string | null
  readonly reservations: string | null
  readonly tags: string | null
  readonly untaggedImages: string | null
}

/** What the sweep removes, in its order, and the cleanup-failure lines of its failed listings (not yet logged). A failed listing selects nothing of its kind. */
export interface SweepPlan {
  readonly containers: readonly SweptContainer[]
  readonly reservations: readonly SweptReservation[]
  /** Dead owners' run-private tags, each once, in tag order. */
  readonly tags: readonly RunTag[]
  /** The owner-label values of untagged images whose owner is dead or malformed, each once, in value order. */
  readonly ownerLabelValues: readonly string[]
  readonly listingFailures: SweepListingFailures
}

/**
 * The sweep's selection (b.uqm SR-6.4, SR-6.3): pure but for liveness, read
 * through `probe`. It selects:
 * - `cscb-ci=1` containers whose owner is dead, running or not, a missing or
 *   malformed owner label counting as dead; never a `cscb-live=1` container
 *   nor one without `cscb-ci=1`;
 * - reservations, valid or bad, whose owner is dead, as T2's reader judged it;
 *   files that are not reservations never appear;
 * - tags of exactly the run-private shape whose owner is dead; never a tag of
 *   another shape (`cscb-ci:latest`, `cscb-ci-base:v6`, `cscb-ci-live:latest`,
 *   `cscb-ci-l5:m5`, a `cscb-ci-run:` tag that does not parse);
 * - the owner-label values of untagged images whose owner is dead or whose
 *   label is malformed; never a tagged image nor one without the label.
 * Nothing of a live owner is ever selected.
 */
export function selectSweepLeftovers(listings: SweepListings, probe: OwnerLivenessProbe): SweepPlan {
  const containers: SweptContainer[] = []
  if (listings.containers.ok) {
    for (const container of listings.containers.value) {
      if (labelValue(container.labels, CI_LIVE_CONTAINER_LABEL) === CI_LIVE_CONTAINER_LABEL_VALUE) continue
      const judged = containerLabelOwner(container.labels, probe)
      if (judged.kind !== 'dead') continue
      containers.push({ id: container.id, name: container.name, running: container.running, owner: judged.owner })
    }
  }

  const reservations: SweptReservation[] = []
  if (listings.reservations.kind === 'listed') {
    const dead = [...listings.reservations.valid, ...listings.reservations.bad].filter((entry) => !entry.ownerAlive)
    for (const entry of dead.sort((a, b) => compareText(a.fileName, b.fileName))) reservations.push({ fileName: entry.fileName, owner: entry.owner })
  }

  const tags = new Map<string, RunTag>()
  if (listings.runTaggedImages.ok) {
    for (const image of listings.runTaggedImages.value) {
      for (const tag of image.tags) {
        if (tags.has(tag)) continue
        const parsed = parseRunTag(tag)
        if (parsed !== null && !isOwnerAlive(parsed.owner, probe)) tags.set(tag, parsed)
      }
    }
  }

  const ownerLabelValues = new Set<string>()
  if (listings.ownerLabelledUntaggedImages.ok) {
    for (const image of listings.ownerLabelledUntaggedImages.value) {
      if (image.tags.length > 0 || image.ownerLabel === null || ownerLabelValues.has(image.ownerLabel)) continue
      if (imageLabelOwner({ [OWNER_LABEL]: image.ownerLabel }, probe).kind === 'dead') ownerLabelValues.add(image.ownerLabel)
    }
  }

  return {
    containers,
    reservations,
    tags: [...tags.keys()].sort(compareText).map((tag) => tags.get(tag)!),
    ownerLabelValues: [...ownerLabelValues].sort(compareText),
    listingFailures: {
      containers: listings.containers.ok ? null : `listing ${CI_LABEL}=${CI_LABEL_VALUE} containers for the sweep failed: ${listings.containers.error}`,
      reservations: listings.reservations.kind === 'listed' ? null : `listing reservations for the sweep failed: ${listings.reservations.error}`,
      tags: listings.runTaggedImages.ok ? null : `listing ${RUN_TAG_REPOSITORY} image tags for the sweep failed: ${listings.runTaggedImages.error}`,
      untaggedImages: listings.ownerLabelledUntaggedImages.ok
        ? null
        : `listing untagged images labelled ${OWNER_LABEL} for the sweep failed: ${listings.ownerLabelledUntaggedImages.error}`,
    },
  }
}

/** Code-unit order of two texts. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A swept container's removal: removed, already gone (no failure), or failed with its cleanup-failure line, already logged. */
export type SweptContainerRemoval =
  | {
      readonly kind: 'removed'
    }
  | {
      readonly kind: 'absent'
    }
  | {
      readonly kind: 'failed'
      readonly line: string
    }

/**
 * Removes one swept container (b.uqm SR-6.4): a running one is killed with
 * SIGKILL first, since E1's removal never forces; the removal is made even
 * when the kill failed (the container may have stopped meanwhile). A container
 * Docker no longer knows is absent. A failed removal is written to the runner
 * log as `removing container <name> (<id>) failed: <error>`, with
 * ` (its kill failed first: <error>)` added when the kill failed too.
 */
export async function removeSweptContainer(docker: DockerContext, container: SweptContainer, log: RunnerLogSink): Promise<SweptContainerRemoval> {
  let killError: string | null = null
  if (container.running) {
    const killed = await killContainer(docker, container.id, 'SIGKILL')
    if (!killed.ok) {
      if (killed.exitCode !== null && killed.error.includes(DOCKER_NO_SUCH_CONTAINER_TEXT)) return { kind: 'absent' }
      killError = killed.error
    }
  }
  const removed = await removeContainer(docker, container.id)
  if (removed.ok) return { kind: 'removed' }
  if (removed.exitCode !== null && removed.error.includes(DOCKER_NO_SUCH_CONTAINER_TEXT)) return { kind: 'absent' }
  const killNote = killError === null ? '' : ` (its kill failed first: ${killError})`
  return { kind: 'failed', line: logCleanupFailure(log, `removing container ${container.name} (${container.id}) failed: ${removed.error}${killNote}`) }
}

/** What the sweep needs: the docker context, the lock directory, the liveness probe, the injected clock (for the prune retry) and the runner log. */
export interface SweepContext {
  readonly docker: DockerContext
  readonly lockDir: string
  readonly probe: OwnerLivenessProbe
  readonly clock: RunnerClock
  readonly log: RunnerLogSink
}

/**
 * The sweep of dead runs' leftovers (b.uqm SR-6.4), which E13 runs at step 7,
 * under the lock and before the readings. It lists and selects
 * (`listSweepLeftovers`, `selectSweepLeftovers`), then removes in this order:
 * 1. the selected containers (`removeSweptContainer`);
 * 2. the selected reservation files (T2's `removeReservation`);
 * 3. the selected tags (`removeRunPrivateTag`);
 * 4. for each selected owner-label value, its untagged images
 *    (`removeOwnerUntaggedImages`, with its listing and prune retry).
 * A failed listing is written to the runner log at its step's place and skips
 * that step only; a failed removal is written to the log and the sweep goes
 * on. It answers every cleanup-failure line, in order (`RunState.cleanupFailures`),
 * and never refuses the run nor throws.
 */
export async function sweepLeftovers(context: SweepContext): Promise<readonly string[]> {
  const { docker, lockDir, probe, clock } = context
  // T2's remover logs without a guard; this sink makes every log write safe.
  const log: RunnerLogSink = (line) => {
    logCleanupFailure(context.log, line)
  }
  const failures: string[] = []
  const listingFailed = (line: string | null): void => {
    if (line === null) return
    log(line)
    failures.push(line)
  }
  const listings = await listSweepLeftovers(docker, lockDir, probe)
  const plan = selectSweepLeftovers(listings, probe)

  listingFailed(plan.listingFailures.containers)
  for (const container of plan.containers) {
    const removal = await removeSweptContainer(docker, container, log)
    if (removal.kind === 'failed') failures.push(removal.line)
  }

  listingFailed(plan.listingFailures.reservations)
  for (const reservation of plan.reservations) {
    const removal = removeReservation(lockDir, reservation.owner, log)
    if (removal.kind === 'failed') failures.push(removal.line)
  }

  listingFailed(plan.listingFailures.tags)
  for (const tag of plan.tags) {
    const removal = await removeRunPrivateTag(docker, tag, log)
    if (removal.kind === 'failed') failures.push(removal.line)
  }

  listingFailed(plan.listingFailures.untaggedImages)
  for (const value of plan.ownerLabelValues) {
    const removal = await removeOwnerUntaggedImages(docker, value, clock, log)
    if (removal.kind === 'failed') failures.push(removal.line)
  }

  return failures
}

// ---------------------------------------------------------------------------
// 10. Admission readings and fit (E6)
// ---------------------------------------------------------------------------

// --- 10/T1 (E6 T1): pod memory, the ceiling, container figures ---

/** The runner's copy of `/ci-live`'s working-set stop line, `HOST_WORKING_SET_LIMIT_BYTES` in `ci-live/lib/memory-watchdog.ts`, 40 GiB; never imported (b.uqm SR-6.6, SR-7.1). */
export const CI_LIVE_WORKING_SET_LIMIT_BYTES = 40 * GIB_BYTES

/** The cgroup path of the cgroup-namespace root, as `RunnerDeps.readCgroupFile` takes it (b.uqm SR-7.1). */
const CGROUP_NAMESPACE_ROOT_PATH = '/'
/** A cgroup's memory limit; `max` when none is set. */
const CGROUP_MEMORY_MAX_FILE = 'memory.max'
/** A cgroup's charged memory, page cache included. */
const CGROUP_MEMORY_CURRENT_FILE = 'memory.current'
/** A cgroup's memory breakdown, one `<key> <value>` line each. */
const CGROUP_MEMORY_STAT_FILE = 'memory.stat'
/** A cgroup's memory events, one `<key> <value>` line each. */
const CGROUP_MEMORY_EVENTS_FILE = 'memory.events'
/** A cgroup's process count. */
const CGROUP_PIDS_CURRENT_FILE = 'pids.current'
/** `memory.max`'s word for no limit. */
const CGROUP_NO_LIMIT_WORD = 'max'
/** `memory.stat`'s inactive page cache, taken off `memory.current` for the working set. */
const STAT_INACTIVE_FILE_KEY = 'inactive_file'
/** `memory.stat`'s anonymous memory. */
const STAT_ANON_KEY = 'anon'
/** `memory.stat`'s active page cache. */
const STAT_ACTIVE_FILE_KEY = 'active_file'
/** `memory.stat`'s whole page cache. */
const STAT_FILE_KEY = 'file'
/** `memory.events`' count of out-of-memory kills. */
const EVENTS_OOM_KILL_KEY = 'oom_kill'
/** A cgroup file's whole number: decimal digits only. */
const CGROUP_WHOLE_NUMBER_PATTERN = /^[0-9]+$/
/** How much of a garbled file's text a failure quotes. */
const GARBLED_TEXT_QUOTE_LENGTH = 40

/**
 * One reading (b.uqm SR-6.5, SR-7.3, SR-10.6): its value, or a failure naming
 * what could not be read and why, each on one line.
 */
export type ReadingResult<T> =
  | {
      readonly ok: true
      readonly value: T
    }
  | {
      readonly ok: false
      /** What could not be read, such as `the pod's memory.max`. */
      readonly what: string
      /** Why, on one line. */
      readonly error: string
    }

/** The pod's memory (b.uqm SR-7.1): L and W with its parts. */
export interface PodMemory {
  /** L: the namespace root's `memory.max`, in bytes. */
  readonly limitBytes: number
  /** W with anon and active page cache; the rest is `workingSetRestBytes`. */
  readonly workingSet: WorkingSetReading
}

/** Where the ceiling C comes from (b.uqm SR-6.8, SR-7.1, SR-7.4): the pod limit L, or `/ci-live`'s 40 GiB line while the runs it carries are active. */
export type CeilingSource =
  | {
      readonly kind: 'pod-limit'
      /** L, in bytes. */
      readonly limitBytes: number
    }
  | {
      readonly kind: 'ci-live'
      /** The active `/ci-live` runs that lowered C; never empty. */
      readonly runs: readonly CiLiveRunSeen[]
    }

/** The ceiling C in whole bytes, with its source (b.uqm SR-7.1). */
export interface MemoryCeiling {
  readonly bytes: number
  readonly source: CeilingSource
}

/** A container's figures from its own cgroup, each its own reading (b.uqm SR-7.2). */
export interface ContainerFigures {
  /** `memory.current` minus `inactive_file`, never below 0. */
  readonly memoryBytes: ReadingResult<number>
  /** `anon` from `memory.stat`. */
  readonly anonBytes: ReadingResult<number>
  /** `file` from `memory.stat`: its page cache. */
  readonly fileBytes: ReadingResult<number>
  /** `pids.current`. */
  readonly pidCount: ReadingResult<number>
  /** `oom_kill` from `memory.events`. */
  readonly oomKillCount: ReadingResult<number>
}

/** A listed container as admission sees it (b.uqm SR-6.5): its state (name, labels, cap or none) and its current memory. */
export interface ListedContainer extends ContainerState {
  /** Its memory, `memory.current` minus `inactive_file` (b.uqm SR-7.2). */
  readonly currentMemory: ReadingResult<number>
}

/** The container a figures read is for: its name, for the failure texts, and its main PID (`State.Pid`, 0 when it is not running). */
export type FiguresTarget = Pick<ContainerState, 'name' | 'pid'>

/** A failed reading, its texts on one line. */
function readingFailure<T>(what: string, error: string): ReadingResult<T> {
  return { ok: false, what: dependencyErrorText(what), error: dependencyErrorText(error) }
}

/** A whole number of bytes from one cgroup file's text, or why it is none. */
function parseCgroupWholeNumber(text: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: 'the file is empty' }
  const value = Number(trimmed)
  if (!CGROUP_WHOLE_NUMBER_PATTERN.test(trimmed) || !Number.isSafeInteger(value)) {
    return { ok: false, error: `not a whole number: ${JSON.stringify(trimmed.slice(0, GARBLED_TEXT_QUOTE_LENGTH))}` }
  }
  return { ok: true, value }
}

/** One cgroup file's whole text. */
function readCgroupText(deps: Pick<RunnerDeps, 'readCgroupFile'>, cgroupPath: string, fileName: string, what: string): ReadingResult<string> {
  const read = deps.readCgroupFile(cgroupPath, fileName)
  return read.ok ? { ok: true, value: read.value } : readingFailure(what, read.error)
}

/** One cgroup file holding a whole number. */
function readCgroupNumber(deps: Pick<RunnerDeps, 'readCgroupFile'>, cgroupPath: string, fileName: string, what: string): ReadingResult<number> {
  const text = readCgroupText(deps, cgroupPath, fileName, what)
  if (!text.ok) return text
  const parsed = parseCgroupWholeNumber(text.value)
  return parsed.ok ? { ok: true, value: parsed.value } : readingFailure(what, parsed.error)
}

/** One key's whole number from a flat-keyed cgroup file (`memory.stat`, `memory.events`), already read; `fileWhat` names the file. */
function keyedCgroupNumber(file: ReadingResult<string>, key: string, fileWhat: string): ReadingResult<number> {
  if (!file.ok) return file
  const what = `${key} in ${fileWhat}`
  for (const line of file.value.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 2 || fields[0] !== key) continue
    const parsed = parseCgroupWholeNumber(fields[1] ?? '')
    return parsed.ok ? { ok: true, value: parsed.value } : readingFailure(what, parsed.error)
  }
  return readingFailure(what, `${fileWhat} has no ${key} line`)
}

/** `memory.current` minus `inactive_file`, never below 0 (b.uqm SR-7.1, SR-7.2). */
function workingSetBytes(current: ReadingResult<number>, stat: ReadingResult<string>, statWhat: string): ReadingResult<number> {
  if (!current.ok) return current
  const inactive = keyedCgroupNumber(stat, STAT_INACTIVE_FILE_KEY, statWhat)
  if (!inactive.ok) return inactive
  return { ok: true, value: Math.max(0, current.value - inactive.value) }
}

/** What a failure names for one of the pod's cgroup files. */
function podFileWhat(fileName: string): string {
  return `the pod's ${fileName}`
}

/**
 * L: the cgroup-namespace root's `memory.max` in bytes (b.uqm SR-7.1). `max`,
 * an empty file or text that is not a whole number is a failed reading. Only
 * the root is read, never a cgroup on the runner's own path.
 */
export function readPodLimit(deps: Pick<RunnerDeps, 'readCgroupFile'>): ReadingResult<number> {
  const what = podFileWhat(CGROUP_MEMORY_MAX_FILE)
  const text = readCgroupText(deps, CGROUP_NAMESPACE_ROOT_PATH, CGROUP_MEMORY_MAX_FILE, what)
  if (!text.ok) return text
  if (text.value.trim() === CGROUP_NO_LIMIT_WORD) return readingFailure(what, `no limit is set (${CGROUP_NO_LIMIT_WORD})`)
  const parsed = parseCgroupWholeNumber(text.value)
  return parsed.ok ? { ok: true, value: parsed.value } : readingFailure(what, parsed.error)
}

/**
 * W with its parts, from the cgroup-namespace root (b.uqm SR-7.1): W is
 * `memory.current` minus `inactive_file`, never below 0; its parts are `anon`
 * and `active_file`. Each missing or garbled file or `memory.stat` key is a
 * failed reading naming it.
 */
export function readPodWorkingSet(deps: Pick<RunnerDeps, 'readCgroupFile'>): ReadingResult<WorkingSetReading> {
  const statWhat = podFileWhat(CGROUP_MEMORY_STAT_FILE)
  const current = readCgroupNumber(deps, CGROUP_NAMESPACE_ROOT_PATH, CGROUP_MEMORY_CURRENT_FILE, podFileWhat(CGROUP_MEMORY_CURRENT_FILE))
  if (!current.ok) return current
  const stat = readCgroupText(deps, CGROUP_NAMESPACE_ROOT_PATH, CGROUP_MEMORY_STAT_FILE, statWhat)
  const bytes = workingSetBytes(current, stat, statWhat)
  if (!bytes.ok) return bytes
  const anon = keyedCgroupNumber(stat, STAT_ANON_KEY, statWhat)
  if (!anon.ok) return anon
  const activeFile = keyedCgroupNumber(stat, STAT_ACTIVE_FILE_KEY, statWhat)
  if (!activeFile.ok) return activeFile
  return { ok: true, value: { bytes: bytes.value, anonBytes: anon.value, activeFileBytes: activeFile.value } }
}

/** L and W with its parts (b.uqm SR-6.5, SR-7.1); the first failed reading, L's first, when any fails. */
export function readPodMemory(deps: Pick<RunnerDeps, 'readCgroupFile'>): ReadingResult<PodMemory> {
  const limit = readPodLimit(deps)
  if (!limit.ok) return limit
  const workingSet = readPodWorkingSet(deps)
  if (!workingSet.ok) return workingSet
  return { ok: true, value: { limitBytes: limit.value, workingSet: workingSet.value } }
}

/** W's rest: W minus anon and active page cache, never below 0 (b.uqm SR-7.1). */
export function workingSetRestBytes(reading: WorkingSetReading): number {
  return Math.max(0, reading.bytes - reading.anonBytes - reading.activeFileBytes)
}

/** Throws unless `bytes` is a whole number of bytes, 0 or more. */
function assertWholeBytes(where: string, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`${where}: not a whole byte count: ${bytes}`)
}

/**
 * The ceiling C in whole bytes, with its source (b.uqm SR-7.1): 85% of L
 * rounded down; while any `/ci-live` run is active, the lower of that and
 * `/ci-live`'s 40 GiB line. On a tie the source is the pod limit. Throws for
 * an L that is not a whole byte count.
 */
export function memoryCeiling(limitBytes: number, ciLiveRuns: readonly CiLiveRunSeen[]): MemoryCeiling {
  assertWholeBytes('memoryCeiling', limitBytes)
  const podCeiling = Number((BigInt(limitBytes) * BigInt(MEMORY_CEILING_PERCENT)) / BigInt(100))
  if (ciLiveRuns.length > 0 && CI_LIVE_WORKING_SET_LIMIT_BYTES < podCeiling) {
    return { bytes: CI_LIVE_WORKING_SET_LIMIT_BYTES, source: { kind: 'ci-live', runs: [...ciLiveRuns] } }
  }
  return { bytes: podCeiling, source: { kind: 'pod-limit', limitBytes } }
}

/**
 * A whole-byte count in GiB to one decimal place, rounded to the nearest
 * tenth with a tie rounding up, computed exactly (b.uqm SR-7.4): `54.4`, with
 * no unit. Throws for a value that is not a whole byte count.
 */
export function formatGib(bytes: number): string {
  assertWholeBytes('formatGib', bytes)
  const gib = BigInt(GIB_BYTES)
  const scaled = BigInt(bytes) * BigInt(10)
  const tenths = scaled / gib + (BigInt(2) * (scaled % gib) >= gib ? BigInt(1) : BigInt(0))
  return `${tenths / BigInt(10)}.${tenths % BigInt(10)}`
}

/**
 * A container's cgroup path below the namespace root, found through its main
 * process's cgroup v2 membership line (b.uqm SR-7.2), never built from its ID
 * or the cgroup driver's naming. A main PID of 0, a PID that is gone or a
 * missing membership line is a failed reading.
 */
function locateContainerCgroup(deps: Pick<RunnerDeps, 'readProcCgroup'>, container: FiguresTarget): ReadingResult<string> {
  const what = `${container.name}'s cgroup`
  if (container.pid <= 0) return readingFailure(what, `the container is not running (its main PID is ${container.pid})`)
  const read = deps.readProcCgroup(container.pid)
  if (read.kind === 'gone') return readingFailure(what, `its main process ${container.pid} is gone`)
  if (read.kind === 'unreadable') return readingFailure(what, `its main process ${container.pid}'s cgroup: ${read.error}`)
  const line = read.value.trim()
  const path = line.startsWith(CGROUP_V2_LINE_PREFIX) ? line.slice(CGROUP_V2_LINE_PREFIX.length) : ''
  if (!path.startsWith('/')) return readingFailure(what, `its main process ${container.pid} has no cgroup v2 membership line`)
  return { ok: true, value: path }
}

/** What a failure names for one of a container's cgroup files. */
function containerFileWhat(container: FiguresTarget, fileName: string): string {
  return `${container.name}'s ${fileName}`
}

/** A container's memory from its located cgroup: `memory.current` minus `inactive_file`, never below 0. */
function containerMemoryAt(deps: Pick<RunnerDeps, 'readCgroupFile'>, container: FiguresTarget, cgroupPath: string, stat: ReadingResult<string>): ReadingResult<number> {
  const current = readCgroupNumber(deps, cgroupPath, CGROUP_MEMORY_CURRENT_FILE, containerFileWhat(container, CGROUP_MEMORY_CURRENT_FILE))
  return workingSetBytes(current, stat, containerFileWhat(container, CGROUP_MEMORY_STAT_FILE))
}

/**
 * One container's figures from its own cgroup (b.uqm SR-7.2), found through
 * its main PID; each figure is its own reading and fails on its own. Never
 * throws: an exited container or a gone process fails every figure.
 */
export function readContainerFigures(deps: Pick<RunnerDeps, 'readCgroupFile' | 'readProcCgroup'>, container: FiguresTarget): ContainerFigures {
  const cgroup = locateContainerCgroup(deps, container)
  if (!cgroup.ok) {
    return { memoryBytes: cgroup, anonBytes: cgroup, fileBytes: cgroup, pidCount: cgroup, oomKillCount: cgroup }
  }
  const statWhat = containerFileWhat(container, CGROUP_MEMORY_STAT_FILE)
  const eventsWhat = containerFileWhat(container, CGROUP_MEMORY_EVENTS_FILE)
  const stat = readCgroupText(deps, cgroup.value, CGROUP_MEMORY_STAT_FILE, statWhat)
  const events = readCgroupText(deps, cgroup.value, CGROUP_MEMORY_EVENTS_FILE, eventsWhat)
  return {
    memoryBytes: containerMemoryAt(deps, container, cgroup.value, stat),
    anonBytes: keyedCgroupNumber(stat, STAT_ANON_KEY, statWhat),
    fileBytes: keyedCgroupNumber(stat, STAT_FILE_KEY, statWhat),
    pidCount: readCgroupNumber(deps, cgroup.value, CGROUP_PIDS_CURRENT_FILE, containerFileWhat(container, CGROUP_PIDS_CURRENT_FILE)),
    oomKillCount: keyedCgroupNumber(events, EVENTS_OOM_KILL_KEY, eventsWhat),
  }
}

/** One container's current memory alone (b.uqm SR-6.5, SR-7.2): `memory.current` minus `inactive_file` from its own cgroup, never below 0. */
export function readContainerMemory(deps: Pick<RunnerDeps, 'readCgroupFile' | 'readProcCgroup'>, container: FiguresTarget): ReadingResult<number> {
  const cgroup = locateContainerCgroup(deps, container)
  if (!cgroup.ok) return cgroup
  const stat = readCgroupText(deps, cgroup.value, CGROUP_MEMORY_STAT_FILE, containerFileWhat(container, CGROUP_MEMORY_STAT_FILE))
  return containerMemoryAt(deps, container, cgroup.value, stat)
}

// --- 10/T2 (E6 T2): the admission readings ---

/** The name prefix of every `/ci` container admission reads, `cscb-ci*` (b.uqm SR-6.5). `/ci-live`'s containers are named `cscb-live-*`, so they are not among them. */
export const CI_CONTAINER_NAME_PREFIX = 'cscb-ci'

/** A failed admission reading's refusal kind (b.uqm SR-6.5): `disk` for the run directory's volume, `memory` for every other reading. */
export type AdmissionReadingKind = 'disk' | 'memory'

/** An admission reading that failed (b.uqm SR-6.5): its refusal kind, what could not be read and why, each text on one line. */
export interface AdmissionReadingFailure {
  readonly ok: false
  readonly kind: AdmissionReadingKind
  /** What could not be read, such as `the volume holding /tmp/cscb-ci-<RUN_ID>`. */
  readonly what: string
  /** Why, on one line. */
  readonly error: string
}

/** One admission reading (b.uqm SR-6.5): its value, or a failure that refuses the run. */
export type AdmissionReading<T> =
  | {
      readonly ok: true
      readonly value: T
    }
  | AdmissionReadingFailure

/**
 * The reservation reader the readings step takes from its caller (b.uqm
 * SR-6.2, SR-6.5): it lists, parses and classifies the reservations in the
 * lock directory it is given. E13 binds E5's reader; tests pass a constructed
 * listing. E6 itself lists, reads and removes no file there.
 */
export type ReservationReader = (lockDir: string) => ReservationListing

/**
 * The admission readings (b.uqm SR-6.5), every one taken. The `/ci-live`
 * activity (b.uqm SR-6.6) is added beside them when T4 composes the step.
 */
export interface AdmissionReadings {
  /** L: the cgroup-namespace root's `memory.max`, in bytes (b.uqm SR-7.1). */
  readonly podLimitBytes: number
  /** W split into anon and active page cache (the rest is `workingSetRestBytes`): the run's "before" reading, which E7 records and the results show (b.uqm SR-6.5). */
  readonly beforeWorkingSet: WorkingSetReading
  /** The volume holding the run directory: mount point, used and available bytes. */
  readonly volume: VolumeReading
  /** Every running `cscb-ci*` or `cscb-ci=1` container, with labels, cap (null for none) and current memory, in listing order. */
  readonly containers: readonly ListedContainer[]
  /** Every valid reservation, live and dead owners alike, each with its owner's liveness, in the reader's order. */
  readonly reservations: readonly ListedReservation[]
}

/** What the readings step reads through. */
export interface AdmissionReadingsInput {
  /** The cgroup reads (pod memory, container memory) and the volume read. */
  readonly deps: Pick<RunnerDeps, 'readCgroupFile' | 'readProcCgroup' | 'readVolume'>
  /** The docker context the container list spawns with. */
  readonly docker: DockerContext
  /** The run directory, which step 1 made. */
  readonly runDir: string
  /** The admission lock's directory, handed to `readReservations` and named by its failures. */
  readonly lockDir: string
  /** The caller's reservation reader. */
  readonly readReservations: ReservationReader
}

/** A failed admission reading of a kind, its texts on one line. */
function admissionReadingFailure(kind: AdmissionReadingKind, what: string, error: string): AdmissionReadingFailure {
  return { ok: false, kind, what: dependencyErrorText(what), error: dependencyErrorText(error) }
}

/** A reading as an admission reading of a kind: T1's pod and container readings, and T3's `/ci-live` readings, as `memory`. */
export function admissionReading<T>(kind: AdmissionReadingKind, reading: ReadingResult<T>): AdmissionReading<T> {
  return reading.ok ? { ok: true, value: reading.value } : admissionReadingFailure(kind, reading.what, reading.error)
}

/** Whether a figure is a whole number of bytes, 0 or more. */
function isWholeByteCount(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0
}

/**
 * The volume holding the run directory (b.uqm SR-6.5), through the injected
 * volume read: its mount point, used bytes (size minus free) and available
 * bytes. A failing read, the mount-point lookup included, or figures that are
 * not whole byte counts, is a failed reading of kind `disk`.
 */
export function readRunVolume(deps: Pick<RunnerDeps, 'readVolume'>, runDir: string): AdmissionReading<VolumeReading> {
  const what = `the volume holding ${runDir}`
  const read = deps.readVolume(runDir)
  if (!read.ok) return admissionReadingFailure('disk', what, read.error)
  const { mountPoint, usedBytes, availableBytes } = read.value
  if (mountPoint === '') return admissionReadingFailure('disk', what, 'no mount point was found')
  if (!isWholeByteCount(usedBytes)) return admissionReadingFailure('disk', what, `used bytes are not a whole byte count: ${usedBytes}`)
  if (!isWholeByteCount(availableBytes)) return admissionReadingFailure('disk', what, `available bytes are not a whole byte count: ${availableBytes}`)
  return { ok: true, value: { mountPoint, usedBytes, availableBytes } }
}

/** Whether admission reads a container (b.uqm SR-6.5): running, and named `cscb-ci*` or labelled `cscb-ci=1`. */
export function isAdmissionContainer(state: ContainerState): boolean {
  if (!state.running) return false
  return state.name.startsWith(CI_CONTAINER_NAME_PREFIX) || state.labels[CI_LABEL] === CI_LABEL_VALUE
}

/**
 * Every running `cscb-ci*` or `cscb-ci=1` container (b.uqm SR-6.5) of an
 * already-listed set (E1's container list, any state), in its order, each with
 * its labels, its cap (a cap of 0 or none set is null) and its current memory
 * from T1's reader. A container whose memory cannot be read is a failed reading
 * naming the container, the first in list order. Kind `memory`. Lists nothing.
 */
export function admissionContainersFrom(
  deps: Pick<RunnerDeps, 'readCgroupFile' | 'readProcCgroup'>,
  states: readonly ContainerState[],
): AdmissionReading<readonly ListedContainer[]> {
  const containers: ListedContainer[] = []
  for (const state of states) {
    if (!isAdmissionContainer(state)) continue
    const currentMemory = readContainerMemory(deps, state)
    if (!currentMemory.ok) return admissionReading('memory', currentMemory)
    const memoryCapBytes = state.memoryCapBytes === 0 ? null : state.memoryCapBytes
    containers.push({ ...state, memoryCapBytes, currentMemory })
  }
  return { ok: true, value: containers }
}

/** E1's container list as an admission reading: a failing list is a failed reading, `the container list`, of kind `memory`. */
async function listAdmissionContainerStates(docker: DockerContext): Promise<AdmissionReading<readonly ContainerState[]>> {
  const listed = await listContainers(docker)
  if (!listed.ok) return admissionReadingFailure('memory', 'the container list', listed.error)
  return { ok: true, value: listed.value }
}

/**
 * The admission containers, listing them itself through E1's container list
 * (one listing): a failing list is a failed reading naming it; otherwise as
 * `admissionContainersFrom`. The readings step lists through
 * `takeAdmissionReadings` instead, which keeps the listing for T4.
 */
export async function readAdmissionContainers(
  deps: Pick<RunnerDeps, 'readCgroupFile' | 'readProcCgroup'>,
  docker: DockerContext,
): Promise<AdmissionReading<readonly ListedContainer[]>> {
  const listed = await listAdmissionContainerStates(docker)
  if (!listed.ok) return listed
  return admissionContainersFrom(deps, listed.value)
}

/**
 * The reservations as admission takes them (b.uqm SR-6.2, SR-6.5), from the
 * caller's reader: every valid one, live and dead owners alike, with its
 * owner's liveness. A bad file whose owner is alive is a failed reading naming
 * the file and the reason, the first in the reader's order; one whose owner is
 * dead is skipped (the sweep's case). A listing failure, or a reader that
 * throws, is a failed reading naming the lock directory. Kind `memory`. No
 * file is listed, read or removed here.
 */
export function readAdmissionReservations(readReservations: ReservationReader, lockDir: string): AdmissionReading<readonly ListedReservation[]> {
  const what = `the lock directory ${lockDir}`
  let listing: ReservationListing
  try {
    listing = readReservations(lockDir)
  } catch (err) {
    return admissionReadingFailure('memory', what, dependencyErrorText(err))
  }
  if (listing.kind === 'failed') return admissionReadingFailure('memory', what, listing.error)
  const liveBad = listing.bad.find((file) => file.ownerAlive)
  if (liveBad !== undefined) return admissionReadingFailure('memory', `the reservation ${join(lockDir, liveBad.fileName)}`, liveBad.reason)
  return { ok: true, value: [...listing.valid] }
}

/**
 * A failed reading's refusal (b.uqm SR-5.2, SR-6.5): its kind, the summary
 * `could not read <what>: <error>` on one line and no details, so its first
 * line is `NOT RUN: disk: could not read …` for the volume and
 * `NOT RUN: memory: could not read …` for every other reading.
 */
export function failedReadingRefusal(failure: AdmissionReadingFailure): Refusal {
  return buildRefusal(failure.kind, `could not read ${dependencyErrorText(failure.what)}: ${dependencyErrorText(failure.error)}`)
}

/**
 * What the readings step answers (b.uqm SR-6.5): the readings, and the one
 * container listing they were taken from. The listing is not a reading of its
 * own; T4 hands it to `detectCiLiveActivity`, so admission lists the
 * containers once and both judge the same snapshot.
 */
export interface TakenAdmissionReadings {
  readonly readings: AdmissionReadings
  /** E1's container list as the readings took it: every container, in any state, in listing order. */
  readonly containerListing: readonly ContainerState[]
}

/**
 * The admission readings (b.uqm SR-6.5), taken under the lock after the sweep,
 * in SR-6.5's order: W with its parts and L, the run directory's volume, the
 * containers (E1's container list, listed exactly once), the reservations.
 * The first reading that fails stops the step and is its answer;
 * `failedReadingRefusal` turns it into the run's refusal. On success the
 * listing comes back beside the readings for T4's `/ci-live` detection.
 */
export async function takeAdmissionReadings(input: AdmissionReadingsInput): Promise<AdmissionReading<TakenAdmissionReadings>> {
  const pod = admissionReading('memory', readPodMemory(input.deps))
  if (!pod.ok) return pod
  const volume = readRunVolume(input.deps, input.runDir)
  if (!volume.ok) return volume
  const listing = await listAdmissionContainerStates(input.docker)
  if (!listing.ok) return listing
  const containers = admissionContainersFrom(input.deps, listing.value)
  if (!containers.ok) return containers
  const reservations = readAdmissionReservations(input.readReservations, input.lockDir)
  if (!reservations.ok) return reservations
  return {
    ok: true,
    value: {
      readings: {
        podLimitBytes: pod.value.limitBytes,
        beforeWorkingSet: pod.value.workingSet,
        volume: volume.value,
        containers: containers.value,
        reservations: reservations.value,
      },
      containerListing: listing.value,
    },
  }
}

// --- 10/T3 (E6 T3): /ci-live detection, the runner's copies, the commitments ---

// The runner's own copies of `/ci-live`'s rules and figures (b.uqm SR-6.6,
// SR-21.5), read from `ci-live/lib/*.ts` and never imported (b.uqm SR-1.3).
// The tests pin each copy against `/ci-live`'s exports.

/** `/ci-live`'s directory name in the worktree: a bare `run.ts` is its runner only when started there (`isLiveRunnerPid` in `ci-live/lib/run-lock.ts`). */
export const CI_LIVE_DIR_NAME = 'ci-live'
/** `/ci-live`'s entry file name (`ci-live/run.ts`). */
export const CI_LIVE_ENTRY_FILE_NAME = 'run.ts'
/** `/ci-live`'s default config directory below the account's home (`defaultConfigDir` in `ci-live/lib/paths.ts`); `CSCB_LIVE_CONFIG_DIR` is never consulted. */
export const CI_LIVE_CONFIG_DIR_SUBPATH = '.config/cscb-test'
/** The real-run lock's file name in that directory (`realRunLockFile`). */
export const CI_LIVE_REAL_RUN_LOCK_FILE_NAME = 'run.lock'
/** The dry-run lock's name before the user ID (`dryRunLockFile`): `cscb-ci-live-dry-run-<uid>.lock`. */
export const CI_LIVE_DRY_RUN_LOCK_PREFIX = 'cscb-ci-live-dry-run-'
/** The dry-run lock's name after the user ID. */
export const CI_LIVE_DRY_RUN_LOCK_SUFFIX = '.lock'
/** The variables Bun's `os.tmpdir()` reads for `/ci-live`'s temp directory, in order: the first set and not empty wins, else `/tmp` (b.uqm SR-6.6). */
export const CI_LIVE_TEMP_DIR_VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const
/** The label every `/ci-live` container carries, `cscb-live=1` (`CONTAINER_LABEL_KEY` in `ci-live/lib/docker.ts`). */
export const CI_LIVE_CONTAINER_LABEL = 'cscb-live'
/** That label's value. */
export const CI_LIVE_CONTAINER_LABEL_VALUE = '1'
/** A `/ci-live` container's name prefix (`CONTAINER_PREFIX`): `cscb-live-<run id>-<owner PID>` (`containerName`). */
export const CI_LIVE_CONTAINER_PREFIX = 'cscb-live-'
/** `/ci-live`'s container cap, 8 GiB, as bytes (`CONTAINER_MEMORY`, `8g`, in `ci-live/lib/docker.ts`). */
export const CI_LIVE_CONTAINER_MEMORY_BYTES = 8 * GIB_BYTES
/** `/ci-live`'s Chrome limit, 4 GiB, as bytes (`CHROME_PSS_LIMIT_BYTES` in `ci-live/lib/memory-watchdog.ts`). */
export const CI_LIVE_CHROME_LIMIT_BYTES = 4 * GIB_BYTES
/** What one active `/ci-live` run counts (b.uqm SR-6.6): its container cap, its Chrome limit and the 1 GiB runner allowance, 13 GiB. */
export const CI_LIVE_RUN_COMMITMENT_BYTES = CI_LIVE_CONTAINER_MEMORY_BYTES + CI_LIVE_CHROME_LIMIT_BYTES + CI_LIVE_RUNNER_ALLOWANCE_BYTES
/** The most a `/ci-live` lock read takes, in bytes: a lock holds a PID of at most ten digits and a newline, so a regular file larger than this is a failed reading. The runner's own bound, not a `/ci-live` figure. */
export const CI_LIVE_LOCK_READ_MAX_BYTES = 64

/** A lock file's text as `lockPid` reads it: one to ten digits, then only optional whitespace. */
const CI_LIVE_LOCK_PID_PATTERN = /^(\d{1,10})\s*$/
/** What follows the prefix in a `/ci-live` container's name: `<run id>-<owner PID>`, or an older runner's bare `<run id>` (`LIVE_NAME_SUFFIX_RE`). */
const CI_LIVE_CONTAINER_NAME_SUFFIX_PATTERN = /^[0-9a-z]{1,32}(-[1-9][0-9]{0,9})?$/

/** `/ci-live`'s default config directory under the account's home (`defaultConfigDir`). The home comes from the caller (E13 binds E5's account-home lookup). */
export function ciLiveConfigDir(home: string): string {
  return join(home, CI_LIVE_CONFIG_DIR_SUBPATH)
}

/** The real-run lock, `run.lock` in `.config/cscb-test` under the account's home, whatever `CSCB_LIVE_CONFIG_DIR` holds (b.uqm SR-6.6). */
export function ciLiveRealRunLockPath(home: string): string {
  return join(ciLiveConfigDir(home), CI_LIVE_REAL_RUN_LOCK_FILE_NAME)
}

/**
 * `/ci-live`'s temp directory as Bun's `os.tmpdir()` finds it, from the
 * runner's injected environment (b.uqm SR-6.6): the first of `TMPDIR`, `TMP`
 * and `TEMP` that is set and not empty, else `/tmp`, with one trailing slash
 * dropped from any value but `/`. Not the run directory's rule (`systemTempDir`).
 */
export function ciLiveTempDir(env: Readonly<Record<string, string | undefined>>): string {
  let dir: string = DEFAULT_TEMP_DIR
  for (const variable of CI_LIVE_TEMP_DIR_VARIABLES) {
    const value = env[variable]
    if (value !== undefined && value !== '') {
      dir = value
      break
    }
  }
  return dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir
}

/** The dry-run lock's name, `cscb-ci-live-dry-run-<uid>.lock`, uid being the runner's user ID. */
export function ciLiveDryRunLockName(uid: number): string {
  return `${CI_LIVE_DRY_RUN_LOCK_PREFIX}${uid}${CI_LIVE_DRY_RUN_LOCK_SUFFIX}`
}

/** The dry-run lock: `/ci-live`'s temp directory and the lock's name joined as `dryRunLockFile` joins them, so repeated slashes collapse. */
export function ciLiveDryRunLockPath(env: Readonly<Record<string, string | undefined>>, uid: number): string {
  return join(ciLiveTempDir(env), ciLiveDryRunLockName(uid))
}

/** The PID a lock file's text names, as `lockPid` reads it: one to ten digits followed only by optional whitespace; anything else, or no text, is null. */
export function ciLiveLockPid(text: string | null): number | null {
  const match = CI_LIVE_LOCK_PID_PATTERN.exec(text ?? '')
  return match ? Number(match[1]) : null
}

/** The patterns that find a `/ci-live` runner, built from `CI_LIVE_DIR_NAME` and `CI_LIVE_ENTRY_FILE_NAME` as `isLiveRunnerPid`'s literals read. */
interface CiLiveRunnerPatterns {
  /** A runner's command line by its path: `ci-live/run.ts`, with either slash, then whitespace or the end. */
  readonly runnerCmdline: RegExp
  /** A bare `run.ts` as its own word, a runner only when its working directory is a `ci-live` directory. */
  readonly bareRunnerCmdline: RegExp
  /** A working directory that ends in `/ci-live` (either slash). */
  readonly ciLiveCwd: RegExp
}

/** Built at first use, never at import (b.uqm SR-1.3). */
let ciLiveRunnerPatternsBuilt: CiLiveRunnerPatterns | null = null

/** A text as a regular-expression source that matches it literally. */
function literalPatternSource(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The `/ci-live` runner patterns, built once at first use. */
function ciLiveRunnerPatterns(): CiLiveRunnerPatterns {
  if (ciLiveRunnerPatternsBuilt === null) {
    const dir = literalPatternSource(CI_LIVE_DIR_NAME)
    const entry = literalPatternSource(CI_LIVE_ENTRY_FILE_NAME)
    ciLiveRunnerPatternsBuilt = {
      runnerCmdline: new RegExp(`${dir}[/\\\\]${entry}(\\s|$)`),
      bareRunnerCmdline: new RegExp(`(^|[\\s/\\\\])${entry}(\\s|$)`),
      ciLiveCwd: new RegExp(`[/\\\\]${dir}$`),
    }
  }
  return ciLiveRunnerPatternsBuilt
}

/**
 * Whether a PID is a live `/ci-live` runner, as `isLiveRunnerPid` judges it
 * from a command line (NULs read as spaces) and a working directory, each
 * null when it cannot be read. A PID that is not a positive whole number, or
 * whose command line cannot be read, is none; a command line holding
 * `ci-live/run.ts` (either slash) followed by whitespace or the end is one; so
 * is a bare `run.ts` as its own word when the working directory ends in
 * `/ci-live`.
 */
export function isCiLiveRunnerPid(pid: number, readCmdline: (pid: number) => string | null, readCwd: (pid: number) => string | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const cmdline = readCmdline(pid)
  if (cmdline === null) return false
  const patterns = ciLiveRunnerPatterns()
  if (patterns.runnerCmdline.test(cmdline)) return true
  return patterns.bareRunnerCmdline.test(cmdline) && patterns.ciLiveCwd.test(readCwd(pid) ?? '')
}

/** The `/proc` reads the `/ci-live` runner test takes. */
export type CiLiveProcProbe = Pick<RunnerDeps, 'readProcCmdline' | 'readProcCwd'>

/** A command line as `/proc/<pid>/cmdline` holds it, each argument NUL-terminated, with the NULs read as spaces. */
function ciLiveCommandLineText(args: readonly string[]): string {
  return args.map((arg) => `${arg} `).join('')
}

/** Whether a PID is a live `/ci-live` runner, through the injected `/proc` reads; a read that fails is no command line or no working directory. */
export function isCiLiveRunner(probe: CiLiveProcProbe, pid: number): boolean {
  return isCiLiveRunnerPid(
    pid,
    (p) => {
      const read = probe.readProcCmdline(p)
      return read.kind === 'value' ? ciLiveCommandLineText(read.value) : null
    },
    (p) => {
      const read = probe.readProcCwd(p)
      return read.kind === 'value' ? read.value : null
    },
  )
}

/** The owner PID a `/ci-live` container's name carries (`cscb-live-<run id>-<PID>`, as `containerName` forms it); null for an older runner's bare `cscb-live-<run id>` or a name of another form. */
export function ciLiveContainerPid(name: string): number | null {
  if (!name.startsWith(CI_LIVE_CONTAINER_PREFIX)) return null
  const match = CI_LIVE_CONTAINER_NAME_SUFFIX_PATTERN.exec(name.slice(CI_LIVE_CONTAINER_PREFIX.length))
  if (match === null || match[1] === undefined) return null
  return Number(match[1].slice(1))
}

/** Whether a container is a running `/ci-live` container, labelled `cscb-live=1`. */
export function isRunningCiLiveContainer(state: ContainerState): boolean {
  return state.running && labelValue(state.labels, CI_LIVE_CONTAINER_LABEL) === CI_LIVE_CONTAINER_LABEL_VALUE
}

/** A held `/ci-live` lock (b.uqm SR-6.6): its file names a PID that is a live `/ci-live` runner. */
export interface CiLiveHeldLock {
  readonly via: 'real-run-lock' | 'dry-run-lock'
  /** The lock file's path. */
  readonly path: string
  /** The runner PID it names. */
  readonly pid: number
  /** Its own containers: each running `cscb-live=1` container whose name carries its PID; usually one or none. */
  readonly ownContainers: readonly ContainerState[]
}

/** A running `cscb-live=1` container that matches no held lock: an active run of its own. */
export interface CiLiveLoneContainer {
  readonly container: ContainerState
  /** The PID its name carries; null when it carries none. */
  readonly pid: number | null
}

/** The `/ci-live` activity (b.uqm SR-6.6). */
export interface CiLiveActivity {
  /** Every active run, as `memoryCeiling` and E7 take them: the held real-run lock, the held dry-run lock, then each lone container in listing order. */
  readonly runs: readonly CiLiveRunSeen[]
  /** Each held lock with its own containers. */
  readonly heldLocks: readonly CiLiveHeldLock[]
  /** Each running `cscb-live=1` container that matches no held lock. */
  readonly loneContainers: readonly CiLiveLoneContainer[]
}

/** What the `/ci-live` detector reads through: the environment and user ID for the dry-run lock, and the `/proc` reads for the runner test. */
export type CiLiveDetectionDeps = Pick<RunnerDeps, 'env' | 'uid' | 'readProcCmdline' | 'readProcCwd'>

/** Closes a descriptor, a failing close ignored: the read's answer stands either way. */
function closeQuietly(fd: number): void {
  try {
    closeCiLiveLock(fd)
  } catch {
    // Nothing to undo: the descriptor was only read.
  }
}

/**
 * A `/ci-live` lock file's text, read so that it cannot hang (b.uqm SR-6.6):
 * opened read-only and non-blocking (`O_RDONLY | O_NONBLOCK`, never `O_CREAT`
 * or a write mode), `fstat`ed, and read for at most
 * `CI_LIVE_LOCK_READ_MAX_BYTES` bytes; the descriptor is always closed. A
 * path that does not exist is missing. Anything that is not a regular file (a
 * FIFO, a device, a directory), a regular file larger than the bound, or any
 * other failure is unreadable. Nothing is written, renamed, removed, created,
 * locked or touched: the file's content, mode and times stay as they were.
 */
export function readCiLiveLockFile(path: string): FileTextRead {
  let fd: number
  try {
    fd = openCiLiveLock(path, ciLiveLockFsConstants.O_RDONLY | ciLiveLockFsConstants.O_NONBLOCK)
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', error: dependencyErrorText(err) }
  }
  try {
    const stat = fstatCiLiveLock(fd)
    if (!stat.isFile()) return { kind: 'unreadable', error: 'not a regular file' }
    if (stat.size > CI_LIVE_LOCK_READ_MAX_BYTES) return { kind: 'unreadable', error: `larger than ${CI_LIVE_LOCK_READ_MAX_BYTES} bytes: ${stat.size} bytes` }
    const buffer = Buffer.alloc(CI_LIVE_LOCK_READ_MAX_BYTES)
    let length = 0
    while (length < buffer.length) {
      const read = readCiLiveLock(fd, buffer, length, buffer.length - length, null)
      if (read === 0) break
      length += read
    }
    return { kind: 'text', text: buffer.toString('utf-8', 0, length) }
  } catch (err) {
    return { kind: 'unreadable', error: dependencyErrorText(err) }
  } finally {
    closeQuietly(fd)
  }
}

/**
 * One lock's holder, read-only (b.uqm SR-6.6): the PID its text names when
 * that is a live `/ci-live` runner, else null. A missing file is not held; a
 * file that exists but cannot be read, or is not a regular file within
 * `CI_LIVE_LOCK_READ_MAX_BYTES`, is a failed reading. The file is only read,
 * through `readCiLiveLockFile`: never created, written, renamed, removed,
 * opened for writing or locked, and the read cannot block.
 */
function readCiLiveLockHolder(probe: CiLiveProcProbe, path: string, what: string): ReadingResult<number | null> {
  const read = readCiLiveLockFile(path)
  if (read.kind === 'missing') return { ok: true, value: null }
  if (read.kind === 'unreadable') return readingFailure(what, read.error)
  const pid = ciLiveLockPid(read.text)
  return { ok: true, value: pid !== null && isCiLiveRunner(probe, pid) ? pid : null }
}

/**
 * The active `/ci-live` runs (b.uqm SR-6.6) over an already-listed set of
 * containers (any state; only running `cscb-live=1` ones count). Each lock is
 * held when its file names a PID that is a live `/ci-live` runner; each held
 * lock gets its own containers (the `cscb-live=1` containers whose names carry
 * its PID), which are not runs of their own; each other running `cscb-live=1`
 * container is a run of its own. `home` is the account's home, from the
 * caller. A lock file that exists but cannot be read (or is not a regular
 * file within `CI_LIVE_LOCK_READ_MAX_BYTES`) is a failed reading. The lock
 * files are only read, non-blocking (`readCiLiveLockFile`); nothing else
 * touches them.
 */
export function detectCiLiveActivity(deps: CiLiveDetectionDeps, home: string, containers: readonly ContainerState[]): ReadingResult<CiLiveActivity> {
  const liveContainers = containers.filter(isRunningCiLiveContainer)
  const locks: readonly { readonly via: CiLiveHeldLock['via']; readonly path: string; readonly what: string }[] = [
    { via: 'real-run-lock', path: ciLiveRealRunLockPath(home), what: `the /ci-live real-run lock ${ciLiveRealRunLockPath(home)}` },
    { via: 'dry-run-lock', path: ciLiveDryRunLockPath(deps.env, deps.uid), what: `the /ci-live dry-run lock ${ciLiveDryRunLockPath(deps.env, deps.uid)}` },
  ]
  const heldLocks: CiLiveHeldLock[] = []
  for (const lock of locks) {
    const holder = readCiLiveLockHolder(deps, lock.path, lock.what)
    if (!holder.ok) return holder
    if (holder.value === null) continue
    const pid = holder.value
    heldLocks.push({ via: lock.via, path: lock.path, pid, ownContainers: liveContainers.filter((state) => ciLiveContainerPid(state.name) === pid) })
  }
  const heldPids = new Set(heldLocks.map((lock) => lock.pid))
  const loneContainers: CiLiveLoneContainer[] = []
  for (const container of liveContainers) {
    const pid = ciLiveContainerPid(container.name)
    if (pid !== null && heldPids.has(pid)) continue
    loneContainers.push({ container, pid })
  }
  const runs: CiLiveRunSeen[] = [
    ...heldLocks.map((lock): CiLiveRunSeen => ({ via: lock.via, what: lock.path, pid: lock.pid })),
    ...loneContainers.map((lone): CiLiveRunSeen => ({ via: 'container', what: lone.container.name, pid: lone.pid })),
  ]
  return { ok: true, value: { runs, heldLocks, loneContainers } }
}

/**
 * The active `/ci-live` runs (b.uqm SR-6.6), listing the containers itself
 * through E1's container list: what E7 calls at every sample. A failing list
 * is a failed reading, `the container list`; otherwise as `detectCiLiveActivity`.
 */
export async function readCiLiveActivity(deps: CiLiveDetectionDeps, home: string, docker: DockerContext): Promise<ReadingResult<CiLiveActivity>> {
  const listed = await listContainers(docker)
  if (!listed.ok) return readingFailure('the container list', listed.error)
  return detectCiLiveActivity(deps, home, listed.value)
}

/** Another live `/ci` run's reservation as counted: its memory minus its running shard containers' current memory, never below 0. */
export interface ReservationCommitment {
  readonly kind: 'reservation'
  /** Its file name beside the lock. */
  readonly fileName: string
  /** The reservation: RUN_ID, runner PID, shards, memory, CPUs, full or selective. */
  readonly reservation: Reservation
  /** Its owner's running shard containers, matched by the owner label, in listing order. */
  readonly shardContainers: readonly string[]
  /** The current memory of those containers that was read; a container whose memory could not be read adds 0. */
  readonly shardMemoryBytes: number
  readonly countedBytes: number
}

/** An active `/ci-live` run as counted: 13 GiB, once per held lock (its own containers included) or per lone container. */
export interface CiLiveCommitment {
  readonly kind: 'ci-live'
  /** The lock or container that showed it, and its PID. */
  readonly run: CiLiveRunSeen
  /** A held lock's own containers' names; none for a lone container. */
  readonly ownContainers: readonly string[]
  readonly countedBytes: number
}

/** A running container counted at its cap: labelled `cscb-ci=1` with no live reservation, or an unlabelled `cscb-ci*` one. */
export interface ContainerCommitment {
  readonly kind: 'labelled-container' | 'unlabelled-container'
  readonly name: string
  /** A labelled container's owner from its owner label; null when that is missing or malformed, and for an unlabelled one. */
  readonly owner: Owner | null
  /** Its cap. */
  readonly countedBytes: number
}

/** One counted commitment (b.uqm SR-6.6). */
export type MemoryCommitment = ReservationCommitment | CiLiveCommitment | ContainerCommitment

/** A running container with no memory cap that blocks every run (b.uqm SR-6.6, SR-6.7); admission removes none, and `/ci` never removes an unlabelled one (a labelled one goes in a later run's sweep once its owner is dead, SR-6.4). */
export interface BlockingContainer {
  readonly name: string
  /** Whether it carries `cscb-ci=1` (a labelled one with no live reservation), or is an unlabelled `cscb-ci*` one. */
  readonly labelled: boolean
  /** A labelled container's owner from its owner label; null when that is missing or malformed, and for an unlabelled one. */
  readonly owner: Owner | null
}

/** What admission counts (b.uqm SR-6.6). */
export interface MemoryCommitments {
  /** The sum of every item's counted bytes. */
  readonly totalBytes: number
  /** Each counted item in order: the live reservations, the `/ci-live` runs, then the containers counted at their caps, in listing order. */
  readonly items: readonly MemoryCommitment[]
  /** The uncapped containers that block every run, named. */
  readonly blocking: readonly BlockingContainer[]
  /** h: the CPUs of the live reservations; `/ci-live` adds none. */
  readonly reservedCpus: number
}

/** Whether a container's owner label names this reservation's owner. */
function isReservationShard(state: ContainerState, reservation: Reservation): boolean {
  const owner = parseOwner(labelValue(state.labels, OWNER_LABEL) ?? '')
  return owner !== null && owner.runId === reservation.runId && owner.pid === reservation.pid
}

/**
 * The memory commitments, the blocking containers and h (b.uqm SR-6.6), from
 * the listed containers (T1's shape; only running ones count), the valid
 * reservations with their owners' liveness, and the `/ci-live` activity:
 *
 * - each live reservation: its memory minus the current memory of its owner's
 *   running `cscb-ci=1` containers (matched by the owner label), never below 0;
 *   a reservation whose owner is dead counts nothing;
 * - each active `/ci-live` run: 13 GiB, once per held lock with its own
 *   containers included, and once per lone `cscb-live=1` container;
 * - each running `cscb-ci=1` container whose owner has no live reservation:
 *   its cap;
 * - each running `cscb-ci*` container without `cscb-ci=1`: its cap.
 *
 * A container counted at its cap that has none (null or 0) blocks every run
 * instead: the unlabelled ones as SR-6.6 states, and, as the safe reading, a
 * labelled one with no live reservation too. h sums the live reservations' CPUs.
 *
 * Precondition: call it before this run's own reservation exists (before
 * steps 8–9 write it), so every live reservation it sees is another run's;
 * called later, it would count this run against itself.
 */
export function memoryCommitments(
  containers: readonly ListedContainer[],
  reservations: readonly ListedReservation[],
  activity: CiLiveActivity,
): MemoryCommitments {
  const running = containers.filter((state) => state.running)
  const live = reservations.filter((listed) => listed.ownerAlive)
  const items: MemoryCommitment[] = []
  const blocking: BlockingContainer[] = []
  for (const listed of live) {
    const shards = running.filter((state) => labelValue(state.labels, CI_LABEL) === CI_LABEL_VALUE && isReservationShard(state, listed.reservation))
    const shardMemoryBytes = shards.reduce((sum, state) => sum + (state.currentMemory.ok ? state.currentMemory.value : 0), 0)
    items.push({
      kind: 'reservation',
      fileName: listed.fileName,
      reservation: listed.reservation,
      shardContainers: shards.map((state) => state.name),
      shardMemoryBytes,
      countedBytes: Math.max(0, listed.reservation.memoryBytes - shardMemoryBytes),
    })
  }
  for (const lock of activity.heldLocks) {
    items.push({
      kind: 'ci-live',
      run: { via: lock.via, what: lock.path, pid: lock.pid },
      ownContainers: lock.ownContainers.map((state) => state.name),
      countedBytes: CI_LIVE_RUN_COMMITMENT_BYTES,
    })
  }
  for (const lone of activity.loneContainers) {
    items.push({ kind: 'ci-live', run: { via: 'container', what: lone.container.name, pid: lone.pid }, ownContainers: [], countedBytes: CI_LIVE_RUN_COMMITMENT_BYTES })
  }
  for (const state of running) {
    const labelled = labelValue(state.labels, CI_LABEL) === CI_LABEL_VALUE
    if (labelled && live.some((listed) => isReservationShard(state, listed.reservation))) continue
    if (!labelled && !state.name.startsWith(CI_CONTAINER_NAME_PREFIX)) continue
    const owner = labelled ? parseOwner(labelValue(state.labels, OWNER_LABEL) ?? '') : null
    if (state.memoryCapBytes === null || state.memoryCapBytes === 0) {
      blocking.push({ name: state.name, labelled, owner })
      continue
    }
    items.push({ kind: labelled ? 'labelled-container' : 'unlabelled-container', name: state.name, owner, countedBytes: state.memoryCapBytes })
  }
  return {
    totalBytes: items.reduce((sum, item) => sum + item.countedBytes, 0),
    items,
    blocking,
    reservedCpus: live.reduce((sum, listed) => sum + listed.reservation.cpus, 0),
  }
}

// --- 10/T4 (E6 T4): the readings step, the fits, choosing N, the shard-count line ---

/** A percentage's whole: the disk fit compares `× 100` against the disk line's percent, in integers. */
const PERCENT_WHOLE = 100
/** The shard-count line's opening word (b.uqm SR-6.7): `shards: <n> of <r>`. */
const SHARD_COUNT_LINE_PREFIX = 'shards: '
/** Separates the shard-count line's reasons (b.uqm SR-6.7). */
const SHARD_COUNT_REASON_SEPARATOR = ', '
/** The shard-count line's reason for a run that ended before admission chose its N (b.uqm SR-6.7); also its `results.json` `shardCount.reasons` entry. */
export const ENDED_BEFORE_ADMISSION_REASON = 'ended before admission'

/** The admission readings with the `/ci-live` activity added (b.uqm SR-6.5): every SR-6.5 item, W being the run's "before" reading. */
export interface FullAdmissionReadings extends AdmissionReadings {
  /** The active `/ci-live` runs, with the held locks and the lone containers (b.uqm SR-6.6). */
  readonly ciLive: CiLiveActivity
}

/** What the readings step answers (b.uqm SR-5.3 step 8): every reading, C with its source, and what admission counts. */
export interface AdmissionFigures {
  readonly readings: FullAdmissionReadings
  /** C, 85% of L or `/ci-live`'s 40 GiB line, with its source (b.uqm SR-7.1). */
  readonly ceiling: MemoryCeiling
  /** The memory commitments, the blocking containers and h (b.uqm SR-6.6). */
  readonly commitments: MemoryCommitments
}

/**
 * What the readings step reads through: T2's input, plus the `/ci-live`
 * detector's reads (environment, user ID, `/proc`) and the account's home for
 * the real-run lock, which the caller gives (E13 binds E5's account-home lookup).
 */
export interface AdmissionStepInput extends AdmissionReadingsInput {
  readonly deps: AdmissionReadingsInput['deps'] & CiLiveDetectionDeps
  /** The account's home, holding `/ci-live`'s real-run lock. */
  readonly home: string
}

/**
 * The admission readings step (b.uqm SR-5.3 step 8, SR-6.5), taken under the
 * lock after the sweep, in SR-6.5's order: W with its parts and L, the run
 * directory's volume, the containers (listed once), the reservations through
 * the caller's reader, then the `/ci-live` activity, judged over that same
 * container listing. The first reading that fails stops the step and is its
 * answer, `disk` for the volume and `memory` for every other
 * (`failedReadingRefusal` makes it the refusal). Otherwise it answers every
 * reading, C with its source, and the commitments, blocking containers and h.
 * Call it before this run's own reservation exists (see `memoryCommitments`).
 */
export async function takeFullAdmissionReadings(input: AdmissionStepInput): Promise<AdmissionReading<AdmissionFigures>> {
  const taken = await takeAdmissionReadings(input)
  if (!taken.ok) return taken
  const { readings, containerListing } = taken.value
  const ciLive = admissionReading('memory', detectCiLiveActivity(input.deps, input.home, containerListing))
  if (!ciLive.ok) return ciLive
  return {
    ok: true,
    value: {
      readings: { ...readings, ciLive: ciLive.value },
      ceiling: memoryCeiling(readings.podLimitBytes, ciLive.value.runs),
      commitments: memoryCommitments(readings.containers, readings.reservations, ciLive.value),
    },
  }
}

/** A limit admission judges (b.uqm SR-6.7, SR-6.8), named as its refusal kind. */
export type AdmissionLimit = Exclude<RefusalKind, null>

/** A limit that depends on N: the memory and CPU fits (b.uqm SR-6.7). */
export type ShardFitLimit = Extract<AdmissionLimit, 'memory' | 'cpu'>

/** The limits in the order a refusal gives them (b.uqm SR-6.8): memory, disk, CPU. */
const ADMISSION_LIMIT_ORDER: readonly AdmissionLimit[] = ['memory', 'disk', 'cpu']

/** What the run asks of admission (b.uqm SR-3.4, SR-6.7), from E2's validation (`ValidatedRun`) and E1's arguments. */
export interface AdmissionRequest {
  /** r: the `--shards` value, or `MAX_SHARDS` when it is not given (E2's `ValidatedRun.requestedShards`). */
  readonly requestedShards: number
  /** u: the count of the run's scheduling units (E2, b.uqm SR-3.4: `ValidatedRun.units.length`). */
  readonly units: number
  /** The effective N (E2, b.uqm SR-3.4): the smaller of r and u, at least 1. */
  readonly effectiveShards: number
  /** Neither `--shards` nor `--inject` was given (`canChooseShards`): the run takes the largest N that fits. */
  readonly canChooseShards: boolean
  /** The per-shard memory cap, E1's `SHARD_MEMORY_CAP_BYTES`, passed in. */
  readonly capBytes: number
}

/** Whether admission may choose the run's N (b.uqm SR-6.7): neither `--shards` nor `--inject` was given. Choosing changes neither its run kind nor its gate eligibility. */
export function canChooseShards(invocation: Invocation): boolean {
  return invocation.shards === null && !isInjectedRun(invocation)
}

/**
 * f (b.uqm SR-6.7): C − W − the memory commitments − the 1 GiB admission
 * margin, never below 0, the memory left for shards. Blocking containers count
 * nothing here; they fail the memory fit on their own.
 */
export function freeShardMemoryBytes(figures: AdmissionFigures): number {
  const free = BigInt(figures.ceiling.bytes) - BigInt(figures.readings.beforeWorkingSet.bytes) - BigInt(figures.commitments.totalBytes) - BigInt(ADMISSION_MARGIN_BYTES)
  return free > BigInt(0) ? Number(free) : 0
}

/**
 * The memory fit at N shards (b.uqm SR-6.7): W + the commitments + N × the cap
 * + the 1 GiB admission margin ≤ C, compared in whole bytes. Any blocking
 * container fails it whatever the readings.
 */
export function memoryFits(figures: AdmissionFigures, shards: number, capBytes: number): boolean {
  if (figures.commitments.blocking.length > 0) return false
  const need = BigInt(figures.readings.beforeWorkingSet.bytes) + BigInt(figures.commitments.totalBytes) + BigInt(shards) * BigInt(capBytes) + BigInt(ADMISSION_MARGIN_BYTES)
  return need <= BigInt(figures.ceiling.bytes)
}

/**
 * The disk fit (b.uqm SR-6.7): (used + the 1 GiB allowance) ÷ (used +
 * available) < the 85% disk line, compared in integers as (used + allowance)
 * × 100 < 85 × (used + available). A volume with no bytes fails it.
 */
export function diskFits(volume: VolumeReading): boolean {
  const used = BigInt(volume.usedBytes)
  const whole = used + BigInt(volume.availableBytes)
  return (used + BigInt(DISK_CHECK_ALLOWANCE_BYTES)) * BigInt(PERCENT_WHOLE) < BigInt(DISK_LINE_PERCENT) * whole
}

/** The CPU fit at N shards (b.uqm SR-6.6, SR-6.7): h + 2 × N ≤ the 12 CI CPUs. */
export function cpuFits(reservedCpus: number, shards: number): boolean {
  return reservedCpus + CPUS_PER_SHARD * shards <= CI_CPUS
}

/** The N-dependent limits that fail at N shards, memory then CPU. */
function shardFitFailures(figures: AdmissionFigures, shards: number, capBytes: number): ShardFitLimit[] {
  const failed: ShardFitLimit[] = []
  if (!memoryFits(figures, shards, capBytes)) failed.push('memory')
  if (!cpuFits(figures.commitments.reservedCpus, shards)) failed.push('cpu')
  return failed
}

/** The largest N, from `fromShards` down to 1, that passes both the memory and the CPU fit; null when none does. */
function largestFittingShards(figures: AdmissionFigures, fromShards: number, capBytes: number): number | null {
  for (let shards = fromShards; shards >= OPTION_RANGE_MIN; shards--) {
    if (shardFitFailures(figures, shards, capBytes).length === 0) return shards
  }
  return null
}

/**
 * Throws unless the request holds whole numbers: an effective N of at least 1,
 * at most r and at most the larger of 1 and u (b.uqm SR-3.4), and a positive cap.
 */
function assertAdmissionRequest(request: AdmissionRequest): void {
  for (const [name, value] of [['requestedShards', request.requestedShards], ['units', request.units], ['effectiveShards', request.effectiveShards], ['capBytes', request.capBytes]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`decideAdmission: ${name} is not a whole number: ${value}`)
  }
  if (request.effectiveShards < OPTION_RANGE_MIN) throw new Error(`decideAdmission: effectiveShards is below ${OPTION_RANGE_MIN}: ${request.effectiveShards}`)
  if (request.effectiveShards > request.requestedShards) throw new Error(`decideAdmission: effectiveShards ${request.effectiveShards} is above requestedShards ${request.requestedShards}`)
  const unitBound = Math.max(OPTION_RANGE_MIN, request.units)
  if (request.effectiveShards > unitBound) throw new Error(`decideAdmission: effectiveShards ${request.effectiveShards} is above max(${OPTION_RANGE_MIN}, units) ${unitBound}`)
  if (request.capBytes === 0) throw new Error('decideAdmission: capBytes is 0')
}

/** The figures every decision carries, admitted or refused (b.uqm SR-6.7, SR-6.8). */
export interface AdmissionDecisionFigures {
  readonly request: AdmissionRequest
  /** The readings, C with its source, and the commitments. */
  readonly admission: AdmissionFigures
  /** f: C − W − commitments − margin, never below 0. */
  readonly freeBytes: number
  /** h: the CPUs of the other live `/ci` reservations. */
  readonly reservedCpus: number
  /** The largest `--shards` value, at most the effective N, that passes both the memory and the CPU fit now; null when none does. */
  readonly largestFittingShards: number | null
  /** Whether the disk fit passed. */
  readonly diskFits: boolean
}

/** One reason the shard-count line may give (b.uqm SR-6.7): the scheduling units, memory, CPU. */
export type ShardCountReason = 'units' | ShardFitLimit

/** What the shard-count line is built from (b.uqm SR-6.7): n, r, u, the reasons that applied, f, C and h. */
export interface ShardCountLineInput {
  /** n: the shards admission chose. */
  readonly shards: number
  /** r: the requested N. */
  readonly requestedShards: number
  /** u: the scheduling units. */
  readonly units: number
  /** The reasons that applied, in any order; the line gives them as units, memory, CPU. */
  readonly reasons: readonly ShardCountReason[]
  /** f, in bytes. */
  readonly freeBytes: number
  /** C, in bytes. */
  readonly ceilingBytes: number
  /** h. */
  readonly reservedCpus: number
}

/** An admitted run (b.uqm SR-6.7): its N and the shard-count line's data. */
export interface AdmittedDecision {
  readonly kind: 'admitted'
  /** N: the shards admission chose. */
  readonly shards: number
  /** The N-dependent limits that fail at N + 1, when N + 1 is at most the effective N; none otherwise. */
  readonly limitsAtNext: readonly ShardFitLimit[]
  /** The shard-count line's data: the units reason when the effective N is below r, then `limitsAtNext`. */
  readonly line: ShardCountLineInput
  readonly figures: AdmissionDecisionFigures
}

/** A refused run (b.uqm SR-6.7, SR-6.8): the limits that failed, at the N it was judged at. */
export interface RefusedDecision {
  readonly kind: 'refused'
  /** The N the memory and CPU fits were judged at: 1 for a run that can choose its N, else the effective N. */
  readonly judgedShards: number
  /** Each limit that failed, in the order memory, disk, CPU: disk when its fit failed, memory and CPU when they fail at the judged N. Never empty. */
  readonly failedLimits: readonly AdmissionLimit[]
  readonly figures: AdmissionDecisionFigures
  /** The refusal record (T5, b.uqm SR-6.8): `failedLimits`' first gives the kind and summary, each other follows in the details. E13 records it last. */
  readonly refusal: Refusal
}

/** Admission's decision (b.uqm SR-5.3 step 9, SR-6.7). */
export type AdmissionDecision = AdmittedDecision | RefusedDecision

/**
 * The disk check, then the memory and CPU fits, choosing N (b.uqm SR-5.3
 * step 9, SR-6.7). A run that can choose takes the largest N, from the
 * effective N down to 1, that passes both fits; any other takes exactly the
 * effective N. The run is refused when the disk fit fails or when no N it may
 * take passes both fits; the refusal names each failed limit (memory and CPU
 * judged at 1 for a run that can choose, else at the effective N). Every
 * decision carries f, h, the largest `--shards` value that fits now, and the
 * readings. A refused decision also carries its refusal record (T5,
 * `admissionRefusal`); `listResultsDirs` is called only when the disk fit
 * failed, for the disk message's listing (E13 passes
 * `() => listResultsDirectories(deps.env)`). Pure apart from that call;
 * throws only for a malformed request.
 */
export function decideAdmission(admission: AdmissionFigures, request: AdmissionRequest, listResultsDirs: ResultsDirectoryLister): AdmissionDecision {
  assertAdmissionRequest(request)
  const largest = largestFittingShards(admission, request.effectiveShards, request.capBytes)
  const figures: AdmissionDecisionFigures = {
    request,
    admission,
    freeBytes: freeShardMemoryBytes(admission),
    reservedCpus: admission.commitments.reservedCpus,
    largestFittingShards: largest,
    diskFits: diskFits(admission.readings.volume),
  }
  // The search starts at the effective N, so a run that cannot choose fits exactly when the largest is the effective N.
  const chosen = request.canChooseShards || largest === request.effectiveShards ? largest : null
  if (!figures.diskFits || chosen === null) {
    const judgedShards = request.canChooseShards ? OPTION_RANGE_MIN : request.effectiveShards
    const failed = new Set<AdmissionLimit>(shardFitFailures(admission, judgedShards, request.capBytes))
    if (!figures.diskFits) failed.add('disk')
    const failedLimits = ADMISSION_LIMIT_ORDER.filter((limit) => failed.has(limit))
    return { kind: 'refused', judgedShards, failedLimits, figures, refusal: admissionRefusal(failedLimits, judgedShards, figures, listResultsDirs) }
  }
  const limitsAtNext = chosen < request.effectiveShards ? shardFitFailures(admission, chosen + 1, request.capBytes) : []
  const unitReason: ShardCountReason[] = request.effectiveShards < request.requestedShards ? ['units'] : []
  return {
    kind: 'admitted',
    shards: chosen,
    limitsAtNext,
    line: {
      shards: chosen,
      requestedShards: request.requestedShards,
      units: request.units,
      reasons: [...unitReason, ...limitsAtNext],
      freeBytes: figures.freeBytes,
      ceilingBytes: admission.ceiling.bytes,
      reservedCpus: figures.reservedCpus,
    },
    figures,
  }
}

/**
 * The shard-count line's reason texts (b.uqm SR-6.7), in their fixed order:
 * `<u> scheduling unit(s)`, `memory: <f> GiB free under the <C> GiB ceiling`,
 * `cpu: <h> of 12 CI CPUs in use`, each given when it applied; none when n is
 * not below r. GiB figures to one decimal place (`formatGib`). What
 * `results.json`'s `shardCount.reasons` holds.
 */
export function shardCountReasonTexts(input: ShardCountLineInput): string[] {
  if (input.shards >= input.requestedShards) return []
  const applied = new Set(input.reasons)
  const texts: string[] = []
  if (applied.has('units')) texts.push(`${input.units} scheduling unit(s)`)
  if (applied.has('memory')) texts.push(`memory: ${formatGib(input.freeBytes)} GiB free under the ${formatGib(input.ceilingBytes)} GiB ceiling`)
  if (applied.has('cpu')) texts.push(`cpu: ${input.reservedCpus} of ${CI_CPUS} CI CPUs in use`)
  return texts
}

/**
 * The shard-count line (b.uqm SR-6.7): `shards: <n> of <r>`, followed by
 * ` (<reasons>)` when n is below r, the reasons separated by a comma and a
 * space in the order units, memory, CPU. E10 and E13 place it.
 */
export function formatShardCountLine(input: ShardCountLineInput): string {
  const head = `${SHARD_COUNT_LINE_PREFIX}${input.shards} of ${input.requestedShards}`
  const reasons = shardCountReasonTexts(input)
  return reasons.length === 0 ? head : `${head} (${reasons.join(SHARD_COUNT_REASON_SEPARATOR)})`
}

/** The shard-count line of a run that ended before admission chose its N, whatever its arguments (b.uqm SR-6.7): `shards: 0 of <r> (ended before admission)`. */
export function endedBeforeAdmissionShardCountLine(requestedShards: number): string {
  return `${SHARD_COUNT_LINE_PREFIX}0 of ${requestedShards} (${ENDED_BEFORE_ADMISSION_REASON})`
}

// --- 10/T5 (E6 T5): refusal messages ---

/** The memory refusal's advice, its last detail line, exactly as b.uqm SR-6.8 gives it. */
export const MEMORY_REFUSAL_ADVICE = `what to do: finish or kill idle agent-director workers and confirm their tmux sessions are gone; stop the other CI runs or builds listed; then re-run /ci. Page cache cannot be dropped in this pod and is reclaimed only by the kernel. A re-run is worthwhile once the sysadmin monitor's reading is back below its ${MEMORY_CEILING_PERCENT}% warn line, or once W is back below the ceiling.`
/** The disk refusal's advice (b.uqm SR-6.8). */
export const DISK_REFUSAL_ADVICE = 'what to do: remove results directories and other large files that are not needed on that volume, then re-run.'
/** The disk refusal's last detail line: Docker's storage, which the disk check does not count (b.uqm SR-6.8, SR-19.9). */
export const DOCKER_STORAGE_NOTE = "Docker's images live on /var/lib/docker, which this check does not count."
/** The CPU refusal's advice, its last detail line (b.uqm SR-6.8). */
export const CPU_REFUSAL_ADVICE = 'what to do: wait for or cancel a listed run (signal its runner PID), or re-run with a --shards value that fits.'
/** The pod-limit ceiling's source, after `85% of the <L> GiB pod limit, ` (b.uqm SR-6.8). */
export const POD_LIMIT_CEILING_SOURCE_TEXT = "the sysadmin monitor's warn line"
/** The `/ci-live` ceiling's source, after `40.0 GiB, ` (b.uqm SR-6.8). */
export const CI_LIVE_CEILING_SOURCE_TEXT = "/ci-live's working-set stop line"
/** The memory and CPU refusals' detail line when some `--shards` value fits now; the value follows (b.uqm SR-6.7, SR-6.8). */
export const LARGEST_FITTING_SHARDS_PREFIX = 'largest --shards value that fits now: '
/** The memory and CPU refusals' detail line when no `--shards` value fits now (b.uqm SR-6.8). */
export const NO_FITTING_SHARDS_TEXT = 'no --shards value fits now, not even 1'
/** A legacy results directory's name, `cscb-ci-<digits>-<six letters or digits>`, as the skill of 946be79 made it with `mktemp -d -t cscb-ci-${RUN_ID}-XXXXXX` (b.uqm SR-6.8). */
export const LEGACY_RESULTS_DIR_PATTERN = /^cscb-ci-[0-9]+-[A-Za-z0-9]{6}$/

/** `cscb-ci*`, the container names admission reads, as the messages write them. */
const CI_CONTAINER_NAME_GLOB = `${CI_CONTAINER_NAME_PREFIX}*`
/** `cscb-ci=1`, as the messages write it. */
const CI_LABEL_TEXT = `${CI_LABEL}=${CI_LABEL_VALUE}`

/** A blocking container's detail line opens with this, then `: container <name>, ` (b.uqm SR-6.8). */
export const BLOCKING_EVERY_RUN_TEXT = 'blocking every run'
/** What an unlabelled blocking container is, in its detail line: `an uncapped cscb-ci* container` (b.uqm SR-6.6, SR-6.8). */
export const UNCAPPED_CI_CONTAINER_TEXT = `an uncapped ${CI_CONTAINER_NAME_GLOB} container`
/** A labelled container with no live reservation, after `labelled cscb-ci=1 ` in the blocking and counted-container lines (b.uqm SR-6.6). */
export const NO_LIVE_RESERVATION_TEXT = 'with no live reservation'
/** What a labelled blocking container is, in its detail line, before ` (owner <RUN_ID>-<PID>)`: `an uncapped container labelled cscb-ci=1 with no live reservation`, with no `cscb-ci*` glob (b.uqm SR-6.6, SR-6.8). */
export const UNCAPPED_LABELLED_CONTAINER_TEXT = `an uncapped container labelled ${CI_LABEL_TEXT} ${NO_LIVE_RESERVATION_TEXT}`
/** A labelled container's owner text, inside the parentheses, when its owner label is missing or malformed (b.uqm SR-6.3). */
export const NO_VALID_OWNER_LABEL_TEXT = 'no valid owner label'
/** An unlabelled blocking container's detail line ends with this, after `; ` (b.uqm SR-6.6): `/ci` never removes it. */
export const CI_NEVER_REMOVES_TEXT = '/ci never removes it'
/** A labelled blocking container's detail line ends with this, after `; `: the sweep removes a labelled container once its owner is dead (b.uqm SR-6.4). */
export const CI_SWEEP_REMOVES_TEXT = "a later /ci run's sweep removes it once its owner is dead"
/** The memory refusal's commitments line when nothing is counted, after `counted commitments: 0.0 GiB, ` (b.uqm SR-6.8). */
export const NOTHING_ELSE_COUNTED_TEXT = 'nothing else is counted'
/** The CPU refusal's detail line when no other live `/ci` run holds CPUs (b.uqm SR-6.8). */
export const NO_OTHER_CI_RUN_HOLDS_CPUS_TEXT = 'no other /ci run holds CPUs'
/** The disk refusal's detail line when the temp directory holds no results directory; the temp directory follows after a space (b.uqm SR-6.8). */
export const NO_RESULTS_DIRECTORIES_TEXT = 'no /ci results directories in'
/** The disk refusal's detail line when the temp directory could not be listed: `the /ci results directories in <dir> could not be listed: <error>`. */
export const RESULTS_LISTING_FAILED_TEXT = 'could not be listed'
/** A results directory sized only in part: `at least <x> GiB (part of it could not be read: <path>: <code>)`. */
export const PART_UNREADABLE_TEXT = 'part of it could not be read'
/** The temp directory of a listing whose lister threw, so the directory it read is not known. */
export const UNKNOWN_TEMP_DIR_TEXT = '(unknown)'

/** A results directory's name shape (b.uqm SR-6.8): `new` is `cscb-ci-<RUN_ID>` (SR-5.1), `legacy` the 946be79 skill's. */
export type ResultsDirectoryStyle = 'new' | 'legacy'

/** One `/ci` results directory in the system temp directory, a real directory and not a link (b.uqm SR-6.8). */
export interface ResultsDirectory {
  readonly name: string
  /** The temp directory and its name joined with one `/`, never normalized. */
  readonly path: string
  readonly style: ResultsDirectoryStyle
  /** The apparent sizes (`st.size`) of the regular files under it, at any depth, no link followed; directories and links add nothing. */
  readonly sizeBytes: number
  /** Why part of it could not be sized, or why the entry itself could not be `lstat`ed (the first such failure, on one line: `<path>: <errno code>`); null when all of it was sized. `sizeBytes` is then a lower bound. */
  readonly unreadable: string | null
}

/** The results directories of the system temp directory, largest first, or why they could not be listed. */
export type ResultsDirectoryListing =
  | {
      readonly ok: true
      readonly tempDir: string
      readonly directories: readonly ResultsDirectory[]
    }
  | {
      readonly ok: false
      readonly tempDir: string
      /** On one line. */
      readonly error: string
    }

/** What the decision calls, only when the disk fit failed, for the disk message's listing. */
export type ResultsDirectoryLister = () => ResultsDirectoryListing

/** One failed limit's part of an admission refusal (b.uqm SR-6.8): its kind, its summary (after `<kind>: `) and its detail lines. */
export interface AdmissionRefusalPart {
  readonly kind: AdmissionLimit
  readonly summary: string
  readonly details: readonly string[]
}

/** A name's results-directory shape: `new` for `cscb-ci-<RUN_ID>`, `legacy` for `cscb-ci-<digits>-<six letters or digits>`, null for any other name (b.uqm SR-6.8). */
export function resultsDirectoryStyle(name: string): ResultsDirectoryStyle | null {
  if (!name.startsWith(RUN_DIR_PREFIX)) return null
  if (isRunId(name.slice(RUN_DIR_PREFIX.length))) return 'new'
  return LEGACY_RESULTS_DIR_PATTERN.test(name) ? 'legacy' : null
}

/** Why an entry could not be read, on one line: its path as shown, then the errno code, or the error's text when it has none, so the path is not repeated raw. */
function unreadableEntryText(path: string, err: unknown): string {
  return `${shownArgument(path)}: ${errnoCode(err) ?? dependencyErrorText(err)}`
}

/**
 * A directory tree's size: the apparent sizes (`st.size`, never blocks) of the
 * regular files under it, at any depth, by `lstat`, so no link is followed
 * and directories and links add nothing. An entry that vanishes meanwhile adds
 * nothing; any other failure is kept (the first) and sizing goes on. Paths
 * are bytes, so no file name is lost to its encoding, and each is joined with
 * one `/`, never normalized, as `root` was.
 */
function sizeDirectoryTree(root: string): { readonly bytes: number; readonly unreadable: string | null } {
  const separator = Buffer.from('/')
  const pending: Buffer[] = [Buffer.from(root)]
  let bytes = 0
  let unreadable: string | null = null
  const note = (path: Buffer, err: unknown): void => {
    if (unreadable === null && errnoCode(err) !== 'ENOENT') unreadable = unreadableEntryText(path.toString(), err)
  }
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let names: Buffer[]
    try {
      names = listResultsDir(dir, { encoding: 'buffer' })
    } catch (err) {
      note(dir, err)
      continue
    }
    for (const name of names) {
      const path = Buffer.concat([dir, separator, name])
      try {
        const stat = lstatResultsEntry(path)
        if (stat.isFile()) bytes += stat.size
        else if (stat.isDirectory()) pending.push(path)
      } catch (err) {
        note(path, err)
      }
    }
  }
  return { bytes, unreadable }
}

/** Largest first; a tie by name, in code-unit order, so the order is stable. */
function compareResultsDirectories(a: ResultsDirectory, b: ResultsDirectory): number {
  if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * The `/ci` results directories kept in the system temp directory
 * (`systemTempDir(env)`, b.uqm SR-5.1, SR-6.8), largest first: every entry
 * named `cscb-ci-<RUN_ID>` or `cscb-ci-<digits>-<six letters or digits>` that
 * `lstat` finds to be a directory, so a link or a file of such a name is left
 * out, each with its size (`sizeDirectoryTree`). Each entry's path is the temp
 * directory and its name joined with one `/`, never normalized, as
 * `runDirPath` joins them (`TMPDIR=/a/link/../b` keeps its `..`). An entry
 * that vanishes before its `lstat` is left out; one whose `lstat` fails
 * otherwise is kept, 0 bytes with `unreadable` set, so the listing never says
 * there are none when there may be. A temp directory that cannot be read is a
 * failed listing, never a throw. Only reads.
 */
export function listResultsDirectories(env: Readonly<Record<string, string | undefined>>): ResultsDirectoryListing {
  const tempDir = systemTempDir(env)
  let names: string[]
  try {
    names = listResultsDir(tempDir)
  } catch (err) {
    return { ok: false, tempDir, error: dependencyErrorText(err) }
  }
  const parent = tempDir === '/' ? '' : tempDir
  const directories: ResultsDirectory[] = []
  for (const name of names) {
    const style = resultsDirectoryStyle(name)
    if (style === null) continue
    const path = `${parent}/${name}`
    try {
      if (!lstatResultsEntry(path).isDirectory()) continue
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') directories.push({ name, path, style, sizeBytes: 0, unreadable: unreadableEntryText(path, err) })
      continue
    }
    const size = sizeDirectoryTree(path)
    directories.push({ name, path, style, sizeBytes: size.bytes, unreadable: size.unreadable })
  }
  return { ok: true, tempDir, directories: directories.sort(compareResultsDirectories) }
}

/**
 * A share as a percentage to one decimal place, rounded to the nearest tenth
 * with a tie rounding up, computed exactly (b.uqm SR-6.8): `84.9`, with no
 * `%`. A whole of 0 bytes reads `100.0`: a volume with no room is full.
 */
export function formatPercent(partBytes: number, wholeBytes: number): string {
  assertWholeBytes('formatPercent', partBytes)
  assertWholeBytes('formatPercent', wholeBytes)
  if (wholeBytes === 0) return `${PERCENT_WHOLE}.0`
  const whole = BigInt(wholeBytes)
  const scaled = BigInt(partBytes) * BigInt(PERCENT_WHOLE * 10)
  const tenths = scaled / whole + (BigInt(2) * (scaled % whole) >= whole ? BigInt(1) : BigInt(0))
  return `${tenths / BigInt(10)}.${tenths % BigInt(10)}`
}

/** The memory and CPU refusals' largest-value line (b.uqm SR-6.8): `largest --shards value that fits now: 5`, or that none does. */
export function largestFittingShardsText(largest: number | null): string {
  return largest === null ? NO_FITTING_SHARDS_TEXT : `${LARGEST_FITTING_SHARDS_PREFIX}${largest}`
}

/** An active `/ci-live` run named by what showed it and its PID (b.uqm SR-6.8): `the real-run lock <path>, PID 4242`. */
export function ciLiveRunText(run: CiLiveRunSeen): string {
  const what = shownArgument(run.what)
  const shown = run.via === 'real-run-lock' ? `the real-run lock ${what}` : run.via === 'dry-run-lock' ? `the dry-run lock ${what}` : `the container ${what}`
  return run.pid === null ? `${shown}, with no PID in its name` : `${shown}, PID ${run.pid}`
}

/**
 * The ceiling and its source (b.uqm SR-6.8): `ceiling: 54.4 GiB, 85% of the
 * 64.0 GiB pod limit, the sysadmin monitor's warn line`, or `ceiling: 40.0
 * GiB, /ci-live's working-set stop line, while a /ci-live run is active: `
 * and each active run (`ciLiveRunText`), separated by `; `.
 */
export function ceilingSourceText(ceiling: MemoryCeiling): string {
  const head = `ceiling: ${formatGib(ceiling.bytes)} GiB, `
  if (ceiling.source.kind === 'pod-limit') {
    return `${head}${MEMORY_CEILING_PERCENT}% of the ${formatGib(ceiling.source.limitBytes)} GiB pod limit, ${POD_LIMIT_CEILING_SOURCE_TEXT}`
  }
  const runs = ceiling.source.runs
  const which = runs.length === 1 ? 'a /ci-live run is' : '/ci-live runs are'
  return `${head}${CI_LIVE_CEILING_SOURCE_TEXT}, while ${which} active: ${runs.map(ciLiveRunText).join('; ')}`
}

/** A labelled container's owner, as its counted and blocking lines write it inside parentheses: `owner <RUN_ID>-<PID>`, or `no valid owner label`. */
function labelledOwnerText(owner: Owner | null): string {
  return owner === null ? NO_VALID_OWNER_LABEL_TEXT : `owner ${formatOwner(owner)}`
}

/** One counted commitment's detail line, with its counted GiB (b.uqm SR-6.6, SR-6.8). */
function commitmentText(item: MemoryCommitment): string {
  const counted = `${formatGib(item.countedBytes)} GiB`
  switch (item.kind) {
    case 'reservation': {
      const { runId, pid, shards, memoryBytes } = item.reservation
      return `counted: /ci run ${runId} (runner PID ${pid}, ${shards} shard(s)): ${counted}, its ${formatGib(memoryBytes)} GiB reservation less ${formatGib(item.shardMemoryBytes)} GiB in its running shard containers`
    }
    case 'ci-live': {
      const own = item.ownContainers.length === 0 ? '' : `, its own container(s) ${item.ownContainers.map(shownArgument).join(', ')} included`
      return `counted: /ci-live run shown by ${ciLiveRunText(item.run)}: ${counted}${own}`
    }
    case 'labelled-container':
      return `counted: container ${shownArgument(item.name)}, labelled ${CI_LABEL_TEXT} ${NO_LIVE_RESERVATION_TEXT} (${labelledOwnerText(item.owner)}): ${counted}, its cap`
    case 'unlabelled-container':
      return `counted: container ${shownArgument(item.name)}, an unlabelled ${CI_CONTAINER_NAME_GLOB} container: ${counted}, its cap`
  }
}

/**
 * A blocking container's detail line (b.uqm SR-6.6, SR-6.8), blocking every
 * run: an unlabelled one as an uncapped `cscb-ci*` container `/ci` never
 * removes; a labelled one as an uncapped `cscb-ci=1` container with no live
 * reservation, its owner from its owner label, that a later run's sweep
 * removes once that owner is dead (SR-6.4).
 */
function blockingText(container: BlockingContainer): string {
  const head = `${BLOCKING_EVERY_RUN_TEXT}: container ${shownArgument(container.name)}`
  if (!container.labelled) return `${head}, ${UNCAPPED_CI_CONTAINER_TEXT}; ${CI_NEVER_REMOVES_TEXT}`
  return `${head}, ${UNCAPPED_LABELLED_CONTAINER_TEXT} (${labelledOwnerText(container.owner)}); ${CI_SWEEP_REMOVES_TEXT}`
}

/**
 * The memory refusal (b.uqm SR-6.8): `<n> shard(s) need <x> GiB; <f> GiB fits
 * under the <C> GiB ceiling`, n being the judged N and x n × the cap; then the
 * ceiling and its source, W split into anon, active page cache and the rest,
 * the counted commitments with each item's counted GiB, each blocking
 * container, the admission margin and the cap, the largest `--shards` value
 * that fits now (or that none does), and the advice.
 */
export function memoryRefusalPart(judgedShards: number, figures: AdmissionDecisionFigures): AdmissionRefusalPart {
  const { admission, request } = figures
  const w = admission.readings.beforeWorkingSet
  const { commitments } = admission
  const counted =
    commitments.items.length === 0
      ? [`counted commitments: ${formatGib(0)} GiB, ${NOTHING_ELSE_COUNTED_TEXT}`]
      : [`counted commitments: ${formatGib(commitments.totalBytes)} GiB`, ...commitments.items.map(commitmentText)]
  return {
    kind: 'memory',
    summary: `${judgedShards} shard(s) need ${formatGib(judgedShards * request.capBytes)} GiB; ${formatGib(figures.freeBytes)} GiB fits under the ${formatGib(admission.ceiling.bytes)} GiB ceiling`,
    details: [
      ceilingSourceText(admission.ceiling),
      `pod working set W: ${formatGib(w.bytes)} GiB (anon ${formatGib(w.anonBytes)} GiB, active page cache ${formatGib(w.activeFileBytes)} GiB, the rest ${formatGib(workingSetRestBytes(w))} GiB)`,
      ...counted,
      ...commitments.blocking.map(blockingText),
      `admission margin: ${formatGib(ADMISSION_MARGIN_BYTES)} GiB; per-shard cap: ${formatGib(request.capBytes)} GiB`,
      largestFittingShardsText(figures.largestFittingShards),
      MEMORY_REFUSAL_ADVICE,
    ],
  }
}

/** A results directory's detail line: its path and size, or a lower bound when part of it could not be read. */
function resultsDirectoryText(dir: ResultsDirectory): string {
  const size = `${formatGib(dir.sizeBytes)} GiB`
  const shown = dir.unreadable === null ? size : `at least ${size} (${PART_UNREADABLE_TEXT}: ${dir.unreadable})`
  return `results directory ${shownArgument(dir.path)}: ${shown}`
}

/** The listing's detail lines: each results directory, largest first; that there are none; or that the listing could not be read. */
function resultsListingTexts(listing: ResultsDirectoryListing): string[] {
  const tempDir = shownArgument(listing.tempDir)
  if (!listing.ok) return [`the /ci results directories in ${tempDir} ${RESULTS_LISTING_FAILED_TEXT}: ${dependencyErrorText(listing.error)}`]
  if (listing.directories.length === 0) return [`${NO_RESULTS_DIRECTORIES_TEXT} ${tempDir}`]
  return listing.directories.map(resultsDirectoryText)
}

/**
 * The disk refusal (b.uqm SR-6.8): `<volume> is <p>% used; this run's 1 GiB
 * would take it to <q>%, at or over /ci's 85% disk line`, p being used ÷
 * (used + available) and q (used + 1 GiB) ÷ (used + available); then the
 * volume's used and total GiB, the results directories, largest first, the
 * advice and the note on Docker's storage.
 */
export function diskRefusalPart(volume: VolumeReading, listing: ResultsDirectoryListing): AdmissionRefusalPart {
  const totalBytes = volume.usedBytes + volume.availableBytes
  const p = formatPercent(volume.usedBytes, totalBytes)
  const q = formatPercent(volume.usedBytes + DISK_CHECK_ALLOWANCE_BYTES, totalBytes)
  const mount = shownArgument(volume.mountPoint)
  return {
    kind: 'disk',
    summary: `${mount} is ${p}% used; this run's ${DISK_CHECK_ALLOWANCE_BYTES / GIB_BYTES} GiB would take it to ${q}%, at or over /ci's ${DISK_LINE_PERCENT}% disk line`,
    details: [
      `volume ${mount}: ${formatGib(volume.usedBytes)} GiB used of ${formatGib(totalBytes)} GiB`,
      ...resultsListingTexts(listing),
      DISK_REFUSAL_ADVICE,
      DOCKER_STORAGE_NOTE,
    ],
  }
}

/**
 * The CPU refusal (b.uqm SR-6.8): `<n> shard(s) need <c> CPUs; active /ci
 * runs hold <h> of the 12 CI CPUs`, c being 2 × n; then each active run
 * (RUN_ID, runner PID, shards, CPUs, full or selective), the largest
 * `--shards` value that fits now (or that none does), and the advice.
 */
export function cpuRefusalPart(judgedShards: number, figures: AdmissionDecisionFigures): AdmissionRefusalPart {
  const runs = figures.admission.commitments.items.flatMap((item) => (item.kind === 'reservation' ? [item.reservation] : []))
  const runTexts =
    runs.length === 0
      ? [NO_OTHER_CI_RUN_HOLDS_CPUS_TEXT]
      : runs.map((run) => `active /ci run ${run.runId}: runner PID ${run.pid}, ${run.shards} shard(s), ${run.cpus} CPUs, ${run.kind}`)
  return {
    kind: 'cpu',
    summary: `${judgedShards} shard(s) need ${CPUS_PER_SHARD * judgedShards} CPUs; active /ci runs hold ${figures.reservedCpus} of the ${CI_CPUS} CI CPUs`,
    details: [...runTexts, largestFittingShardsText(figures.largestFittingShards), CPU_REFUSAL_ADVICE],
  }
}

/** The results-directory listing for the disk message; a lister that throws is a failed listing, so the refusal is still built. */
function listResultsDirectoriesSafely(listResultsDirs: ResultsDirectoryLister): ResultsDirectoryListing {
  try {
    return listResultsDirs()
  } catch (err) {
    return { ok: false, tempDir: UNKNOWN_TEMP_DIR_TEXT, error: dependencyErrorText(err) }
  }
}

/**
 * The admission refusal record (b.uqm SR-5.8, SR-6.8) from the failed limits,
 * in the order memory, disk, CPU: the first gives the kind and summary and its
 * details; each other follows in the details as `<kind>: <summary>`, then its
 * own details. memory and CPU are judged at `judgedShards`. `listResultsDirs`
 * is called only when disk failed. Throws for an empty list of failed limits.
 */
export function admissionRefusal(
  failedLimits: readonly AdmissionLimit[],
  judgedShards: number,
  figures: AdmissionDecisionFigures,
  listResultsDirs: ResultsDirectoryLister,
): Refusal {
  const parts = ADMISSION_LIMIT_ORDER.filter((limit) => failedLimits.includes(limit)).map((limit): AdmissionRefusalPart => {
    if (limit === 'memory') return memoryRefusalPart(judgedShards, figures)
    if (limit === 'disk') return diskRefusalPart(figures.admission.readings.volume, listResultsDirectoriesSafely(listResultsDirs))
    return cpuRefusalPart(judgedShards, figures)
  })
  const [first, ...others] = parts
  if (first === undefined) throw new Error('admissionRefusal: no limit failed')
  const details = [...first.details, ...others.flatMap((part) => [`${part.kind}: ${part.summary}`, ...part.details])]
  return buildRefusal(first.kind, first.summary, details)
}

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

// --- 14/T1 (E10 T1): shard subdirectories into script results, shard outcomes, cause texts and end lines, the pass condition ---
//
// E10's first layer, which T2 (the verdict) and T3 (`results.json` and the
// summary) build on: each shard's subdirectory becomes per-script results
// (b.uqm SR-11.3, with SR-12.4's script-line rule), each shard gets exactly one
// outcome with its cause and end line (b.uqm SR-12.1, SR-3.6), and the run's
// pass condition is decided (b.uqm SR-12.3). Every decision is a pure function
// over E1's data model; the `read*` functions only gather a shard
// subdirectory's `result.txt`, script logs and `docker.log` through E1's
// readers (`readResultFile`, `readFileText`) and hand them to the decisions.

// Script results from a shard subdirectory (b.uqm SR-11.3, SR-12.4).

/** The fallback failure line's fixed text, verbatim from `tests/runner.sh` at 946be79 (b.uqm SR-12.4). */
export const NO_FAIL_LINE_TEXT = 'exited non-zero without explicit FAIL line'

/** A failing script's line when its log holds no line beginning `FAIL:` or cannot be read: `FAIL: <file name>: exited non-zero without explicit FAIL line` (b.uqm SR-12.4). */
export function noFailLineFallback(fileName: string): string {
  return `${FAIL_PREFIX}${fileName}: ${NO_FAIL_LINE_TEXT}`
}

/**
 * The first line of a script log that begins `FAIL:`, verbatim and without its
 * line feed; null when no line does (b.uqm SR-12.4). The log is split at line
 * feeds and a last line without one counts, as `tests/runner.sh` at 946be79
 * selects with `grep -m1 '^FAIL:'`. A line with any text before `FAIL:` is
 * never taken, and nothing is re-prefixed.
 */
export function firstFailLine(logText: string): string | null {
  const lineStart = FAIL_PREFIX.trimEnd()
  return logText.split('\n').find((line) => line.startsWith(lineStart)) ?? null
}

/** A failing script's line from its log as read: its first FAIL line, else the fallback; a missing or unreadable log gives the fallback. */
export function scriptFailLineOf(fileName: string, log: FileTextRead): string {
  const line = log.kind === 'text' ? firstFailLine(log.text) : null
  return line ?? noFailLineFallback(fileName)
}

/** A script's log in its shard subdirectory, `<file name>.log` (b.uqm SR-11.3). */
export function shardScriptLogPath(shardDir: string, fileName: string): string {
  return join(shardDir, `${fileName}${SCRIPT_LOG_SUFFIX}`)
}

/** One assigned script as its shard's result file records it (b.uqm SR-11.3). */
export interface RecordedScript {
  readonly fileName: string
  /** Its first recorded result (`end` or `notrun`); null when the file records none for it. */
  readonly result: ScriptResult | 'notrun' | null
  /** Its wall time from its `end` line; null without one. */
  readonly seconds: number | null
  /** For a `fail`: its log's first FAIL line, or the fallback; null otherwise. */
  readonly failLine: string | null
}

/** A shard's result file turned into its assigned scripts' records: missing, unreadable (E1's reading rule), or readable. */
export type ShardScriptsRead =
  | {
      readonly kind: 'missing'
    }
  | {
      readonly kind: 'unreadable'
      readonly error: string
    }
  | {
      readonly kind: 'readable'
      /** Whether the file holds the end marker line. */
      readonly endMarker: boolean
      /** One per assigned script, in run order. */
      readonly scripts: readonly RecordedScript[]
      /** The assigned script with `start` but no `end` (nor `notrun`), the last one started if several; null for none. */
      readonly inProgress: string | null
    }

/**
 * A shard's assigned scripts from its result file as E1 read it (b.uqm
 * SR-11.3). `scriptLog` gives a script's log as read; it is asked only for
 * scripts recorded `fail`. Events naming a script not assigned to the shard
 * are left out (b.uqm SR-13.2's `result-coverage` is E11's); a script's first
 * `end` or `notrun` is its record.
 */
export function shardScriptsOf(resultFile: ResultFileRead, assigned: readonly string[], scriptLog: (fileName: string) => FileTextRead): ShardScriptsRead {
  if (resultFile.kind === 'missing') return { kind: 'missing' }
  if (resultFile.kind === 'unreadable') return { kind: 'unreadable', error: resultFile.error }
  const records = new Map<string, EndEvent | NotRunEvent>()
  const startOrder: string[] = []
  let endMarker = false
  for (const event of resultFile.events) {
    if (event.kind === 'done') endMarker = true
    else if (event.kind === 'start') startOrder.push(event.fileName)
    else if (!records.has(event.fileName)) records.set(event.fileName, event)
  }
  const unfinished = startOrder.filter((fileName) => assigned.includes(fileName) && !records.has(fileName))
  const scripts = assigned.map((fileName): RecordedScript => {
    const record = records.get(fileName)
    if (record === undefined) return { fileName, result: null, seconds: null, failLine: null }
    if (record.kind === 'notrun') return { fileName, result: 'notrun', seconds: null, failLine: null }
    const failLine = record.result === 'fail' ? scriptFailLineOf(fileName, scriptLog(fileName)) : null
    return { fileName, result: record.result, seconds: record.seconds, failLine }
  })
  return { kind: 'readable', endMarker, scripts, inProgress: unfinished.at(-1) ?? null }
}

/** Reads a shard subdirectory's `result.txt` and the logs of its failing scripts into its assigned scripts' records (b.uqm SR-11.3, SR-12.4). */
export function readShardScripts(shardDir: string, assigned: readonly string[]): ShardScriptsRead {
  return shardScriptsOf(readResultFile(shardDir), assigned, (fileName) => readFileText(shardScriptLogPath(shardDir, fileName)))
}

// Cause texts and end lines (b.uqm SR-12.1). E4 and E12 record causes as
// `ShardCause` values; these builders are the only writers of their texts.

/** `wall-time limit of <m> min exceeded`, m whole minutes the caller has already rounded (b.uqm SR-4.3, SR-12.1). Throws for any other m. */
export function wallTimeLimitCauseText(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new Error(`wallTimeLimitCauseText: not whole minutes: ${minutes}`)
  return `wall-time limit of ${minutes} min exceeded`
}

/** `killed`: a `kill:` fault (b.uqm SR-12.1, SR-14.2). */
export function killedCauseText(): string {
  return 'killed'
}

/** The words each run-level stop names itself with in `stopped by <stop>`. */
const STOPPED_BY_WORDS: Readonly<Record<StopKind, string>> = {
  interrupt: 'interrupt',
  'memory-watchdog': 'memory watchdog',
  'run-deadline': 'run deadline',
}

/** `stopped by interrupt`, `stopped by memory watchdog` or `stopped by run deadline` (b.uqm SR-5.6, SR-12.1). */
export function stoppedCauseText(by: StopKind): string {
  return `stopped by ${STOPPED_BY_WORDS[by]}`
}

/** `container exited <code>` (b.uqm SR-12.1). Throws for a code that is no integer. */
export function containerExitedCauseText(code: number): string {
  if (!Number.isSafeInteger(code)) throw new Error(`containerExitedCauseText: not an exit code: ${code}`)
  return `container exited ${code}`
}

/** `container failed to start: <detail>`, the detail on one line (b.uqm SR-10.6, SR-12.1). */
export function containerFailedToStartCauseText(detail: string): string {
  return `container failed to start: ${dependencyErrorText(detail)}`
}

/** `image marker missing` (b.uqm SR-12.1). */
export function imageMarkerMissingCauseText(): string {
  return 'image marker missing'
}

/** `result file unreadable` (b.uqm SR-11.3, SR-12.1). */
export function resultFileUnreadableCauseText(): string {
  return 'result file unreadable'
}

/** `no result file` (b.uqm SR-12.1). */
export function noResultFileCauseText(): string {
  return 'no result file'
}

/** A shard cause's text, through its builder (b.uqm SR-12.1). */
export function shardCauseText(cause: ShardCause): string {
  switch (cause.kind) {
    case 'wall-time-limit':
      return wallTimeLimitCauseText(cause.minutes)
    case 'container-exited':
      return containerExitedCauseText(cause.code)
    case 'killed':
      return killedCauseText()
    case 'stopped':
      return stoppedCauseText(cause.by)
    case 'failed-to-start':
      return containerFailedToStartCauseText(cause.detail)
    case 'image-marker-missing':
      return imageMarkerMissingCauseText()
    case 'no-result-file':
      return noResultFileCauseText()
    case 'result-file-unreadable':
      return resultFileUnreadableCauseText()
  }
}

/**
 * Whether a cause may take the script form of the end line (b.uqm SR-12.1):
 * only `wall-time limit of <m> min exceeded`, `container exited <code>`,
 * `killed` and `stopped by <stop>` do. Every other cause (`container failed to
 * start`, `image marker missing`, `result file unreadable`, `no result file`)
 * always takes the shard form, even with a script in progress.
 */
export function causeTakesScriptEndLine(cause: ShardCause): boolean {
  switch (cause.kind) {
    case 'wall-time-limit':
    case 'container-exited':
    case 'killed':
    case 'stopped':
      return true
    case 'failed-to-start':
    case 'image-marker-missing':
    case 'no-result-file':
    case 'result-file-unreadable':
      return false
  }
}

/** A shard's end line when a script was in progress and the cause takes the script form (`causeTakesScriptEndLine`), `FAIL: <file name>: <cause> in shard-<k>`, ranked as that script's failure (b.uqm SR-12.1). */
export function scriptEndLine(fileName: string, shard: number, cause: ShardCause): string {
  return `${FAIL_PREFIX}${fileName}: ${shardCauseText(cause)} in ${SHARD_DIR_PREFIX}${shard}`
}

/** A shard's end line otherwise, `FAIL: shard-<k>: <cause>` (b.uqm SR-12.1). */
export function shardEndLine(shard: number, cause: ShardCause): string {
  return `${FAIL_PREFIX}${SHARD_DIR_PREFIX}${shard}: ${shardCauseText(cause)}`
}

/** `results.json`'s `end` for a shard that ended normally with no out-of-memory line (b.uqm SR-16.1). */
export const NORMAL_SHARD_END = 'normal'

// Shard outcomes (b.uqm SR-12.1, SR-12.2's replacement rule, SR-3.6).

/** The shard evidence an outcome is decided from: the fields E4, E7, E9, E12 and E13 fill (b.uqm SR-12.1). */
export type ShardOutcomeEvidence = Pick<ShardEvidence, 'shard' | 'assigned' | 'start' | 'fixedCause' | 'exitCode' | 'oomLine'>

/** One shard's outcome: its `results.json` `endedNormally`, `end` and `scripts` entries, and its failures (b.uqm SR-12.1, SR-16.1). */
export interface ShardOutcome {
  readonly shard: number
  /** Its result file is readable and holds the end marker, whatever exit or recorded stop followed. */
  readonly endedNormally: boolean
  /** The cause SR-12.1's precedence chose; null for a shard that ended normally. */
  readonly cause: ShardCause | null
  /** Its out-of-memory line, else its end line, else `normal`. */
  readonly end: string
  /** The failure its `end` line is, classed `out-of-memory`, `script` (a script in progress, with a cause that takes the script form) or `shard`; null when `end` is `normal`. */
  readonly endFailure: Failure | null
  /** One per assigned script, in run order. */
  readonly scripts: readonly ResultsScript[]
  /** Every failure of the shard: `endFailure` when present, then each script recorded `fail` with its failLine, in run order. A `notrun` is never one. */
  readonly failures: readonly Failure[]
}

/** Whether a Docker log's text holds the marker refusal line as a whole line (b.uqm SR-11.2, SR-12.1). */
export function holdsMarkerRefusalLine(dockerLogText: string): boolean {
  return dockerLogText.split('\n').includes(MARKER_REFUSAL_LINE)
}

/** Whether a shard subdirectory's saved Docker logs hold the marker refusal line; a missing or unreadable `docker.log` does not. */
export function dockerLogHoldsMarkerRefusal(shardDir: string): boolean {
  const read = readFileText(join(shardDir, DOCKER_LOG_FILE_NAME))
  return read.kind === 'text' && holdsMarkerRefusalLine(read.text)
}

/** A shard ended normally: its result file is readable and holds the end marker (b.uqm SR-12.1, SR-11.4). */
export function shardEndedNormally(scripts: ShardScriptsRead): boolean {
  return scripts.kind === 'readable' && scripts.endMarker
}

/**
 * The cause of a shard that did not end normally, the first that applies
 * (b.uqm SR-12.1): (1) the cause the runner fixed itself, `fixedCause` (for a
 * shard never created, E13 records the run-level stop's cause there, b.uqm
 * SR-5.6); (2) `container failed to start`;
 * (3) `image marker missing`, only for an exit of 2 with the marker refusal
 * line in its saved Docker logs; (4) `container exited <code>`; (5) `result
 * file unreadable`; (6) `no result file`, which is also the cause when none of
 * the others applies. A runner-made stop's cause is always its recorded one,
 * never the exit code that stop produced.
 */
export function shardCauseOf(evidence: ShardOutcomeEvidence, scripts: ShardScriptsRead, markerRefused: boolean): ShardCause {
  if (evidence.fixedCause !== null) return evidence.fixedCause
  if (evidence.start?.kind === 'failed-to-start') return { kind: 'failed-to-start', detail: evidence.start.detail, fixedByRunner: false }
  if (evidence.exitCode === MARKER_REFUSAL_EXIT_STATUS && markerRefused) return { kind: 'image-marker-missing', fixedByRunner: false }
  if (evidence.exitCode !== null) return { kind: 'container-exited', code: evidence.exitCode, fixedByRunner: false }
  if (scripts.kind === 'unreadable') return { kind: 'result-file-unreadable', fixedByRunner: false }
  return { kind: 'no-result-file', fixedByRunner: false }
}

/**
 * A shard's end failure: its out-of-memory line when it has one, else its end
 * line when it did not end normally, else none (b.uqm SR-12.1, SR-12.2). The
 * end line takes the script form, classed `script`, only with a script in
 * progress and a cause that `causeTakesScriptEndLine` allows; otherwise it
 * takes the shard form, classed `shard`.
 */
function shardEndFailure(evidence: ShardOutcomeEvidence, cause: ShardCause | null, inProgress: string | null): Failure | null {
  const shard = evidence.shard
  if (evidence.oomLine !== null) return { line: evidence.oomLine, shard, failureClass: { kind: 'out-of-memory' } }
  if (cause === null) return null
  if (inProgress !== null && causeTakesScriptEndLine(cause)) return { line: scriptEndLine(inProgress, shard, cause), shard, failureClass: { kind: 'script', fileName: inProgress } }
  return { line: shardEndLine(shard, cause), shard, failureClass: { kind: 'shard' } }
}

/**
 * Decides one shard's outcome (b.uqm SR-12.1, SR-3.6). A shard that ended
 * normally has no cause, and its end is its out-of-memory line or `normal`.
 * Any other shard gets the cause `shardCauseOf` chooses, and its end line is
 * `FAIL: <file name>: <cause> in shard-<k>` when its readable result file has
 * a script in progress and the cause takes the script form
 * (`causeTakesScriptEndLine`), else `FAIL: shard-<k>: <cause>`; an
 * out-of-memory line takes the place of either. Each assigned script without
 * a result is `notrun`; the script in progress at an abnormal end is `fail`
 * with no seconds, its failLine the shard's end, whichever form it takes (its
 * failure is the end failure, never a second one); every other result stays
 * as recorded.
 */
export function decideShardOutcome(evidence: ShardOutcomeEvidence, scripts: ShardScriptsRead, markerRefused: boolean): ShardOutcome {
  const endedNormally = shardEndedNormally(scripts)
  const cause = endedNormally ? null : shardCauseOf(evidence, scripts, markerRefused)
  const records = scripts.kind === 'readable' ? scripts.scripts : []
  const inProgress = !endedNormally && scripts.kind === 'readable' ? scripts.inProgress : null
  const endFailure = shardEndFailure(evidence, cause, inProgress)
  const shard = evidence.shard
  const results = evidence.assigned.map((fileName): ResultsScript => {
    if (fileName === inProgress) return { script: fileName, shard, result: 'fail', seconds: null, failLine: endFailure?.line ?? null }
    const record = records.find((recorded) => recorded.fileName === fileName)
    if (record === undefined || record.result === null || record.result === 'notrun') return { script: fileName, shard, result: 'notrun', seconds: null, failLine: null }
    return { script: fileName, shard, result: record.result, seconds: record.seconds, failLine: record.failLine }
  })
  const scriptFailures = results.flatMap((result): Failure[] =>
    result.result === 'fail' && result.script !== inProgress && result.failLine !== null
      ? [{ line: result.failLine, shard, failureClass: { kind: 'script', fileName: result.script } }]
      : [],
  )
  return {
    shard,
    endedNormally,
    cause,
    end: endFailure?.line ?? NORMAL_SHARD_END,
    endFailure,
    scripts: results,
    failures: endFailure === null ? scriptFailures : [endFailure, ...scriptFailures],
  }
}

/**
 * Reads a shard's subdirectory and decides its outcome: `result.txt` and the
 * failing scripts' logs through `readShardScripts`, and `docker.log` only when
 * the container exited 2. A shard never created takes its cause only from
 * `fixedCause`, where E13 records the run-level stop's cause (b.uqm SR-5.6).
 */
export function readShardOutcome(evidence: ShardOutcomeEvidence, shardDir: string): ShardOutcome {
  const scripts = readShardScripts(shardDir, evidence.assigned)
  const markerRefused = evidence.exitCode === MARKER_REFUSAL_EXIT_STATUS && dockerLogHoldsMarkerRefusal(shardDir)
  return decideShardOutcome(evidence, scripts, markerRefused)
}

// The pass condition (b.uqm SR-12.3, SR-3.6).

/** test-1's number: the script every shard runs first (b.uqm SR-3.3, SR-3.4). */
const EVERY_SHARD_SCRIPT_NUMBER = 1

/** What the pass condition is decided over. Cleanup failures are never an input (b.uqm SR-9.3). */
export interface PassInputs {
  /** The run's expected scripts, file names, test-1 included. */
  readonly expectedScripts: readonly string[]
  /** The shards used, by number. */
  readonly shardsUsed: readonly number[]
  /** The shard outcomes. */
  readonly outcomes: readonly ShardOutcome[]
  /** Every other failure: the first run-level line, an image build line, the integrity failures. */
  readonly otherFailures: readonly Failure[]
}

/**
 * Whether the run passes (b.uqm SR-12.3): no failure line exists (no other
 * failure, and no shard has a script line, an end line or an out-of-memory
 * line); no script entry is `notrun`; test-1 passed in every shard used; and
 * every other expected script passed. Expected scripts without test-1 never
 * pass. A dependent recorded `notrun` after its prerequisite failed adds no
 * failure line of its own: the prerequisite's is the only one (b.uqm SR-3.6),
 * and the `notrun` alone already fails the run.
 */
export function runPasses(inputs: PassInputs): boolean {
  if (inputs.otherFailures.length > 0) return false
  if (inputs.outcomes.some((outcome) => outcome.failures.length > 0)) return false
  const entries = inputs.outcomes.flatMap((outcome) => outcome.scripts)
  if (entries.some((entry) => entry.result === 'notrun')) return false
  const passedIn = (fileName: string, shard: number | null): boolean =>
    entries.some((entry) => entry.script === fileName && entry.result === 'pass' && (shard === null || entry.shard === shard))
  const testOne = inputs.expectedScripts.find((fileName) => fileNameNumber(fileName) === EVERY_SHARD_SCRIPT_NUMBER)
  if (testOne === undefined) return false
  if (!inputs.shardsUsed.every((shard) => passedIn(testOne, shard))) return false
  return inputs.expectedScripts.every((fileName) => passedIn(fileName, null))
}

// --- 14/T2 (E10 T2): the failure ranking, the verdict line, its SELECTIVE prefix and the double guard ---
//
// Every failure of the run ranked into one list by b.uqm SR-12.4's precedence,
// and the one verdict line built from it in the shape the invocation calls for
// (b.uqm SR-12.5, SR-19.6). Pure functions over E1's data model and T1's
// outcomes. Which run-level stop came first, and writing `verdict.txt`, are
// E13's.

// The failure ranking (b.uqm SR-12.4).

/** Each failure class's tier in SR-12.4's precedence, highest first; within a tier the order is `compareFailures`'. */
const FAILURE_TIERS: Readonly<Record<FailureClass['kind'], number>> = {
  'run-level-stop': 0,
  'image-build': 1,
  integrity: 2,
  'out-of-memory': 3,
  shard: 4,
  script: 5,
}

/** The failure classes a shard outcome's failures take (T1's `ShardOutcome.failures`); each carries its shard. */
const SHARD_OUTCOME_FAILURE_KINDS: readonly FailureClass['kind'][] = ['out-of-memory', 'shard', 'script']

/** A failure's tier in SR-12.4's precedence, 0 highest: run-level stop, image build, integrity, out-of-memory, other `shard-<k>`, script. */
export function failureTier(failure: Failure): number {
  return FAILURE_TIERS[failure.failureClass.kind]
}

/**
 * Compares two failures in SR-12.4's precedence (b.uqm SR-12.4): by tier
 * first; out-of-memory and other `shard-<k>` lines by shard number; script
 * failures, a `… in shard-<k>` end line among them, in E1's canonical order
 * of their scripts, then by shard number, so test-1's lowest shard comes
 * first. Run-level, image-build and integrity failures compare equal within
 * their tier, whatever shard an integrity failure carries, so a stable sort
 * keeps their given order (SR-13.2's, for the integrity failures).
 */
export function compareFailures(a: Failure, b: Failure): number {
  const tier = failureTier(a) - failureTier(b)
  if (tier !== 0) return tier
  if (!SHARD_OUTCOME_FAILURE_KINDS.includes(a.failureClass.kind)) return 0
  if (a.failureClass.kind === 'script' && b.failureClass.kind === 'script') {
    const order = compareCanonical(a.failureClass.fileName, b.failureClass.fileName)
    if (order !== 0) return order
  }
  return (a.shard ?? 0) - (b.shard ?? 0)
}

/** The first run-level stop's line as a failure, classed `run-level-stop`, with no shard (b.uqm SR-5.6, SR-12.4). */
export function runLevelFailure(line: string): Failure {
  return { line, shard: null, failureClass: { kind: 'run-level-stop' } }
}

/** The image build failure's line as a failure, classed `image-build`, with no shard (b.uqm SR-9.3, SR-12.4). */
export function imageBuildFailure(line: string): Failure {
  return { line, shard: null, failureClass: { kind: 'image-build' } }
}

/** Every failure source of a run, each from the Epic that owns it (b.uqm SR-12.4). */
export interface FailureSources {
  /** The first run-level stop's line (E13); null for none. */
  readonly runLevelLine: string | null
  /** The image build failure's line (E8); null for none. */
  readonly imageBuildLine: string | null
  /** The integrity failures in SR-13.2's order (E11), each classed `integrity`, each with its shard number or null; ranking keeps this order exactly. */
  readonly integrityFailures: readonly Failure[]
  /** The shard outcomes (T1). */
  readonly outcomes: readonly ShardOutcome[]
}

/** The failures outside the shard outcomes, in tier order: the run-level line, the image build line, then the integrity failures as given. These are `PassInputs.otherFailures`. */
export function otherFailuresOf(sources: FailureSources): Failure[] {
  const runLevel = sources.runLevelLine === null ? [] : [runLevelFailure(sources.runLevelLine)]
  const imageBuild = sources.imageBuildLine === null ? [] : [imageBuildFailure(sources.imageBuildLine)]
  return [...runLevel, ...imageBuild, ...sources.integrityFailures]
}

/**
 * Throws unless a failure is of one of the classes its source gives, and
 * unless an out-of-memory, shard or script failure carries a shard. An
 * integrity failure carries a shard number or null (E11); run-level and
 * image-build entries never reach this check, as `runLevelFailure` and
 * `imageBuildFailure` build them shardless.
 */
function checkFailureSource(failure: Failure, kinds: readonly FailureClass['kind'][], source: string): void {
  const kind = failure.failureClass.kind
  if (!kinds.includes(kind)) throw new Error(`rankFailures: ${source} holds a failure classed ${kind}: ${failure.line}`)
  if (SHARD_OUTCOME_FAILURE_KINDS.includes(kind) && failure.shard === null) throw new Error(`rankFailures: a failure classed ${kind} with shard ${failure.shard}: ${failure.line}`)
}

/**
 * Every failure of the run, ranked by SR-12.4's precedence (b.uqm SR-12.4,
 * SR-16.1 `failures`): the first run-level stop; the image build failure; the
 * integrity failures in exactly their given order (SR-13.2's), never
 * reordered by shard; out-of-memory lines by shard number (`out-of-memory
 * status unreadable` with the kill lines); other `shard-<k>` lines by shard
 * number; script failures in canonical order, test-1's by ascending shard.
 * Every failure is kept, each once: a shard's end line is already its only
 * entry for the script in progress, and `notrun` is never one (T1).
 * Run-level and image-build entries are built shardless by `runLevelFailure`
 * and `imageBuildFailure`; an integrity entry carries its shard number or
 * null, as E11 gives it; every other entry carries its shard. Throws for an
 * input failure of the wrong class, and for an out-of-memory, shard or script
 * failure without a shard.
 */
export function rankFailures(sources: FailureSources): Failure[] {
  for (const failure of sources.integrityFailures) checkFailureSource(failure, ['integrity'], 'the integrity failures')
  const shardFailures = sources.outcomes.flatMap((outcome) => outcome.failures)
  for (const failure of shardFailures) checkFailureSource(failure, SHARD_OUTCOME_FAILURE_KINDS, 'a shard outcome')
  return [...otherFailuresOf(sources), ...shardFailures].sort(compareFailures)
}

// The verdict line (b.uqm SR-12.5, SR-19.6).

/** The verdict of a passing full run without `--inject`, and the word a passing selective or injected run's verdict ends with (b.uqm SR-12.5, SR-17.2). */
export const PASS_VERDICT = 'PASS'

/**
 * The `SELECTIVE (<scripts>)` list (b.uqm SR-12.5, SR-17.2): the run's
 * scripts, file names or number forms, as number forms in canonical order,
 * separated by single spaces. Throws for a name that is neither form, for two
 * names of one number, and for a list without test-1.
 */
export function selectiveScriptsText(scripts: readonly string[]): string {
  const numberForms = scripts.map((name) => {
    const form = classifyScriptName(name)
    if (form.kind === 'neither') throw new Error(`selectiveScriptsText: not a script name: ${name}`)
    return form.numberForm
  })
  const duplicate = numberForms.find((numberForm, index) => numberForms.indexOf(numberForm) !== index)
  if (duplicate !== undefined) throw new Error(`selectiveScriptsText: ${duplicate} given twice`)
  const testOne = numberFormOf(EVERY_SHARD_SCRIPT_NUMBER)
  if (!numberForms.includes(testOne)) throw new Error(`selectiveScriptsText: the scripts do not hold ${testOne}`)
  return sortCanonical(numberForms).join(' ')
}

/** The selective verdict's prefix, `SELECTIVE (<scripts>): ` (b.uqm SR-12.5, SR-17.2); throws as `selectiveScriptsText` does. */
export function selectiveVerdictPrefix(scripts: readonly string[]): string {
  return `SELECTIVE (${selectiveScriptsText(scripts)}): `
}

/**
 * Throws unless every script the invocation selects is in the run's scripts,
 * compared by number form, so the `SELECTIVE` list always holds every
 * selected script (b.uqm SR-17.2). Throws for a selected name that is neither
 * form; a name in `scripts` that is neither form is `selectiveScriptsText`'s
 * to reject.
 */
function checkSelectedScriptsListed(selected: readonly string[], scripts: readonly string[]): void {
  const listed = new Set(scripts.flatMap((name) => {
    const form = classifyScriptName(name)
    return form.kind === 'neither' ? [] : [form.numberForm]
  }))
  for (const name of selected) {
    const form = classifyScriptName(name)
    if (form.kind === 'neither') throw new Error(`buildVerdictLine: the invocation selects a name that is not a script: ${name}`)
    if (!listed.has(form.numberForm)) throw new Error(`buildVerdictLine: the scripts do not hold the selected ${form.numberForm}`)
  }
}

/** What the verdict line is built from (b.uqm SR-12.5). */
export interface VerdictInputs {
  /** The invocation: its run kind, gate eligibility and normalized faults decide the shape (E1's rules). */
  readonly invocation: Invocation
  /**
   * The run's resolved, de-duplicated expected scripts, file names or number
   * forms: the selection, every prerequisite and test-1 (b.uqm SR-17.2). Used
   * only for a selective run, whose `SELECTIVE` list it is; it must hold
   * test-1 and every script the invocation selects.
   */
  readonly scripts: readonly string[]
  /** The pass condition, `runPasses`. */
  readonly passed: boolean
  /** Every failure, ranked, `rankFailures`. */
  readonly ranked: readonly Failure[]
}

/**
 * The run's verdict line, one line without a line feed (b.uqm SR-12.5,
 * SR-19.6): `PASS` when the run passes, else the top-ranked failure's line
 * verbatim (a CRLF script line keeps its `\r`); then, for a selective run, the
 * `SELECTIVE (<scripts>): ` prefix; then, for an injected run, the
 * `INJECTED (<faults>): ` wrapper outside it. A full run without `--inject`
 * keeps today's shape: `PASS`, the failing script's first `FAIL:` line, or the
 * fallback line.
 *
 * The double guard: every input that does not make sense is an internal error
 * that throws, never a verdict. A passing run with a failure line, a failing
 * run with no failure line, a top line that does not begin `FAIL:` or holds a
 * line feed, a selective run whose scripts lack test-1 or a selected script,
 * and a result of exactly `PASS` for a run that may not gate all throw.
 */
export function buildVerdictLine(inputs: VerdictInputs): string {
  const { invocation, ranked } = inputs
  let line: string
  if (inputs.passed) {
    if (ranked.length > 0) throw new Error(`buildVerdictLine: a passing run with ${ranked.length} failure line(s)`)
    line = PASS_VERDICT
  } else {
    const top = ranked[0]
    if (top === undefined) throw new Error('buildVerdictLine: a failing run with no failure line')
    if (!top.line.startsWith(FAIL_PREFIX.trimEnd())) throw new Error(`buildVerdictLine: the top failure line does not begin FAIL: ${top.line}`)
    if (top.line.includes('\n')) throw new Error('buildVerdictLine: the top failure line holds a line feed')
    line = top.line
  }
  if (isSelectiveRun(invocation)) {
    const prefix = selectiveVerdictPrefix(inputs.scripts)
    checkSelectedScriptsListed(invocation.scripts, inputs.scripts)
    line = `${prefix}${line}`
  }
  if (isInjectedRun(invocation)) line = `${injectedVerdictPrefix(invocation.faults)}${line}`
  if (line === PASS_VERDICT && !isGateEligible(invocation)) throw new Error('buildVerdictLine: exactly PASS for a run that may not gate')
  return line
}

// --- 14/T3 (E10 T3): the timing summary, the results.json value, summary.txt and their one redacted writer ---
//
// The run's record (b.uqm SR-16.1, SR-16.2): the timing summary placed in its
// fixed order from the lines other Epics produce, the `results.json` value
// with every key filled by its rule, the human-readable `summary.txt` rendered
// from that value, and the one writer of both files, which applies the
// injected redactor (E11's) to all their content and replaces each whole
// through a temporary file in the run directory and a rename (b.uqm SR-5.6,
// SR-5.7 step 5, SR-15.3). E13 calls the writer at end-of-run step 5 and again
// on a stop during the end-of-run sequence. The assembler takes the verdict
// line and the ranked failures (T2) as given.

// The timing summary (b.uqm SR-16.2, SR-8.4).

/** Each line break a given timing line may hold: CRLF, LF or CR. */
const GIVEN_LINE_BREAK_PATTERN = /\r\n|\r|\n/

/** The timing summary's line groups, each as its owning Epic gives it; T3 only places them (b.uqm SR-16.2). */
export interface TimingSummaryGroups {
  /** The shard-count line (E6, b.uqm SR-6.7); every run has one. */
  readonly shardCountLine: string
  /** The build time with its base-build part, each shard's time and the total (E4, b.uqm SR-4.4). */
  readonly runTimes: readonly string[]
  /** Each script's time (E4, b.uqm SR-4.4). */
  readonly scriptTimes: readonly string[]
  /** The duration-table block under its introducing line, its real tab characters kept (E4, b.uqm SR-4.4). */
  readonly durationTableBlock: readonly string[]
  /** The `slow:` lines (E4, b.uqm SR-4.4). */
  readonly slowLines: readonly string[]
  /** The table notes (E4). */
  readonly tableNotes: readonly string[]
  /**
   * The cap line with its suffix (E7, b.uqm SR-8.4), placed only in a full
   * run. A full run always passes one (SR-8.4's `unknown` form covers a run
   * with no readings); null only for a selective run, which gets no cap line.
   */
  readonly capLine: string | null
}

/** A given text's lines: split at every line break, an empty line dropped, so a trailing line break or an empty text adds no blank line. Tabs and every other character stay. */
function givenLines(text: string): string[] {
  return text.split(GIVEN_LINE_BREAK_PATTERN).filter((line) => line !== '')
}

/**
 * The timing summary in print order (b.uqm SR-16.2): the shard-count line;
 * the build time with its base-build part, each shard's time and the total;
 * each script's time; the duration-table block, the `slow:` lines and the
 * table notes; and, for a full run (injected or not), the cap line, which a
 * selective run never gets (b.uqm SR-8.4). An empty group, or a null cap
 * line, adds no line. Every element is one line: a given text holding line breaks is split
 * into its lines, and no element is empty or holds a line break.
 */
export function assembleTimingSummary(groups: TimingSummaryGroups, runKind: RunKind): string[] {
  const ordered: readonly (string | null)[] = [
    groups.shardCountLine,
    ...groups.runTimes,
    ...groups.scriptTimes,
    ...groups.durationTableBlock,
    ...groups.slowLines,
    ...groups.tableNotes,
    runKind === 'full' ? groups.capLine : null,
  ]
  return ordered.flatMap((text) => (text === null ? [] : givenLines(text)))
}

// The results.json value (b.uqm SR-16.1).

/** `inspectionError` for a shard whose container never started: never created, or failed to start (b.uqm SR-16.1). */
export const CONTAINER_NEVER_STARTED_TEXT = 'container never started'

/** `inspectionError` for a started shard with no inspection data and no failed read recorded, such as one whose read a stop prevented. */
export const INSPECTION_NOT_READ_TEXT = 'inspection data not read'

/**
 * The shard evidence a `shards` entry takes as it is (b.uqm SR-16.1): E4's
 * assignment figures, E7's readings, E9's start, image and inspection (its
 * `inspectionError` being the last failed read's error as recorded, any
 * form), and E11's in-shard records. A `ShardEvidence` is one.
 */
export type ResultsShardEvidence = Pick<
  ShardEvidence,
  | 'shard'
  | 'assigned'
  | 'expectedSeconds'
  | 'limitMinutes'
  | 'seconds'
  | 'anonPeak'
  | 'peakPids'
  | 'final'
  | 'failedReadings'
  | 'packageSha256'
  | 'dependencyFingerprint'
  | 'imageId'
  | 'inspection'
  | 'inspectionError'
  | 'start'
>

/** One shard: its evidence and its outcome (T1), both of the same shard. */
export interface ResultsShardInput {
  readonly evidence: ResultsShardEvidence
  readonly outcome: ShardOutcome
}

/** The modes `modes` records, as read: permission bits (a full `st_mode` is accepted; only its low twelve bits count). */
export interface RunModes {
  /** The run directory's. */
  readonly runDir: number
  /** The tarball's; null when no tarball was packed. */
  readonly tarball: number | null
  /** Each shard subdirectory's name to its mode. */
  readonly shardDirs: Readonly<Record<string, number>>
}

/** Everything `results.json` is assembled from, each value from the Epic that owns it (b.uqm SR-16.1). */
export interface ResultsInputs {
  readonly runId: string
  /** The runner's PID. */
  readonly pid: number
  /** The invocation: `args`, the run kind and the normalized faults (E1). */
  readonly invocation: Invocation
  /** The run's tarball hash (E8); null when no tarball was packed. */
  readonly packageSha256: string | null
  /** The run's images (E8). */
  readonly images: Pick<ImageState, 'pinnedId' | 'driftId' | 'retagId' | 'retagMoved'>
  /** The verdict line (T2), as given; the writer redacts it. */
  readonly verdict: string
  /** One per shard, in any order; written in shard order. */
  readonly shards: readonly ResultsShardInput[]
  /** E6's figures. */
  readonly shardCount: ResultsShardCount
  /** E7's figures; in a selective run every key but `usedBytes` is written null. */
  readonly cap: ResultsCap
  /** E7's working-set readings. */
  readonly workingSet: ResultsWorkingSet
  /** The run's failed-reading count (E7). */
  readonly failedReadings: number
  /** The modes as read (E13). */
  readonly modes: RunModes
  /** Every failure, ranked (T2's `rankFailures`); cleanup failures are never among them. */
  readonly failures: readonly Failure[]
  /** The skipped checks (E11). */
  readonly skippedChecks: readonly IntegrityCheck[]
  /** Each cleanup failure's line (E8, b.uqm SR-9.3). */
  readonly cleanupFailures: readonly string[]
  /** The build, base-build and total times (E13). */
  readonly timing: ResultsTiming
  /** The timing summary's groups, placed by `assembleTimingSummary`. */
  readonly timingGroups: TimingSummaryGroups
}

/** A mode as `modes` writes it: its permission bits as a four-digit octal string, 0700 as `"0700"` (b.uqm SR-16.1). Throws for a value that is no mode. */
export function octalModeText(mode: number): string {
  if (!Number.isSafeInteger(mode) || mode < 0) throw new Error(`octalModeText: not a mode: ${mode}`)
  return (mode & 0o7777).toString(8).padStart(4, '0')
}

/**
 * A shard's `inspectionError` (b.uqm SR-16.1, SR-10.5): null when it has
 * inspection data; `container never started` for a shard never created or
 * that failed to start; otherwise the last failed read's error on one line,
 * or `INSPECTION_NOT_READ_TEXT` when no failed read was recorded.
 */
export function inspectionErrorOf(evidence: Pick<ShardEvidence, 'start' | 'inspection' | 'inspectionError'>): string | null {
  if (evidence.inspection !== null) return null
  if (evidence.start?.kind !== 'started') return CONTAINER_NEVER_STARTED_TEXT
  const error = evidence.inspectionError === null ? '' : dependencyErrorText(evidence.inspectionError)
  return error === '' ? INSPECTION_NOT_READ_TEXT : error
}

/** Inspection data with exactly b.uqm SR-10.5's fields. */
function resultsInspectionOf(inspection: InspectionData): InspectionData {
  return {
    name: inspection.name,
    imageId: inspection.imageId,
    mounts: inspection.mounts.map((mount) => ({ source: mount.source, target: mount.target, readOnly: mount.readOnly })),
    networkMode: inspection.networkMode,
    pidMode: inspection.pidMode,
    ipcMode: inspection.ipcMode,
    privileged: inspection.privileged,
    memoryBytes: inspection.memoryBytes,
    memorySwapBytes: inspection.memorySwapBytes,
    pidsLimit: inspection.pidsLimit,
    nanoCpus: inspection.nanoCpus,
    labels: { ...inspection.labels },
    autoRemove: inspection.autoRemove,
  }
}

/** One `shards` entry, exactly its keys: the evidence's figures, the outcome's `endedNormally` and `end`, and `inspectionError` by its rule (b.uqm SR-16.1). Throws when the evidence and the outcome are of different shards. */
function resultsShardOf(input: ResultsShardInput): ResultsShard {
  const { evidence, outcome } = input
  if (outcome.shard !== evidence.shard) throw new Error(`assembleResults: shard-${evidence.shard}'s evidence paired with shard-${outcome.shard}'s outcome`)
  return {
    shard: evidence.shard,
    assigned: [...evidence.assigned],
    expectedSeconds: evidence.expectedSeconds,
    limitMinutes: evidence.limitMinutes,
    endedNormally: outcome.endedNormally,
    end: outcome.end,
    seconds: evidence.seconds,
    anonPeak: { bytes: evidence.anonPeak.bytes, pageCacheBytes: evidence.anonPeak.pageCacheBytes, mark: evidence.anonPeak.mark },
    peakPids: evidence.peakPids,
    final: { oomKilled: evidence.final.oomKilled, oomKillCount: evidence.final.oomKillCount },
    failedReadings: evidence.failedReadings,
    packageSha256: evidence.packageSha256,
    dependencyFingerprint: evidence.dependencyFingerprint,
    imageId: evidence.imageId,
    inspection: evidence.inspection === null ? null : resultsInspectionOf(evidence.inspection),
    inspectionError: inspectionErrorOf(evidence),
  }
}

/** `cap`, exactly its keys; in a selective run every key but `usedBytes` is null (b.uqm SR-16.1, SR-8.4). */
function resultsCapOf(cap: ResultsCap, runKind: RunKind): ResultsCap {
  const full = runKind === 'full'
  return {
    usedBytes: cap.usedBytes,
    peakBytes: full ? cap.peakBytes : null,
    peakShard: full ? cap.peakShard : null,
    peakPageCacheBytes: full ? cap.peakPageCacheBytes : null,
    peakFromKill: full ? cap.peakFromKill : null,
    derivedBytes: full ? cap.derivedBytes : null,
    suffix: full ? cap.suffix : null,
  }
}

/** A working-set reading, exactly its keys, or null when not read. */
function resultsWorkingSetReadingOf(reading: WorkingSetReading | null): WorkingSetReading | null {
  return reading === null ? null : { bytes: reading.bytes, anonBytes: reading.anonBytes, activeFileBytes: reading.activeFileBytes }
}

/** `modes`: each mode as a four-digit octal string (b.uqm SR-16.1). */
function resultsModesOf(modes: RunModes): ResultsModes {
  return {
    runDir: octalModeText(modes.runDir),
    tarball: modes.tarball === null ? null : octalModeText(modes.tarball),
    shardDirs: Object.fromEntries(Object.entries(modes.shardDirs).map(([name, mode]) => [name, octalModeText(mode)])),
  }
}

/**
 * The `results.json` value, every key of b.uqm SR-16.1 filled by its rule and
 * nothing more: `version` 1; the images' IDs; the verdict line as given;
 * `invocation` with `args` as given, `selective` and the normalized faults'
 * texts; `scripts`, one per assigned script per shard (test-1 once per shard),
 * in shard order then run order, from T1's outcomes; `shards` in shard order,
 * with T1's `endedNormally` and `end` and `inspectionError` by its rule; `cap`
 * nulled but `usedBytes` in a selective run; `modes` as four-digit octal
 * strings; `failures` the ranked list as given, each its `line` and `shard`;
 * and `timingSummary` from `assembleTimingSummary`. Redaction is the writer's.
 * Serialize it with E1's `serializeResults`, which throws for a value off its
 * shape (a count that is no whole number, say). Throws when a shard's evidence
 * and outcome are of different shards, or a mode is no mode.
 */
export function assembleResults(inputs: ResultsInputs): Results {
  const runKind = runKindOf(inputs.invocation)
  const shards = [...inputs.shards].sort((a, b) => a.evidence.shard - b.evidence.shard)
  return {
    version: RESULTS_FORMAT_VERSION,
    runId: inputs.runId,
    pid: inputs.pid,
    packageSha256: inputs.packageSha256,
    images: { pinned: inputs.images.pinnedId, drift: inputs.images.driftId, retag: inputs.images.retagId, retagMoved: inputs.images.retagMoved },
    verdict: inputs.verdict,
    invocation: { args: [...inputs.invocation.args], selective: runKind === 'selective', faults: inputs.invocation.faults.map(faultText) },
    scripts: shards.flatMap(({ outcome }) =>
      outcome.scripts.map((entry) => ({ script: entry.script, shard: entry.shard, result: entry.result, seconds: entry.seconds, failLine: entry.failLine })),
    ),
    shards: shards.map(resultsShardOf),
    shardCount: {
      requested: inputs.shardCount.requested,
      effective: inputs.shardCount.effective,
      admitted: inputs.shardCount.admitted,
      started: inputs.shardCount.started,
      reasons: [...inputs.shardCount.reasons],
    },
    cap: resultsCapOf(inputs.cap, runKind),
    workingSet: {
      before: resultsWorkingSetReadingOf(inputs.workingSet.before),
      peak: resultsWorkingSetReadingOf(inputs.workingSet.peak),
      after: resultsWorkingSetReadingOf(inputs.workingSet.after),
    },
    failedReadings: inputs.failedReadings,
    modes: resultsModesOf(inputs.modes),
    failures: inputs.failures.map((failure) => ({ line: failure.line, shard: failure.shard })),
    skippedChecks: [...inputs.skippedChecks],
    cleanupFailures: [...inputs.cleanupFailures],
    timing: { buildSeconds: inputs.timing.buildSeconds, baseBuildSeconds: inputs.timing.baseBuildSeconds, totalSeconds: inputs.timing.totalSeconds },
    timingSummary: assembleTimingSummary(inputs.timingGroups, runKind),
  }
}

// summary.txt (b.uqm SR-16.2, SR-12.4, SR-13.1, SR-7.3, SR-8.4, SR-9.3).

/** How the summary shows an absent value. */
const SUMMARY_NONE = 'none'

/** The line that introduces the timing-summary lines, which follow it verbatim. */
export const SUMMARY_TIMING_HEADING = 'timing summary:'

/** The indent of a listed item in the summary. */
const SUMMARY_INDENT = '  '

/** A value, or `none` for null. */
function shownOrNone(value: string | number | null): string {
  return value === null ? SUMMARY_NONE : String(value)
}

/** A list joined by a comma and a space, or `none` when empty. */
function listOrNone(items: readonly string[]): string {
  return items.length === 0 ? SUMMARY_NONE : items.join(', ')
}

/** `yes` or `no`. */
function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

/** A byte count as whole bytes, with its GiB to two decimal places. */
function bytesText(bytes: number): string {
  return `${bytes} bytes (${(bytes / GIB_BYTES).toFixed(2)} GiB)`
}

/** A byte count, or `none` for null. */
function bytesOrNone(bytes: number | null): string {
  return bytes === null ? SUMMARY_NONE : bytesText(bytes)
}

/** Seconds, or `none` for null. */
function secondsOrNone(seconds: number | null): string {
  return seconds === null ? SUMMARY_NONE : `${seconds} s`
}

/** A working-set reading with its parts, or `not read`. */
function workingSetText(reading: WorkingSetReading | null): string {
  if (reading === null) return 'not read'
  return `${bytesText(reading.bytes)}, anon ${bytesText(reading.anonBytes)}, active page cache ${bytesText(reading.activeFileBytes)}`
}

/** Shard subdirectory names in shard order: `shard-2` before `shard-10`. */
function compareShardDirNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}

/** The summary's opening lines: the run, the verdict, the invocation, the package and the images. */
function summaryHeadLines(results: Results): string[] {
  const { images, invocation } = results
  return [
    `/ci run ${results.runId}, runner pid ${results.pid}, results format version ${results.version}`,
    `verdict: ${results.verdict}`,
    `invocation: /ci${invocation.args.map((arg) => ` ${shellQuoted(arg)}`).join('')}`,
    `run kind: ${invocation.selective ? 'selective' : 'full'}`,
    `faults: ${listOrNone(invocation.faults)}`,
    `package sha256: ${shownOrNone(results.packageSha256)}`,
    `images: pinned ${shownOrNone(images.pinned)}, drift ${shownOrNone(images.drift)}, retag ${shownOrNone(images.retag)}; retag moved the -test tag: ${yesNo(images.retagMoved)}`,
  ]
}

/** Every failure with its shard (b.uqm SR-12.4), the skipped checks (b.uqm SR-13.1) and the cleanup failures (b.uqm SR-9.3). */
function summaryProblemLines(results: Results): string[] {
  return [
    `failures: ${results.failures.length}`,
    ...results.failures.map((failure) => `${SUMMARY_INDENT}${failure.shard === null ? 'run' : `${SHARD_DIR_PREFIX}${failure.shard}`}: ${failure.line}`),
    `skipped checks: ${listOrNone(results.skippedChecks)}`,
    `cleanup failures: ${results.cleanupFailures.length}`,
    ...results.cleanupFailures.map((line) => `${SUMMARY_INDENT}${line}`),
  ]
}

/** One shard's lines: every `shards` value but `inspection` and `failedReadings` (which the failed-readings line gives). */
function summaryShardLines(shard: ResultsShard): string[] {
  const item = `${SUMMARY_INDENT}${SUMMARY_INDENT}`
  const peak = shard.anonPeak
  const mark = peak.mark === null ? '' : `, ${peak.mark}`
  return [
    `${SUMMARY_INDENT}${SHARD_DIR_PREFIX}${shard.shard}:`,
    `${item}assigned: ${listOrNone(shard.assigned)}`,
    `${item}expected time: ${shard.expectedSeconds} s; wall-time limit: ${shard.limitMinutes} min`,
    `${item}ended normally: ${yesNo(shard.endedNormally)}`,
    `${item}end: ${shard.end}`,
    `${item}wall time: ${secondsOrNone(shard.seconds)}`,
    `${item}anon peak: ${bytesOrNone(peak.bytes)}, page cache ${bytesOrNone(peak.pageCacheBytes)}${mark}`,
    `${item}peak PIDs: ${shownOrNone(shard.peakPids)}`,
    `${item}final reading: OOM killed ${String(shard.final.oomKilled)}, kill count ${String(shard.final.oomKillCount)}`,
    `${item}package sha256: ${shownOrNone(shard.packageSha256)}`,
    `${item}dependency fingerprint: ${shownOrNone(shard.dependencyFingerprint)}`,
    `${item}image: ${shownOrNone(shard.imageId)}`,
    `${item}inspection error: ${shownOrNone(shard.inspectionError)}`,
  ]
}

/** One line per `scripts` entry, in its order. */
function summaryScriptLines(results: Results): string[] {
  return [
    `scripts: ${results.scripts.length}`,
    ...results.scripts.map((entry) => {
      const failLine = entry.failLine === null ? '' : `; ${entry.failLine}`
      return `${SUMMARY_INDENT}${SHARD_DIR_PREFIX}${entry.shard} ${entry.script}: ${entry.result}, ${entry.seconds === null ? 'no time' : `${entry.seconds} s`}${failLine}`
    }),
  ]
}

/** The run-wide figures: shard count, cap, working set, failed readings (run and per shard, b.uqm SR-7.3), modes and timing. */
function summaryRunFigureLines(results: Results): string[] {
  const { shardCount, cap, workingSet, modes, timing } = results
  const peakFromKill = cap.peakFromKill === null ? SUMMARY_NONE : yesNo(cap.peakFromKill)
  const suffix = cap.suffix === null || cap.suffix === '' ? SUMMARY_NONE : JSON.stringify(cap.suffix)
  const shardReadings = results.shards.map((shard) => `${SHARD_DIR_PREFIX}${shard.shard} ${shard.failedReadings}`)
  const shardModes = Object.keys(modes.shardDirs)
    .sort(compareShardDirNames)
    .map((name) => `${name} ${modes.shardDirs[name]}`)
  return [
    `shard count: requested ${shardCount.requested}, effective ${shardCount.effective}, admitted ${shardCount.admitted}, started ${shardCount.started}; reasons: ${listOrNone(shardCount.reasons)}`,
    `cap: used ${bytesText(cap.usedBytes)}; peak ${bytesOrNone(cap.peakBytes)} in ${cap.peakShard === null ? SUMMARY_NONE : `${SHARD_DIR_PREFIX}${cap.peakShard}`}; peak page cache ${bytesOrNone(cap.peakPageCacheBytes)}; peak from a kill: ${peakFromKill}; derived ${bytesOrNone(cap.derivedBytes)}; suffix: ${suffix}`,
    `working set: before ${workingSetText(workingSet.before)}; peak ${workingSetText(workingSet.peak)}; after ${workingSetText(workingSet.after)}`,
    `failed readings: run ${results.failedReadings}; ${listOrNone(shardReadings)}`,
    `modes: run directory ${modes.runDir}; tarball ${shownOrNone(modes.tarball)}; shard subdirectories ${listOrNone(shardModes)}`,
    `timing: build ${timing.buildSeconds} s (base build ${timing.baseBuildSeconds} s); total ${timing.totalSeconds} s`,
  ]
}

/**
 * `summary.txt`'s text (b.uqm SR-16.2): every value of the results file but
 * the shards' `inspection` data, one item per line, in a fixed layout, so the
 * same results always give the same text. It lists each failure with its
 * shard (`run` for none), each skipped check, each cleanup failure and the
 * failed-reading counts for the run and each shard, and ends with
 * `SUMMARY_TIMING_HEADING` followed by the timing-summary lines verbatim and
 * unindented (the shard-count line, the duration-table block with its tabs
 * and, in a full run, the cap line). Redaction is the writer's.
 */
export function renderSummary(results: Results): string {
  const lines = [
    ...summaryHeadLines(results),
    ...summaryProblemLines(results),
    `shard records: ${results.shards.length}`,
    ...results.shards.flatMap(summaryShardLines),
    ...summaryScriptLines(results),
    ...summaryRunFigureLines(results),
    SUMMARY_TIMING_HEADING,
    ...results.timingSummary,
  ]
  return `${lines.join('\n')}\n`
}

// The one writer of results.json and summary.txt (b.uqm SR-5.6, SR-5.7, SR-15.3).

/**
 * The redactor the writer applies (E11's, passed in by E13; b.uqm SR-15.3):
 * `results` returns the results with every scanned value replaced by
 * `<redacted>` and their shape kept; `text` does the same in a text.
 */
export interface ResultsRedactor {
  readonly results: (results: Results) => Results
  readonly text: (text: string) => string
}

/** Each file's write outcome. */
export interface ResultsFilesWrite {
  /** `results.json`'s. */
  readonly results: WriteResult
  /** `summary.txt`'s. */
  readonly summary: WriteResult
}

/** Builds a file's content and replaces the file whole with it; a content builder that throws writes nothing and fails with its error on one line. */
function writeBuiltFile(runDir: string, fileName: string, build: () => string): WriteResult {
  let content: string
  try {
    content = build()
  } catch (err) {
    return { ok: false, error: `building ${fileName} failed: ${dependencyErrorText(err)}` }
  }
  return writeWholeFile(runDir, fileName, content)
}

/**
 * Writes `results.json` and then `summary.txt` in the run directory, each
 * whole through E1's `writeWholeFile` (a temporary `.<name>.tmp` in the run
 * directory, then a rename), so a second call replaces both whole (b.uqm
 * SR-5.6, SR-5.7 step 5). The redactor is applied first to the results value,
 * the verdict included; `results.json` is that value through E1's
 * `serializeResults`, and `summary.txt` is `renderSummary` of it with the text
 * redactor applied on top (b.uqm SR-15.3). Nothing unredacted is ever
 * written: a redactor that throws fails both files and writes neither. A
 * results value off E1's shape fails `results.json` only, and the summary is
 * still written. Never throws; each outcome is reported.
 */
export function writeResultsFiles(runDir: string, results: Results, redactor: ResultsRedactor): ResultsFilesWrite {
  let redacted: Results
  try {
    redacted = redactor.results(results)
  } catch (err) {
    const failed: WriteResult = { ok: false, error: `redacting the results failed: ${dependencyErrorText(err)}` }
    return { results: failed, summary: failed }
  }
  return {
    results: writeBuiltFile(runDir, RESULTS_FILE_NAME, () => serializeResults(redacted)),
    summary: writeBuiltFile(runDir, SUMMARY_FILE_NAME, () => redactor.text(renderSummary(redacted))),
  }
}

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
