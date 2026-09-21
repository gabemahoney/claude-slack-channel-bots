/**
 * archive-db.ts — Shared builder for temporary message-archive SQLite DBs
 * used by the jsonl-persistence-check and session-manager suites.
 *
 * Both suites need a real sqlite archive (built through the production
 * `openArchiveDatabase()` from src/message-archive.ts, never a hand-rolled
 * schema) holding `messages` rows at timestamps controlled relative to a
 * spawn's `started_at`, because `makeDefaultArchiveCount` counts rows strictly
 * after that boundary. This centralizes the three things that otherwise
 * duplicate across the two suites:
 *   - the verbatim `INSERT INTO messages (...)` column list,
 *   - the mkdtemp → open → insert → `PRAGMA wal_checkpoint(TRUNCATE);` → close
 *     sequence (including the non-obvious WAL checkpoint), and
 *   - the strictly-after-`started_at` boundary arithmetic (see
 *     `messagesSince`, which is the single place that rule now lives).
 *
 * Two call shapes are served without contorting either:
 *   - `buildTempArchiveDb(rows)` — explicit per-row timestamps and optional
 *     per-row channel override (the primitive; lets a caller place rows
 *     before/at/after the boundary and across channels).
 *   - `messagesSince(startedAt, channelId, count)` — a thin convenience that
 *     produces `count` rows all strictly after `startedAt` on one channel.
 *
 * This module has no top-level mock.module() calls — the pretest gate
 * scripts/check-no-toplevel-mock-module.ts must pass against it.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openArchiveDatabase } from '../../src/message-archive.ts'

/** One archive row: a timestamp (epoch seconds) and an optional channel override. */
export interface ArchiveRow {
  ts: number
  channel?: string
}

/** A built temp archive DB: its path plus a cleanup handle for the mkdtemp dir. */
export interface TempArchiveDb {
  dbPath: string
  cleanup: () => void
}

/**
 * Build a temp archive DB containing `rows`, defaulting each row's channel to
 * `defaultChannel`. Returns the DB path and a cleanup handle that removes the
 * mkdtemp directory.
 */
export function buildTempArchiveDb(rows: ArchiveRow[], defaultChannel: string): TempArchiveDb {
  const dir = mkdtempSync(join(tmpdir(), 'cscb-archive-test-'))
  const dbPath = join(dir, 'archive.db')
  const db = openArchiveDatabase(dbPath)
  const insert = db.query(
    'INSERT INTO messages (id, channel_id, channel_name, timestamp, sender_id, sender_name, message_text, thread_ts) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
  )
  let i = 0
  for (const { ts, channel } of rows) {
    const ch = channel ?? defaultChannel
    insert.run(`${ch}:${ts}:${i++}`, ch, '#chan', ts, 'U1', 'user', 'hi')
  }
  // openArchiveDatabase uses WAL; checkpoint so a later read-only open sees the
  // rows in the main DB file (read-only openers cannot replay an unflushed WAL).
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Convenience over `buildTempArchiveDb`: `count` rows for `channelId`, all
 * strictly after `startedAt`. This is the single place the strictly-after
 * boundary rule is encoded — row `i` lands at `boundary + 1 + i`, so the
 * earliest row is one second past the boundary and `count: 0` yields none.
 */
export function messagesSince(startedAt: string, channelId: string, count: number): TempArchiveDb {
  const boundary = Date.parse(startedAt) / 1000
  const rows: ArchiveRow[] = []
  for (let i = 0; i < count; i++) {
    rows.push({ ts: boundary + 1 + i })
  }
  return buildTempArchiveDb(rows, channelId)
}
