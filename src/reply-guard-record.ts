/**
 * reply-guard-record.ts — The per-persona reply-guard record (b.av2 SR-9.4).
 *
 * Before each launch the server writes the persona's effective
 * `stop_hook_bootstrap` as the exact text `true` or `false` to
 * `<stateDir>/reply-guard/<key>`. The managed Stop hook passes the record
 * directory to `slack-reply-guard.sh`, which reads `<dir>/<CSCB_PERSONA>` and
 * reminds only on `true`. Several personas can share one Claude config dir,
 * so the record, not the hook's presence in a directory, carries one
 * persona's opt-out.
 *
 * Side-effect-free (b.av2 SR-13.1): importing it touches nothing. Every path
 * comes from the caller's `stateDir` (b.av2 SR-13.2); nothing here reads the
 * environment, the real HOME or `~/.claude/channels/slack`. A key outside
 * `PERSONA_KEY_RE` is refused before any filesystem call, so a record path
 * can never leave the record directory.
 *
 * The teardown helper a persona's teardown calls (delete the record and forget the persona's
 * launched-with directory) is `teardownPersonaReplyGuard` in
 * `src/stop-hook-bootstrap.ts`.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteFileSync } from './atomic-write.ts'
import { PERSONA_KEY_RE } from './persona-identity.ts'

/** Name of the record directory inside the server's state directory. */
export const REPLY_GUARD_RECORD_DIR_NAME = 'reply-guard'

/** The record text for an enabled persona; the guard reminds only on this. */
const RECORD_TRUE = 'true'

/** The record text for a disabled persona. */
const RECORD_FALSE = 'false'

/**
 * What a persona's record says: `true` only for the exact text `true`
 * (optionally newline-terminated), `other` for any other contents, `absent`
 * for a missing or unreadable record (or a refused key).
 */
export type ReplyGuardRecordValue = 'true' | 'other' | 'absent'

/** The record directory for the server state directory `stateDir`: `<stateDir>/reply-guard`. */
export function replyGuardRecordDir(stateDir: string): string {
  return join(stateDir, REPLY_GUARD_RECORD_DIR_NAME)
}

/** True when `key` has the persona-key form (`PERSONA_KEY_RE`), so it is safe as a file name. */
export function isReplyGuardRecordKey(key: string): boolean {
  return typeof key === 'string' && PERSONA_KEY_RE.test(key)
}

/**
 * The record path for persona `key`: `<stateDir>/reply-guard/<key>`. Throws
 * for a key outside the persona-key form, before touching the filesystem.
 */
export function replyGuardRecordPath(stateDir: string, key: string): string {
  if (!isReplyGuardRecordKey(key)) {
    throw new Error('reply-guard record refused: the key is not a persona key')
  }
  return join(replyGuardRecordDir(stateDir), key)
}

/**
 * Write persona `key`'s record: the exact text `true` or `false`, atomically
 * (`.tmp` then rename), creating the record directory when it is missing.
 * Throws on a refused key or a filesystem failure; no `.tmp` file is left.
 */
export function writeReplyGuardRecord(stateDir: string, key: string, enabled: boolean): void {
  const path = replyGuardRecordPath(stateDir, key)
  mkdirSync(replyGuardRecordDir(stateDir), { recursive: true })
  atomicWriteFileSync(path, enabled ? RECORD_TRUE : RECORD_FALSE)
}

/**
 * The raw text of persona `key`'s record, or undefined when it is missing,
 * unreadable or the key is refused. Never throws.
 */
export function readReplyGuardRecordText(stateDir: string, key: string): string | undefined {
  if (!isReplyGuardRecordKey(key)) return undefined
  try {
    return readFileSync(replyGuardRecordPath(stateDir, key), 'utf-8')
  } catch {
    return undefined
  }
}

/** Read persona `key`'s record (see `ReplyGuardRecordValue`). Never throws. */
export function readReplyGuardRecord(stateDir: string, key: string): ReplyGuardRecordValue {
  const text = readReplyGuardRecordText(stateDir, key)
  if (text === undefined) return 'absent'
  return text === RECORD_TRUE || text === `${RECORD_TRUE}\n` ? 'true' : 'other'
}

/**
 * Delete persona `key`'s record. A record that is already gone is success.
 * Throws on a refused key or any other filesystem failure.
 */
export function deleteReplyGuardRecord(stateDir: string, key: string): void {
  rmSync(replyGuardRecordPath(stateDir, key), { force: true })
}
