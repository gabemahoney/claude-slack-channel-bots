/**
 * run-lock.ts — one /ci-live run at a time per mode.
 *
 * A real-mode command (a run, `--provision-only`, `login`, `config-token`,
 * `apps`) holds `run.lock` in the config dir; a dry run holds its own lock in the temp dir
 * (it never touches the real config dir). The lock file holds the runner's
 * PID. It is created exclusively; one left by a process that is gone (or is
 * no ci-live runner any more: the PID was reused, as after a VM reboot) is
 * stale: it is removed with a WARNING naming the PID and the path (on the
 * run log, or stderr for a command that has none), then replaced.
 *
 * The same liveness test decides which leftover containers a run may remove:
 * each container carries its runner's PID in a label, and a container whose
 * runner is still alive is never removed, so a dry run can never remove a
 * real run's container (or the reverse).
 *
 * File access and the liveness test are injected, so tests drive every branch.
 */

import { readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'

import { NotRunnableError } from './secrets.ts'

export interface LockDeps {
  /** Create `path` holding `data`; `false` when it exists already. */
  createExclusive(path: string, data: string): boolean
  /** The file's text, or `null` when it does not exist. */
  read(path: string): string | null
  unlink(path: string): void
  /** Is `pid` a live /ci-live runner? */
  isLiveRunner(pid: number): boolean
  /** Is `pid` a live process at all? Only words the stale-lock warning. */
  isAlive?(pid: number): boolean
  /** This process's PID. */
  pid: number
}

/** A runner's command line: `bun ci-live/run.ts …` (any path to it). */
const RUNNER_CMDLINE_RE = /ci-live[/\\]run\.ts(\s|$)/
/** `bun run.ts …`, which is a runner when started in the ci-live dir. */
const BARE_RUNNER_CMDLINE_RE = /(^|[\s/\\])run\.ts(\s|$)/

/**
 * True when `pid` is a live process whose command line is a /ci-live runner
 * (read from /proc; a PID that is gone or reused by another program is not).
 */
export function isLiveRunnerPid(
  pid: number,
  readCmdline: (pid: number) => string | null = procCmdline,
  readCwd: (pid: number) => string | null = procCwd,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const cmdline = readCmdline(pid)
  if (cmdline === null) return false
  if (RUNNER_CMDLINE_RE.test(cmdline)) return true
  return BARE_RUNNER_CMDLINE_RE.test(cmdline) && /[/\\]ci-live$/.test(readCwd(pid) ?? '')
}

function procCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ')
  } catch {
    return null
  }
}

function procCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

export const nodeLockDeps: LockDeps = {
  createExclusive(path, data) {
    try {
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
  },
  read(path) {
    try {
      return readFileSync(path, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  unlink(path) {
    try {
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  },
  isLiveRunner: (pid) => isLiveRunnerPid(pid),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // EPERM: it exists, as another user's process.
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  pid: process.pid,
}

/** The PID a lock file holds, or `null`. */
export function lockPid(text: string | null): number | null {
  const m = /^(\d{1,10})\s*$/.exec(text ?? '')
  return m ? Number(m[1]) : null
}

/** The live runner holding the lock at `path` (not this process), or `null`. */
export function lockHolder(path: string, deps: LockDeps = nodeLockDeps): number | null {
  const pid = lockPid(deps.read(path))
  return pid !== null && pid !== deps.pid && deps.isLiveRunner(pid) ? pid : null
}

/** The warning a stale lock's removal gives: the path, and the PID it held and why that is no runner. */
export function staleLockWarning(path: string, pid: number | null, deps: Pick<LockDeps, 'isAlive' | 'pid'>): string {
  let why: string
  if (pid === null) why = 'it holds no PID'
  else if (pid === deps.pid) why = `it holds this process's own PID ${pid}`
  else {
    const alive = deps.isAlive?.(pid)
    why =
      alive === false
        ? `its PID ${pid} is not running`
        : alive === true
          ? `its PID ${pid} is running but is no /ci-live runner (the PID was reused, as after a VM reboot)`
          : `its PID ${pid} is no live /ci-live runner`
  }
  return `WARNING: removed the stale run lock ${path}: ${why}`
}

export class RunLock {
  private released = false

  private constructor(
    readonly path: string,
    private readonly deps: LockDeps,
  ) {}

  /**
   * Take the lock, replacing a stale one (with `warn` told which, and why);
   * not runnable when a live runner holds it.
   */
  static acquire(path: string, what: string, deps: LockDeps = nodeLockDeps, warn: (message: string) => void = () => undefined): RunLock {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (deps.createExclusive(path, `${deps.pid}\n`)) return new RunLock(path, deps)
      const text = deps.read(path)
      const holder = lockHolder(path, deps)
      if (holder !== null) {
        throw new NotRunnableError(`another ${what} (PID ${holder}) is in progress and holds ${path}: wait for it to finish`)
      }
      // Gone between the create and the read: nothing to remove, nothing to warn about.
      if (text !== null) warn(staleLockWarning(path, lockPid(text), deps))
      deps.unlink(path)
    }
    throw new NotRunnableError(`could not take the run lock ${path}: remove it if no /ci-live run is in progress`)
  }

  /** Remove the lock file if it still holds this process's PID. Idempotent. */
  release(): void {
    if (this.released) return
    this.released = true
    if (lockPid(this.deps.read(this.path)) === this.deps.pid) this.deps.unlink(this.path)
  }
}
