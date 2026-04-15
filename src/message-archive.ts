/**
 * message-archive.ts — Real-time Slack message archiver.
 *
 * Writes every inbound Slack message event to a SQLite DB so a separate agent
 * (e.g., OpenClaw's Carl) can search chat history without hitting the Slack
 * API on every request. Complements the nightly backfill script in
 * ~/.openclaw/workspace-grasmere/scripts/archive-messages.py — both write
 * to the same DB with compatible schema + id format.
 *
 * Schema (kept in sync with the Python backfill script):
 *   messages(
 *     id TEXT PRIMARY KEY,        -- "<channel_id>:<ts>"
 *     channel_id TEXT NOT NULL,
 *     channel_name TEXT NOT NULL,
 *     timestamp REAL NOT NULL,    -- parseFloat(event.ts)
 *     sender_id TEXT NOT NULL,
 *     sender_name TEXT NOT NULL,
 *     message_text TEXT NOT NULL,
 *     thread_ts TEXT              -- event.thread_ts or null
 *   )
 *
 * SPDX-License-Identifier: MIT
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of a Slack message event needed for archiving. */
export interface SlackMessageEvent {
  channel?: string
  user?: string
  ts?: string
  text?: string
  thread_ts?: string
  subtype?: string
  bot_id?: string
  hidden?: boolean
}

/** Dependencies that resolve Slack IDs to human-readable names. */
export interface NameResolver {
  resolveChannelName: (channelId: string) => Promise<string>
  resolveUserName: (userId: string) => Promise<string>
}

/** Minimal Slack WebClient shape we depend on. */
export interface NameResolverWebClient {
  conversations: {
    info: (args: { channel: string }) => Promise<{ channel?: { name?: string } }>
  }
  users: {
    info: (args: { user: string }) => Promise<{
      user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }
    }>
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Decide whether an inbound Slack message event should be archived.
 * We skip:
 *   - bot messages (bot_id present) — these are our own or other bots' posts
 *   - subtype events that aren't human chat (message_changed, message_deleted, channel_join, etc.)
 *   - events missing required fields
 *
 * Thread replies ARE archived (subtype is undefined, thread_ts carries linkage).
 */
export function shouldArchive(event: SlackMessageEvent): boolean {
  if (!event.channel || !event.user || !event.ts || typeof event.text !== 'string') return false
  if (event.bot_id) return false
  if (event.hidden) return false
  // Only archive plain user messages. subtype === undefined means a normal chat message.
  // Allow "file_share" since it carries human text too.
  if (event.subtype && event.subtype !== 'file_share') return false
  return true
}

/** Build the composite primary key that the Python script also uses. */
export function buildMessageId(channelId: string, ts: string): string {
  return `${channelId}:${ts}`
}

// ---------------------------------------------------------------------------
// Name resolver with cache
// ---------------------------------------------------------------------------

/**
 * Build a name resolver around a Slack WebClient. Caches lookups in-memory
 * for the lifetime of the process. User names are cached indefinitely; channel
 * names for a shorter window since renames are rare but possible.
 */
export function createNameResolver(
  web: NameResolverWebClient,
  opts: { channelTtlMs?: number } = {},
): NameResolver {
  const userCache = new Map<string, string>()
  const channelCache = new Map<string, { name: string; expiresAt: number }>()
  const channelTtl = opts.channelTtlMs ?? 24 * 60 * 60 * 1000 // 24h

  async function resolveUserName(userId: string): Promise<string> {
    const cached = userCache.get(userId)
    if (cached !== undefined) return cached
    try {
      const resp = await web.users.info({ user: userId })
      const profile = resp.user?.profile
      const name =
        profile?.display_name ||
        profile?.real_name ||
        resp.user?.real_name ||
        resp.user?.name ||
        userId
      userCache.set(userId, name)
      return name
    } catch {
      userCache.set(userId, userId)
      return userId
    }
  }

  async function resolveChannelName(channelId: string): Promise<string> {
    const cached = channelCache.get(channelId)
    if (cached && cached.expiresAt > Date.now()) return cached.name
    try {
      const resp = await web.conversations.info({ channel: channelId })
      const name = resp.channel?.name || channelId
      channelCache.set(channelId, { name, expiresAt: Date.now() + channelTtl })
      return name
    } catch {
      channelCache.set(channelId, { name: channelId, expiresAt: Date.now() + channelTtl })
      return channelId
    }
  }

  return { resolveChannelName, resolveUserName }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  timestamp REAL NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  message_text TEXT NOT NULL,
  thread_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages (channel_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_text ON messages (message_text);
CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages (thread_ts, timestamp);
`

/**
 * Open (or create) the archive DB, ensure schema exists, and return the handle.
 * Parent directory is created if missing. Uses WAL for concurrent-reader friendliness
 * since the Python backfill script may run at the same time.
 */
export function openArchiveDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA_SQL)
  return db
}

/**
 * Insert a message into the archive. Uses INSERT OR IGNORE so concurrent
 * writes from the backfill script or edited-message races are safe.
 * Returns true if a new row was written, false if the message was already
 * present or should not be archived.
 */
export async function archiveSlackMessage(
  db: Database,
  event: SlackMessageEvent,
  resolver: NameResolver,
): Promise<boolean> {
  if (!shouldArchive(event)) return false

  const channelId = event.channel!
  const userId = event.user!
  const ts = event.ts!
  const text = event.text!

  const [channelName, senderName] = await Promise.all([
    resolver.resolveChannelName(channelId),
    resolver.resolveUserName(userId),
  ])

  const id = buildMessageId(channelId, ts)
  const timestamp = parseFloat(ts)
  const threadTs = event.thread_ts ?? null

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO messages
       (id, channel_id, channel_name, timestamp, sender_id, sender_name, message_text, thread_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const info = stmt.run(id, channelId, channelName, timestamp, userId, senderName, text, threadTs)
  return (info.changes ?? 0) > 0
}
