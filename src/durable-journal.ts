/** Shared byte-level journal operations. Construction performs no I/O. */
import * as nodeFs from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface AppendRollback { pendingRollback?: number }
export interface JournalLine {
  bytes: Buffer; start: number; line: number; text: string; whole: boolean; torn: boolean
}

/** Keep exact bytes and reject invalid UTF-8. */
export function splitJournalLines(bytes: Buffer): JournalLine[] {
  const lines: JournalLine[] = []
  let offset = 0
  while (offset < bytes.length) {
    const nl = bytes.indexOf(10, offset), end = nl < 0 ? bytes.length : nl + 1
    const chunk = bytes.subarray(offset, end), text = chunk.toString('utf8').replace(/\n$/, '')
    const whole = nl >= 0 && Buffer.from(text).equals(chunk.subarray(0, chunk.length - 1))
    lines.push({ bytes: chunk, start: offset, line: lines.length + 1, text, whole, torn: nl < 0 })
    offset = end
  }
  return lines
}

/** Call only after preserving the fragment in quarantine. Queue replay does not use this. */
export function removeTornTail(rollback: AppendRollback, line: JournalLine): void {
  if (line.torn) rollback.pendingRollback = Math.min(rollback.pendingRollback ?? line.start, line.start)
}

/** Let timers and socket I/O run between slices of CPU-bound journal work;
 * a resolved promise would not, because microtasks run before them. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export interface DurableJournalOptions {
  dir: string; parentDir: string; directoryMode: number; fileMode: number; fs?: typeof nodeFs
}

// ---------------------------------------------------------------------------
// Test-only append timing
// ---------------------------------------------------------------------------

/** One successful promise `durableAppend`, timed on the timer's clock. `records`
 * counts the newline bytes handed in (one per journal record); the fsync
 * times sum the file's and the directories' syncs it waited for. */
export interface DurableAppendTiming {
  dir: string; path: string; records: number; bytes: number
  appendMs: number; fileFsyncMs: number; dirFsyncMs: number; fsyncs: number; atMonoMs: number
}
export interface DurableAppendTimer {
  now(): number
  /** Called after the append is durable; its throw is ignored. */
  record(timing: DurableAppendTiming): void
}
let appendTimer: DurableAppendTimer | undefined
/** Test-only seam, installed only by the server's `test_measurement_timings` record:
 * every journal's later promise appends are timed. Unset (the default), an
 * append reads no clock and runs exactly as before. */
export function setDurableAppendTimer(timer: DurableAppendTimer | undefined): void { appendTimer = timer }

/** The syscalls that wait for the disk. Each sequence below yields them, so
 * one ordering runs either on the I/O pool or, for read-time quarantine
 * only, blocking. Every other step is immediate and stays synchronous. */
type DurableStep = { op: 'fsync'; fd: number; target: 'file' | 'dir' } | { op: 'rename'; from: string; to: string }
type DurableSteps = Generator<DurableStep, void, void>
interface StepTimes { now(): number; fileFsyncMs: number; dirFsyncMs: number; fsyncs: number }
export function createDurableJournal(options: DurableJournalOptions) {
  const fs = options.fs ?? nodeFs, dir = options.dir
  let durableDirectory: { dev: number; ino: number } | undefined
  const fileModes = new Map<string, { dev: number; ino: number; birthtimeMs: number }>()
  // Concurrent personas share this directory. Only the latest ensure may
  // publish its identity, so an older one cannot vouch for a recreation.
  let directoryGeneration = 0
  function runSync(steps: DurableSteps): void {
    for (let next = steps.next(); !next.done;) {
      const step = next.value
      try { if (step.op === 'fsync') fs.fsyncSync(step.fd); else fs.renameSync(step.from, step.to) } catch (error) { next = steps.throw(error); continue }
      next = steps.next()
    }
  }
  function perform(step: DurableStep): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (error: NodeJS.ErrnoException | null) => { if (error) reject(error); else resolve() }
      if (step.op === 'fsync') fs.fsync(step.fd, done)
      else fs.rename(step.from, step.to, done)
    })
  }
  async function run(steps: DurableSteps, times?: StepTimes): Promise<void> {
    for (let next = steps.next(); !next.done;) {
      const started = times?.now()
      try { await perform(next.value) } catch (error) { next = steps.throw(error); continue }
      if (times && started !== undefined && next.value.op === 'fsync') {
        const ms = times.now() - started
        times.fsyncs++
        if (next.value.target === 'dir') times.dirFsyncMs += ms; else times.fileFsyncMs += ms
      }
      next = steps.next()
    }
  }
  async function timedAppend(timer: DurableAppendTimer, path: string, bytes: Uint8Array, rollback?: AppendRollback): Promise<void> {
    const times: StepTimes = { now: () => timer.now(), fileFsyncMs: 0, dirFsyncMs: 0, fsyncs: 0 }
    const started = timer.now()
    await run(appendSteps(path, bytes, rollback), times)
    try {
      const atMonoMs = timer.now()
      let records = 0
      for (const byte of bytes) if (byte === 10) records++
      timer.record({ dir, path, records, bytes: bytes.length, appendMs: atMonoMs - started,
        fileFsyncMs: times.fileFsyncMs, dirFsyncMs: times.dirFsyncMs, fsyncs: times.fsyncs, atMonoMs })
    } catch { /* a measurement cannot change a durable append's outcome */ }
  }
  function* syncDir(path: string): DurableSteps { const fd = fs.openSync(path, 'r'); try { yield { op: 'fsync', fd, target: 'dir' } } finally { fs.closeSync(fd) } }
  function* ensureDirSteps(): DurableSteps {
    // A recreated directory may reuse the cached device/inode identity.
    if (fs.mkdirSync(dir, { recursive: true, mode: options.directoryMode }) !== undefined) { durableDirectory = undefined; fileModes.clear(); directoryGeneration++ }
    const stat = fs.statSync(dir)
    if (durableDirectory?.dev === stat.dev && durableDirectory.ino === stat.ino && (stat.mode & 0o7777) === options.directoryMode) return
    durableDirectory = undefined
    const generation = ++directoryGeneration
    fs.chmodSync(dir, options.directoryMode)
    // Persist a new/replaced journal directory before any acceptance.
    // Publish this identity only after success; a failed sync remains retryable.
    yield* syncDir(options.parentDir)
    if (generation === directoryGeneration) durableDirectory = { dev: stat.dev, ino: stat.ino }
  }
  function writeAll(fd: number, bytes: Uint8Array): void {
    let offset = 0
    while (offset < bytes.length) { const n = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error('Short queue write'); offset += n }
  }
  function ensureFileMode(path: string, fd: number, stat: nodeFs.Stats): void {
    const previous = fileModes.get(path)
    if (previous?.dev === stat.dev && previous.ino === stat.ino && previous.birthtimeMs === stat.birthtimeMs && (stat.mode & 0o7777) === options.fileMode) return
    fileModes.delete(path)
    fs.fchmodSync(fd, options.fileMode)
    fileModes.set(path, { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs })
  }
  function* appendSteps(path: string, bytes: Uint8Array, rollback?: AppendRollback): DurableSteps {
    yield* ensureDirSteps()
    const fd = fs.openSync(path, 'a+', options.fileMode)
    let original: number | undefined
    try {
      // A failed reconciliation still owes the original rollback, not the
      // current file length, which may contain an unaccepted append.
      const stat = fs.fstatSync(fd)
      original = rollback?.pendingRollback ?? stat.size
      ensureFileMode(path, fd, stat)
      if (rollback?.pendingRollback !== undefined) {
        fs.ftruncateSync(fd, rollback.pendingRollback); yield { op: 'fsync', fd, target: 'file' }
        original = rollback.pendingRollback; delete rollback.pendingRollback
      }
      if (original > 0) { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, original - 1); if (last[0] !== 10) writeAll(fd, Buffer.from('\n')) }
      writeAll(fd, bytes)
      yield { op: 'fsync', fd, target: 'file' }
      // Always sync: a previous failed first append may have left an unsynced directory entry.
      yield* syncDir(dir)
    } catch (error) {
      if (rollback && original !== undefined) {
        rollback.pendingRollback ??= original
        try { fs.ftruncateSync(fd, rollback.pendingRollback); yield { op: 'fsync', fd, target: 'file' }; delete rollback.pendingRollback } catch { /* next append must reconcile before writing */ }
      }
      throw error
    } finally { try { fs.closeSync(fd) } catch { /* fsync is the durability boundary */ } }
  }
  function* rewriteSteps(path: string, bytes: Uint8Array): DurableSteps {
    const temp = `${path}.${randomUUID()}.tmp`
    yield* ensureDirSteps()
    try {
      const fd = fs.openSync(temp, 'wx', options.fileMode)
      try { writeAll(fd, bytes); yield { op: 'fsync', fd, target: 'file' } } finally { fs.closeSync(fd) }
      yield { op: 'rename', from: temp, to: path }
      yield* syncDir(dir)
    } finally { try { fs.unlinkSync(temp) } catch { /* rename consumed temp */ } }
  }
  function* reconcileSteps(path: string, j: AppendRollback): DurableSteps {
    if (j.pendingRollback !== undefined) {
      const fd = fs.openSync(path, 'r+')
      try { fs.ftruncateSync(fd, j.pendingRollback); yield { op: 'fsync', fd, target: 'file' }; delete j.pendingRollback } finally { fs.closeSync(fd) }
    }
  }
  return {
    ensureDir: (): Promise<void> => run(ensureDirSteps()),
    /** Resolves once the bytes and the directory entry are durable. The caller's
     * serialized writer must own `path` and `rollback` until it settles. */
    durableAppend: (path: string, bytes: Uint8Array, rollback?: AppendRollback): Promise<void> => {
      const timer = appendTimer
      return timer ? timedAppend(timer, path, bytes, rollback) : run(appendSteps(path, bytes, rollback))
    },
    /** Blocking form, only for Thread Memory's read-time quarantine inside its
     * synchronous journal read (start, bring-up, read retry). */
    durableAppendSync: (path: string, bytes: Uint8Array, rollback?: AppendRollback): void => runSync(appendSteps(path, bytes, rollback)),
    reconcileRollback: (path: string, j: AppendRollback): Promise<void> => run(reconcileSteps(path, j)),
    rewrite: (path: string, bytes: Uint8Array): Promise<void> => run(rewriteSteps(path, bytes)),
  }
}
