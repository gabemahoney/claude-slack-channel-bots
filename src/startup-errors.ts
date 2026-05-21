/**
 * startup-errors.ts — Record startup errors to stderr and an append-only log file.
 *
 * ## Public API
 *
 *   recordStartupError(classLabel: string, message: string, cause?: unknown): void
 *
 * Writes a single timestamped line to:
 *   1. process.stderr  (direct fd 2 write, never console.error)
 *   2. <stateDir>/startup-errors.log  (append-only, created on demand)
 *
 * <stateDir> resolution (mirrors cli.ts / postinstall.ts convention):
 *   SLACK_STATE_DIR env var → resolve(SLACK_STATE_DIR)
 *   fallback                → ~/.claude/channels/slack/
 *
 * Never throws. Never calls process.exit. If the on-disk write fails the
 * function falls back to stderr-only and emits a one-line warning to stderr.
 *
 * ## Test-injection point
 *
 * Pass an options object as the fourth argument:
 *
 *   recordStartupError('label', 'msg', undefined, { logDir: '/tmp/my-test-dir' })
 *
 * When `options.logDir` is set it is used instead of resolving SLACK_STATE_DIR.
 * The Test Writer should pass a temp directory here instead of touching the real
 * ~/.claude/ tree.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Options accepted by recordStartupError for testing / injection. */
export interface StartupErrorOptions {
  /**
   * Override the directory where startup-errors.log is written.
   * When omitted, the standard SLACK_STATE_DIR resolution is used.
   */
  logDir?: string
}

function resolveStateDir(): string {
  const fromEnv = process.env['SLACK_STATE_DIR']
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.claude', 'channels', 'slack')
}

/** Flatten a multi-line string to a single line (replace newlines with spaces). */
function flatten(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\r/g, ' ')
}

/** Serialize a `cause` value into a compact string suitable for one-line output. */
function formatCause(cause: unknown): string {
  if (cause === undefined || cause === null) return ''
  if (cause instanceof Error) {
    const base = `${cause.name}: ${cause.message}`
    return flatten(base)
  }
  if (typeof cause === 'string') return flatten(cause)
  try {
    return flatten(JSON.stringify(cause))
  } catch {
    return flatten(String(cause))
  }
}

/** Write a buffer to fd 2 (stderr) directly, ignoring any errors. */
function writeStderr(line: string): void {
  try {
    writeSync(2, line + '\n')
  } catch {
    // truly last-resort; nothing more we can do
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a startup error by writing one grep-friendly timestamped line to
 * both process.stderr (fd 2) and <stateDir>/startup-errors.log.
 *
 * @param classLabel   Short label identifying the error class (e.g. 'config', 'token').
 * @param message      Human-readable description of the error.
 * @param cause        Optional underlying error or value to include in the log line.
 * @param options      Optional injection point; set `options.logDir` in tests.
 */
export function recordStartupError(
  classLabel: string,
  message: string,
  cause?: unknown,
  options?: StartupErrorOptions,
): void {
  const timestamp = new Date().toISOString()
  const flatMessage = flatten(message)
  const causeStr = formatCause(cause)
  const line = causeStr
    ? `[${timestamp}] [${classLabel}] ${flatMessage} — ${causeStr}`
    : `[${timestamp}] [${classLabel}] ${flatMessage}`

  // 1. Always write to stderr first (fd 2 direct write, NOT console.error).
  writeStderr(line)

  // 2. Attempt to write to the on-disk log.
  const logDir = options?.logDir ?? resolveStateDir()
  const logPath = join(logDir, 'startup-errors.log')

  let fd: number | undefined
  try {
    mkdirSync(logDir, { recursive: true })
    fd = openSync(logPath, 'a')
    writeSync(fd, line + '\n')
  } catch (err) {
    // Fall back to stderr-only; emit a non-throwing warning.
    const warnMsg = `[${new Date().toISOString()}] [startup-errors] WARNING: could not write to ${logPath}: ${flatten(String(err))}`
    writeStderr(warnMsg)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}
