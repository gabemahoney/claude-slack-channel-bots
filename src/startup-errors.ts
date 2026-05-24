/**
 * startup-errors.ts — Record startup errors to stderr and an append-only log file.
 *
 * Public API:
 *   recordStartupError(classLabel, message, cause?, options?): void
 *
 * Writes one timestamped, single-line entry to:
 *   1. fd 2 (stderr) directly — never console.error
 *   2. <stateDir>/startup-errors.log — append-only, created on demand
 *
 * <stateDir> resolution:
 *   SLACK_STATE_DIR env var → resolve(SLACK_STATE_DIR)
 *   fallback                → ~/.claude/channels/slack/
 *
 * Never throws. Never calls process.exit. Falls back to stderr-only on disk
 * failure and emits a one-line warning.
 *
 * Tests inject `options.logDir` to redirect the log file into a temp directory.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface StartupErrorOptions {
  /** Override the directory where startup-errors.log is written. */
  logDir?: string
}

function resolveStateDir(): string {
  const fromEnv = process.env['SLACK_STATE_DIR']
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.claude', 'channels', 'slack')
}

function flatten(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\r/g, ' ')
}

function formatCause(cause: unknown): string {
  if (cause === undefined || cause === null) return ''
  if (cause instanceof Error) {
    return flatten(`${cause.name}: ${cause.message}`)
  }
  if (typeof cause === 'string') return flatten(cause)
  try {
    return flatten(JSON.stringify(cause))
  } catch {
    return flatten(String(cause))
  }
}

function writeStderr(line: string): void {
  try {
    writeSync(2, line + '\n')
  } catch {
    // truly last-resort; nothing more we can do
  }
}

/**
 * Record a startup error: writes one grep-friendly timestamped line to both
 * fd 2 (stderr) and <stateDir>/startup-errors.log.
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

  writeStderr(line)

  const logDir = options?.logDir ?? resolveStateDir()
  const logPath = join(logDir, 'startup-errors.log')

  let fd: number | undefined
  try {
    mkdirSync(logDir, { recursive: true })
    fd = openSync(logPath, 'a')
    writeSync(fd, line + '\n')
  } catch (err) {
    const warnMsg = `[${new Date().toISOString()}] [startup-errors] WARNING: could not write to ${logPath}: ${flatten(String(err))}`
    writeStderr(warnMsg)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}
