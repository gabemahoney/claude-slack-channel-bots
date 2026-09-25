/**
 * atomic-write.ts — Atomic file writes (engineering guide, Configuration:
 * "Atomic file writes"). A reader of the final path sees the old contents or
 * the new, never a partial write.
 *
 * - `atomicWriteFileSync`: the `.tmp` + rename write, for the E10 records
 *   (the Stop-hook and reply-guard records).
 * - `durableWriteFileSync`: the atomic and durable write of the reload files
 *   beside the configuration file (b.av2 SR-8.1): a uniquely named temporary
 *   file, fsync, rename, then fsync of the directory, so the new bytes
 *   survive a crash or power loss once it returns.
 *
 * Side-effect-free: importing it touches nothing. Nothing here logs; callers
 * decide the log line.
 *
 * SPDX-License-Identifier: MIT
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Write `contents` to `path` atomically: write `<path>.tmp`, then rename it
 * over `path`. On failure the `.tmp` file is removed (best effort) and the
 * error is rethrown; `path` keeps its old contents.
 */
export function atomicWriteFileSync(path: string, contents: string): void {
  const tmp = path + '.tmp'
  try {
    writeFileSync(tmp, contents, 'utf-8')
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Durable write (b.av2 SR-8.1)
// ---------------------------------------------------------------------------

/**
 * The file-system calls `durableWriteFileSync` makes, in the shape of the
 * `node:fs` sync functions. Tests substitute members to observe the order of
 * the calls or to make one fail (a permission-based failure is not reliable
 * when tests run as root).
 */
export interface DurableWriteFs {
  /** Open `path` with `flags` (`'wx'` for the temporary file, `'r'` for the directory). */
  openSync(path: string, flags: string): number
  /** Write from `buffer[offset, offset + length)`; returns the bytes written. */
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
}

/** The real `node:fs` calls, looked up at call time. */
const NODE_DURABLE_WRITE_FS: DurableWriteFs = {
  openSync: (path, flags) => openSync(path, flags),
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (path) => unlinkSync(path),
}

/** Suffix of every temporary file `durableWriteFileSync` creates. */
export const DURABLE_WRITE_TEMP_SUFFIX = '.tmp'

/**
 * A fresh temporary path for writing `path`, in the same directory:
 * `<name>.<pid>.<random hex>.tmp`. Unique per write, and never a name
 * the reload files use (each ends in `.tmp`).
 */
function durableTempPath(path: string): string {
  const unique = `${process.pid}.${randomBytes(6).toString('hex')}`
  return join(dirname(path), `${basename(path)}.${unique}${DURABLE_WRITE_TEMP_SUFFIX}`)
}

/** Write all of `bytes` to `fd`. */
function writeAll(fs: DurableWriteFs, fd: number, bytes: Uint8Array): void {
  let offset = 0
  while (offset < bytes.length) {
    offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
  }
}

/** Close `fd`, ignoring a failure (the caller is already failing). */
function closeQuietly(fs: DurableWriteFs, fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    /* ignore */
  }
}

/**
 * fsync the directory at `dir`. A failure to open or fsync it is thrown; a
 * failure to close its descriptor afterwards is ignored (the fsync already
 * succeeded or already failed, and the descriptor is gone either way).
 */
function fsyncDirectory(fs: DurableWriteFs, dir: string): void {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    closeQuietly(fs, fd)
  }
}

/**
 * `durableWriteFileSync` renamed the new bytes over the target but could not
 * fsync (or open) the target's directory: the new bytes ARE at `path`, but
 * the rename may not survive a crash or power loss. Distinguishes this
 * post-rename failure from every earlier one, after which `path` is
 * unchanged. `code` is the directory error's errno code, when it had one;
 * `syncError` is that error.
 */
export class DurableWriteUnsyncedError extends Error {
  /** The target file, which now holds the new bytes. */
  readonly path: string
  /** The errno code of the directory error, when it carried one. */
  readonly code: string | undefined
  /** The error the directory open or fsync threw. */
  readonly syncError: unknown

  constructor(path: string, syncError: unknown) {
    const cause = syncError instanceof Error ? syncError.message : String(syncError)
    super(`durableWriteFileSync: wrote "${path}" but could not sync its directory: ${cause}`)
    this.name = 'DurableWriteUnsyncedError'
    this.path = path
    const code = typeof syncError === 'object' && syncError !== null ? (syncError as { code?: unknown }).code : undefined
    this.code = typeof code === 'string' ? code : undefined
    this.syncError = syncError
  }
}

/**
 * Write `bytes` to `path` atomically and durably (b.av2 SR-8.1):
 *
 *   1. create a temporary file beside `path`, uniquely named per write
 *      (`<name>.<pid>.<random>.tmp`), and write every byte to it;
 *   2. fsync it and close it;
 *   3. rename it over `path`;
 *   4. fsync the directory, so the rename itself is durable.
 *
 * The bytes are written exactly as given (no re-encoding), so a copy is
 * byte-identical to its source.
 *
 * Failures reach the caller as the thrown error, and nothing is logged. The
 * only failures swallowed are closing a descriptor while another failure is
 * already being thrown, and closing the directory's descriptor after its
 * fsync (which then already succeeded; see `fsyncDirectory`):
 * - a failure before the rename (creating or writing the temporary file, its
 *   fsync or close, or the rename itself) is thrown as it was raised, leaves
 *   `path` exactly as it was, or absent, and removes the temporary file (best
 *   effort);
 * - a failure to open or fsync the directory, after the rename, is thrown as
 *   a `DurableWriteUnsyncedError`: the NEW bytes are at `path` but may not
 *   survive a crash. A caller that must know the file is durable treats this
 *   as a failure; one that only needs the new bytes in place may carry on.
 *
 * @param path   The target file.
 * @param bytes  The exact bytes to write.
 * @param fs     The file-system calls; the real ones by default.
 */
export function durableWriteFileSync(path: string, bytes: Uint8Array, fs: DurableWriteFs = NODE_DURABLE_WRITE_FS): void {
  const tmp = durableTempPath(path)
  try {
    const fd = fs.openSync(tmp, 'wx')
    try {
      writeAll(fs, fd, bytes)
      fs.fsyncSync(fd)
    } catch (err) {
      closeQuietly(fs, fd)
      throw err
    }
    fs.closeSync(fd)
    fs.renameSync(tmp, path)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore: best effort, it may never have been created */
    }
    throw err
  }
  try {
    fsyncDirectory(fs, dirname(path))
  } catch (err) {
    throw new DurableWriteUnsyncedError(path, err)
  }
}
