/**
 * sessions.ts — Persistent session registry for the Slack Channel Router.
 *
 * Provides read/write access to ~/.claude/channels/slack/sessions.json,
 * which tracks tmux session assignments across server restarts.
 *
 * Both functions are pure I/O wrappers with no module-scope side effects.
 * An optional explicit path parameter enables testing without touching the
 * real sessions file.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { expandTilde } from './config.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  tmuxSession: string
  lastLaunch: string // ISO-8601, e.g. new Date().toISOString()
  sessionId: string // Claude session UUID; 'pending' until background verification discovers it
}

export type SessionsMap = Record<string, SessionRecord>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SESSIONS_PATH = join(
  process.env['SLACK_STATE_DIR'] || join(homedir(), '.claude', 'channels', 'slack'),
  'sessions.json'
)

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Reads and parses the sessions file. Returns an empty map if the file is
 * missing, unreadable, or contains invalid JSON. Never throws.
 *
 * @param path  Path to sessions.json. Defaults to ~/.claude/channels/slack/sessions.json.
 */
export function readSessions(path?: string): SessionsMap {
  const sessionsPath = expandTilde(path ?? DEFAULT_SESSIONS_PATH)
  try {
    const raw = readFileSync(sessionsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return parsed as SessionsMap
  } catch {
    return {}
  }
}

/**
 * Atomically writes the sessions map as JSON. Writes to a `.tmp` file first,
 * then renames to the final path to prevent partial writes. Creates the parent
 * directory if it does not exist.
 *
 * @param sessions  The sessions map to persist.
 * @param path      Path to sessions.json. Defaults to ~/.claude/channels/slack/sessions.json.
 */
export function writeSessions(sessions: SessionsMap, path?: string): void {
  const sessionsPath = expandTilde(path ?? DEFAULT_SESSIONS_PATH)
  const tmpPath = sessionsPath + '.tmp'
  mkdirSync(dirname(sessionsPath), { recursive: true })
  writeFileSync(tmpPath, JSON.stringify(sessions, null, 2), 'utf-8')
  renameSync(tmpPath, sessionsPath)
}

/**
 * Rotates the current sessions.json to sessions.json.last by renaming it.
 * If the file does not exist (ENOENT), silently returns — any existing .last
 * file is preserved. Re-throws any other error.
 *
 * @param path  Path to sessions.json. Defaults to ~/.claude/channels/slack/sessions.json.
 */
export function rotateSessions(path?: string): void {
  const sessionsPath = expandTilde(path ?? DEFAULT_SESSIONS_PATH)
  try {
    renameSync(sessionsPath, sessionsPath + '.last')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw err
  }
}
