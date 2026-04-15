import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  shouldArchive,
  buildMessageId,
  openArchiveDatabase,
  archiveSlackMessage,
  createNameResolver,
  resolveSenderIdentity,
  type SlackMessageEvent,
  type NameResolver,
  type NameResolverWebClient,
} from '../src/message-archive.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMessageEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    channel: 'C123',
    user: 'U456',
    ts: '1700000000.000100',
    text: 'hello world',
    ...overrides,
  }
}

function makeResolver(overrides: Partial<NameResolver> = {}): NameResolver {
  return {
    resolveChannelName: async (id: string) => `#${id}-name`,
    resolveUserName: async (id: string) => `user-${id}`,
    ...overrides,
  }
}

function makeStubWebClient(): NameResolverWebClient & {
  userCalls: number
  channelCalls: number
} {
  let userCalls = 0
  let channelCalls = 0
  return {
    get userCalls() { return userCalls },
    get channelCalls() { return channelCalls },
    users: {
      info: async ({ user }: { user: string }) => {
        userCalls++
        return { user: { name: user, profile: { display_name: `display-${user}` } } }
      },
    },
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        channelCalls++
        return { channel: { name: `chan-${channel}` } }
      },
    },
  } as any
}

// ---------------------------------------------------------------------------
// shouldArchive
// ---------------------------------------------------------------------------

describe('shouldArchive', () => {
  test('archives a normal user message', () => {
    expect(shouldArchive(makeMessageEvent())).toBe(true)
  })

  test('archives bot messages with a user field (modern apps)', () => {
    expect(shouldArchive(makeMessageEvent({ bot_id: 'B123' }))).toBe(true)
  })

  test('archives legacy bot_message subtype (no user, has bot_id)', () => {
    const event: SlackMessageEvent = {
      channel: 'C123',
      ts: '1700000000.000100',
      text: 'hello from bot',
      subtype: 'bot_message',
      bot_id: 'B999',
      username: 'Carl',
    }
    expect(shouldArchive(event)).toBe(true)
  })

  test('rejects events with neither user nor bot_id', () => {
    const event: SlackMessageEvent = {
      channel: 'C1',
      ts: '1',
      text: 'hi',
    }
    expect(shouldArchive(event)).toBe(false)
  })

  test('skips events marked hidden', () => {
    expect(shouldArchive(makeMessageEvent({ hidden: true }))).toBe(false)
  })

  test('skips edits (message_changed subtype)', () => {
    expect(shouldArchive(makeMessageEvent({ subtype: 'message_changed' }))).toBe(false)
  })

  test('skips deletions (message_deleted subtype)', () => {
    expect(shouldArchive(makeMessageEvent({ subtype: 'message_deleted' }))).toBe(false)
  })

  test('skips channel_join system messages', () => {
    expect(shouldArchive(makeMessageEvent({ subtype: 'channel_join' }))).toBe(false)
  })

  test('skips channel_leave, channel_topic, pinned_item, etc.', () => {
    for (const subtype of ['channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'pinned_item', 'unpinned_item']) {
      expect(shouldArchive(makeMessageEvent({ subtype }))).toBe(false)
    }
  })

  test('archives file_share subtype', () => {
    expect(shouldArchive(makeMessageEvent({ subtype: 'file_share' }))).toBe(true)
  })

  test('rejects events missing required fields', () => {
    expect(shouldArchive({ user: 'U1', ts: '1', text: 'hi' })).toBe(false)  // no channel
    expect(shouldArchive({ channel: 'C1', ts: '1', text: 'hi' })).toBe(false)  // no user or bot_id
    expect(shouldArchive({ channel: 'C1', user: 'U1', text: 'hi' })).toBe(false)  // no ts
    expect(shouldArchive({ channel: 'C1', user: 'U1', ts: '1' })).toBe(false)  // no text
  })

  test('accepts empty-string text (user sent blank/whitespace)', () => {
    expect(shouldArchive(makeMessageEvent({ text: '' }))).toBe(true)
  })

  test('archives thread replies (thread_ts present but no subtype)', () => {
    expect(shouldArchive(makeMessageEvent({ thread_ts: '1699999999.000000' }))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildMessageId
// ---------------------------------------------------------------------------

describe('buildMessageId', () => {
  test('produces colon-separated id matching Python backfill format', () => {
    expect(buildMessageId('C123', '1700000000.000100')).toBe('C123:1700000000.000100')
  })
})

// ---------------------------------------------------------------------------
// openArchiveDatabase
// ---------------------------------------------------------------------------

describe('openArchiveDatabase', () => {
  test('creates DB file and tables on first open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-test-'))
    const dbPath = join(dir, 'messages.db')
    expect(existsSync(dbPath)).toBe(false)
    const db = openArchiveDatabase(dbPath)
    expect(existsSync(dbPath)).toBe(true)

    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    expect(tables.some((t) => t.name === 'messages')).toBe(true)
    db.close()
  })

  test('creates parent directories when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-test-'))
    const dbPath = join(dir, 'nested', 'subdir', 'messages.db')
    const db = openArchiveDatabase(dbPath)
    expect(existsSync(dbPath)).toBe(true)
    db.close()
  })

  test('reopening an existing DB preserves data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-test-'))
    const dbPath = join(dir, 'messages.db')

    let db = openArchiveDatabase(dbPath)
    db.run(`INSERT INTO messages (id, channel_id, channel_name, timestamp, sender_id, sender_name, message_text)
            VALUES ('C1:1.2', 'C1', '#c1', 1.2, 'U1', 'user1', 'hi')`)
    db.close()

    db = openArchiveDatabase(dbPath)
    const rows = db.query('SELECT * FROM messages').all() as Array<{ id: string }>
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('C1:1.2')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// archiveSlackMessage
// ---------------------------------------------------------------------------

describe('archiveSlackMessage', () => {
  let dbPath: string
  let db: ReturnType<typeof openArchiveDatabase>

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-test-'))
    dbPath = join(dir, 'messages.db')
    db = openArchiveDatabase(dbPath)
  })

  test('inserts a valid message and returns true', async () => {
    const result = await archiveSlackMessage(db, makeMessageEvent(), makeResolver())
    expect(result).toBe(true)

    const rows = db.query('SELECT * FROM messages').all() as Array<any>
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('C123:1700000000.000100')
    expect(rows[0].channel_id).toBe('C123')
    expect(rows[0].channel_name).toBe('#C123-name')
    expect(rows[0].sender_id).toBe('U456')
    expect(rows[0].sender_name).toBe('user-U456')
    expect(rows[0].message_text).toBe('hello world')
    expect(rows[0].timestamp).toBeCloseTo(1700000000.0001, 6)
    expect(rows[0].thread_ts).toBeNull()
  })

  test('records thread_ts when provided', async () => {
    await archiveSlackMessage(
      db,
      makeMessageEvent({ thread_ts: '1699999999.000000' }),
      makeResolver(),
    )
    const row = db.query('SELECT thread_ts FROM messages').get() as any
    expect(row.thread_ts).toBe('1699999999.000000')
  })

  test('returns false and skips insert for non-archivable events', async () => {
    const result = await archiveSlackMessage(
      db,
      makeMessageEvent({ subtype: 'message_deleted' }),
      makeResolver(),
    )
    expect(result).toBe(false)
    const count = (db.query('SELECT COUNT(*) as c FROM messages').get() as any).c
    expect(count).toBe(0)
  })

  test('INSERT OR IGNORE: duplicate id returns false without erroring', async () => {
    const ev = makeMessageEvent()
    const first = await archiveSlackMessage(db, ev, makeResolver())
    const second = await archiveSlackMessage(db, ev, makeResolver())
    expect(first).toBe(true)
    expect(second).toBe(false)
    const count = (db.query('SELECT COUNT(*) as c FROM messages').get() as any).c
    expect(count).toBe(1)
  })

  test('two messages with different ts both get archived', async () => {
    await archiveSlackMessage(db, makeMessageEvent({ ts: '1.1' }), makeResolver())
    await archiveSlackMessage(db, makeMessageEvent({ ts: '2.2' }), makeResolver())
    const count = (db.query('SELECT COUNT(*) as c FROM messages').get() as any).c
    expect(count).toBe(2)
  })

  test('archives a legacy bot_message event (no user, has bot_id + username)', async () => {
    const event: SlackMessageEvent = {
      channel: 'C123',
      ts: '1700000000.777000',
      text: 'reply from Carl',
      subtype: 'bot_message',
      bot_id: 'B_CARL',
      username: 'Carl',
    }
    const result = await archiveSlackMessage(db, event, makeResolver())
    expect(result).toBe(true)

    const row = db.query('SELECT * FROM messages').get() as any
    expect(row.sender_id).toBe('bot:B_CARL')
    expect(row.sender_name).toBe('Carl')
    expect(row.message_text).toBe('reply from Carl')
  })

  test('archives a modern bot post (user set, bot_id set)', async () => {
    const event: SlackMessageEvent = {
      channel: 'C123',
      user: 'U_APP',
      ts: '1700000000.888000',
      text: 'modern bot says hi',
      bot_id: 'B_APP',
    }
    const result = await archiveSlackMessage(db, event, makeResolver())
    expect(result).toBe(true)
    const row = db.query('SELECT * FROM messages').get() as any
    expect(row.sender_id).toBe('U_APP')  // prefer user when present
  })
})

// ---------------------------------------------------------------------------
// resolveSenderIdentity
// ---------------------------------------------------------------------------

describe('resolveSenderIdentity', () => {
  test('uses user + resolver for user messages', async () => {
    const identity = await resolveSenderIdentity(makeMessageEvent({ user: 'U123' }), makeResolver())
    expect(identity.senderId).toBe('U123')
    expect(identity.senderName).toBe('user-U123')
  })

  test('uses bot:<bot_id> + username for bot_message events', async () => {
    const event: SlackMessageEvent = {
      channel: 'C1',
      ts: '1',
      text: 'hi',
      subtype: 'bot_message',
      bot_id: 'B_CARL',
      username: 'Carl',
    }
    const identity = await resolveSenderIdentity(event, makeResolver())
    expect(identity.senderId).toBe('bot:B_CARL')
    expect(identity.senderName).toBe('Carl')
  })

  test('falls back to bot_id when username missing', async () => {
    const event: SlackMessageEvent = {
      channel: 'C1',
      ts: '1',
      text: 'hi',
      subtype: 'bot_message',
      bot_id: 'B_X',
    }
    const identity = await resolveSenderIdentity(event, makeResolver())
    expect(identity.senderId).toBe('bot:B_X')
    expect(identity.senderName).toBe('B_X')
  })

  test('uses "unknown" placeholder when both user and bot_id missing (degenerate)', async () => {
    const event: SlackMessageEvent = { channel: 'C1', ts: '1', text: 'hi' }
    const identity = await resolveSenderIdentity(event, makeResolver())
    expect(identity.senderId).toBe('bot:unknown')
  })
})

// ---------------------------------------------------------------------------
// createNameResolver (caching)
// ---------------------------------------------------------------------------

describe('createNameResolver', () => {
  test('caches user lookups — second call does not hit the API', async () => {
    const stub = makeStubWebClient()
    const resolver = createNameResolver(stub)
    await resolver.resolveUserName('U1')
    await resolver.resolveUserName('U1')
    await resolver.resolveUserName('U1')
    expect(stub.userCalls).toBe(1)
  })

  test('caches channel lookups within TTL', async () => {
    const stub = makeStubWebClient()
    const resolver = createNameResolver(stub, { channelTtlMs: 60_000 })
    await resolver.resolveChannelName('C1')
    await resolver.resolveChannelName('C1')
    expect(stub.channelCalls).toBe(1)
  })

  test('re-fetches channel name after TTL expiry', async () => {
    const stub = makeStubWebClient()
    const resolver = createNameResolver(stub, { channelTtlMs: 1 })
    await resolver.resolveChannelName('C1')
    await new Promise((r) => setTimeout(r, 5))
    await resolver.resolveChannelName('C1')
    expect(stub.channelCalls).toBe(2)
  })

  test('falls back to id when user lookup throws', async () => {
    const stub: NameResolverWebClient = {
      users: { info: async () => { throw new Error('boom') } },
      conversations: { info: async () => ({ channel: { name: 'ok' } }) },
    }
    const resolver = createNameResolver(stub)
    const name = await resolver.resolveUserName('U_MISSING')
    expect(name).toBe('U_MISSING')
  })

  test('prefers display_name over real_name over name', async () => {
    const stub: NameResolverWebClient = {
      users: {
        info: async () => ({
          user: {
            name: 'slack_handle',
            real_name: 'Real Name',
            profile: { display_name: 'Display Name' },
          },
        }),
      },
      conversations: { info: async () => ({ channel: { name: 'c' } }) },
    }
    const resolver = createNameResolver(stub)
    expect(await resolver.resolveUserName('U1')).toBe('Display Name')
  })

  test('falls back to real_name when display_name is empty string', async () => {
    const stub: NameResolverWebClient = {
      users: {
        info: async () => ({
          user: {
            name: 'slack_handle',
            profile: { display_name: '', real_name: 'Real Name' },
          },
        }),
      },
      conversations: { info: async () => ({ channel: { name: 'c' } }) },
    }
    const resolver = createNameResolver(stub)
    expect(await resolver.resolveUserName('U1')).toBe('Real Name')
  })
})
