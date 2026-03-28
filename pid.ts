/**
 * PID file management — write, cleanup, and conflict detection.
 *
 * Extracted into a separate module so it can be imported and unit-tested
 * without triggering server.ts side effects (socket connections, HTTP server).
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'

// ---------------------------------------------------------------------------
// PID file functions
// ---------------------------------------------------------------------------

/**
 * Check whether a PID corresponds to a running process.
 * Uses process.kill(pid, 0) — throws if the process does not exist.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Check for a conflicting server instance via the PID file.
 *
 * - If no PID file exists: proceeds normally (no-op).
 * - If PID file exists and the process is running: logs a [slack]-prefixed
 *   error to stderr and exits with code 1.
 * - If PID file exists but the process is not running: removes the stale
 *   file and proceeds.
 */
export function checkPidConflict(pidFile: string): void {
  if (!existsSync(pidFile)) return

  const raw = readFileSync(pidFile, 'utf-8').trim()
  const pid = parseInt(raw, 10)

  if (!isNaN(pid) && isProcessRunning(pid)) {
    console.error(`[slack] Server is already running (PID ${pid}). Exiting.`)
    process.exit(1)
  }

  // Stale PID file — remove it and proceed
  try {
    unlinkSync(pidFile)
  } catch { /* ignore */ }
}

/**
 * Write the current process PID to the PID file.
 * Writes the numeric PID followed by a trailing newline.
 */
export function writePidFile(pidFile: string): void {
  writeFileSync(pidFile, `${process.pid}\n`, 'utf-8')
}

/**
 * Remove the PID file. Best-effort: ignores ENOENT and any other errors.
 */
export function removePidFile(pidFile: string): void {
  try {
    unlinkSync(pidFile)
  } catch { /* ignore */ }
}
