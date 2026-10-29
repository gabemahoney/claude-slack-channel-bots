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

export interface DurableJournalOptions {
  dir: string; parentDir: string; directoryMode: number; fileMode: number; fs?: typeof nodeFs
}
export function createDurableJournal(options: DurableJournalOptions) {
  const fs = options.fs ?? nodeFs, dir = options.dir
  let durableDirectory: { dev: number; ino: number } | undefined
  function syncDir(path: string): void { const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
  function ensureDir(): void {
    // A recreated directory may reuse the cached device/inode identity.
    if (fs.mkdirSync(dir, { recursive: true, mode: options.directoryMode }) !== undefined) durableDirectory = undefined
    const stat = fs.statSync(dir)
    if (durableDirectory?.dev === stat.dev && durableDirectory.ino === stat.ino && (stat.mode & 0o7777) === options.directoryMode) return
    durableDirectory = undefined
    fs.chmodSync(dir, options.directoryMode)
    // Persist a new/replaced journal directory before any acceptance.
    // Publish this identity only after success; a failed sync remains retryable.
    syncDir(options.parentDir)
    durableDirectory = { dev: stat.dev, ino: stat.ino }
  }
  function writeAll(fd: number, bytes: Uint8Array): void {
    let offset = 0
    while (offset < bytes.length) { const n = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error('Short queue write'); offset += n }
  }
  function durableAppend(path: string, bytes: Uint8Array, rollback?: AppendRollback): void {
    ensureDir()
    const fd = fs.openSync(path, 'a+', options.fileMode)
    let original: number | undefined
    try {
      // A failed reconciliation still owes the original rollback, not the
      // current file length, which may contain an unaccepted append.
      original = rollback?.pendingRollback ?? fs.fstatSync(fd).size
      fs.fchmodSync(fd, options.fileMode)
      if (rollback?.pendingRollback !== undefined) {
        fs.ftruncateSync(fd, rollback.pendingRollback); fs.fsyncSync(fd)
        original = rollback.pendingRollback; delete rollback.pendingRollback
      }
      if (original > 0) { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, original - 1); if (last[0] !== 10) writeAll(fd, Buffer.from('\n')) }
      writeAll(fd, bytes)
      fs.fsyncSync(fd)
      // Always sync: a previous failed first append may have left an unsynced directory entry.
      syncDir(dir)
    } catch (error) {
      if (rollback && original !== undefined) {
        rollback.pendingRollback ??= original
        try { fs.ftruncateSync(fd, rollback.pendingRollback); fs.fsyncSync(fd); delete rollback.pendingRollback } catch { /* next append must reconcile before writing */ }
      }
      throw error
    } finally { try { fs.closeSync(fd) } catch { /* fsync is the durability boundary */ } }
  }
  function rewrite(path: string, bytes: Uint8Array): void {
    const temp = `${path}.${randomUUID()}.tmp`
    ensureDir()
    try {
      const fd = fs.openSync(temp, 'wx', options.fileMode)
      try { writeAll(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temp, path); syncDir(dir)
    } finally { try { fs.unlinkSync(temp) } catch { /* rename consumed temp */ } }
  }
  function reconcileRollback(path: string, j: AppendRollback): void {
    if (j.pendingRollback !== undefined) {
      const fd = fs.openSync(path, 'r+')
      try { fs.ftruncateSync(fd, j.pendingRollback); fs.fsyncSync(fd); delete j.pendingRollback } finally { fs.closeSync(fd) }
    }
  }
  return { ensureDir, syncDir, writeAll, durableAppend, reconcileRollback, rewrite }
}
