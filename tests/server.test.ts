import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  gate,
  assertSendable,
  assertOutboundAllowed,
  chunkText,
  sanitizeFilename,
  defaultAccess,
  pruneExpired,
  generateCode,
  MAX_PENDING,
  MAX_PAIRING_REPLIES,
  PAIRING_EXPIRY_MS,
  type Access,
  type GateOptions,
} from '../src/lib.ts'
import type { Client } from 'agent-director'
import {
  ErrSpawnNotFound,
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
} from '../src/agent-director-errors.ts'
import {
  _resetOutageState,
  initOutageState,
  getOutageFlags,
  setOutageFlag,
} from '../src/outage-state.ts'
import {
  setClientForTests,
  resetClientForTests,
} from '../src/agent-director-client.ts'
import { makeStubClient } from './test-helpers/agent-director-stub.ts'
import { _buildIsSessionAliveAdapter } from '../src/server.ts'
import { _runJsonlPersistenceSafeguard } from '../src/jsonl-persistence-check.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccess(overrides: Partial<Access> = {}): Access {
  return { ...defaultAccess(), ...overrides }
}

function makeOpts(overrides: Partial<GateOptions> = {}): GateOptions {
  return {
    access: makeAccess(),
    staticMode: false,
    saveAccess: () => {},
    botUserId: 'U_BOT',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// gate()
// ---------------------------------------------------------------------------

describe('gate', () => {
  test('drops own bot messages (bot_id + matching user)', async () => {
    const result = await gate(
      { bot_id: 'B123', user: 'U_BOT', channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('delivers messages from other bots (bot_id + different user)', async () => {
    const result = await gate(
      { bot_id: 'B_OTHER', user: 'U_OTHER_BOT', channel_type: 'im', channel: 'D1', text: 'hello' },
      makeOpts({ access: { dmPolicy: 'pairing', allowFrom: ['U_OTHER_BOT'], channels: {}, pending: {} } }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops message_changed subtype', async () => {
    const result = await gate(
      { subtype: 'message_changed', user: 'U123', channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('drops message_deleted subtype', async () => {
    const result = await gate(
      { subtype: 'message_deleted', user: 'U123', channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('drops channel_join subtype', async () => {
    const result = await gate(
      { subtype: 'channel_join', user: 'U123', channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('allows file_share subtype through', async () => {
    const access = makeAccess({ allowFrom: ['U123'] })
    const result = await gate(
      { subtype: 'file_share', user: 'U123', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops messages with no user field', async () => {
    const result = await gate(
      { channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  // -- DM: allowlist --

  test('delivers DMs from allowlisted users', async () => {
    const access = makeAccess({ allowFrom: ['U_ALLOWED'] })
    const result = await gate(
      { user: 'U_ALLOWED', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
    expect(result.access).toBeDefined()
  })

  test('drops DMs when policy is allowlist and user not in list', async () => {
    const access = makeAccess({ dmPolicy: 'allowlist', allowFrom: ['U_OTHER'] })
    const result = await gate(
      { user: 'U_STRANGER', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('drops DMs when policy is disabled', async () => {
    const access = makeAccess({ dmPolicy: 'disabled' })
    const result = await gate(
      { user: 'U_ANYONE', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  // -- DM: pairing --

  test('generates pairing code for unknown DM sender', async () => {
    const access = makeAccess({ dmPolicy: 'pairing' })
    const result = await gate(
      { user: 'U_NEW', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('pair')
    expect(result.code).toBeDefined()
    expect(result.code!.length).toBe(6)
    expect(result.isResend).toBe(false)
  })

  test('resends existing code on repeat DM from same user', async () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        ABC123: {
          senderId: 'U_REPEAT',
          chatId: 'D1',
          createdAt: Date.now(),
          expiresAt: Date.now() + PAIRING_EXPIRY_MS,
          replies: 1,
        },
      },
    })
    const result = await gate(
      { user: 'U_REPEAT', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('pair')
    expect(result.code).toBe('ABC123')
    expect(result.isResend).toBe(true)
  })

  test('drops after MAX_PAIRING_REPLIES reached', async () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        ABC123: {
          senderId: 'U_MAXED',
          chatId: 'D1',
          createdAt: Date.now(),
          expiresAt: Date.now() + PAIRING_EXPIRY_MS,
          replies: MAX_PAIRING_REPLIES,
        },
      },
    })
    const result = await gate(
      { user: 'U_MAXED', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('drops when MAX_PENDING codes reached', async () => {
    const pending: Access['pending'] = {}
    for (let i = 0; i < MAX_PENDING; i++) {
      pending[`CODE${i}`] = {
        senderId: `U_PEND${i}`,
        chatId: 'D1',
        createdAt: Date.now(),
        expiresAt: Date.now() + PAIRING_EXPIRY_MS,
        replies: 1,
      }
    }
    const access = makeAccess({ dmPolicy: 'pairing', pending })
    const result = await gate(
      { user: 'U_OVERFLOW', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('calls saveAccess when pairing in non-static mode', async () => {
    let saved = false
    const access = makeAccess({ dmPolicy: 'pairing' })
    await gate(
      { user: 'U_NEW', channel_type: 'im', channel: 'D1' },
      makeOpts({ access, saveAccess: () => { saved = true } }),
    )
    expect(saved).toBe(true)
  })

  test('does NOT call saveAccess in static mode', async () => {
    let saved = false
    const access = makeAccess({ dmPolicy: 'pairing' })
    await gate(
      { user: 'U_NEW', channel_type: 'im', channel: 'D1' },
      makeOpts({ access, staticMode: true, saveAccess: () => { saved = true } }),
    )
    expect(saved).toBe(false)
  })

  // -- Channel opt-in --

  test('drops channel messages when channel not opted-in', async () => {
    const result = await gate(
      { user: 'U123', channel: 'C_UNKNOWN', channel_type: 'channel' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('delivers channel messages when channel is opted-in', async () => {
    const access = makeAccess({
      channels: { C_OPT: { requireMention: false, allowFrom: [] } },
    })
    const result = await gate(
      { user: 'U123', channel: 'C_OPT', channel_type: 'channel' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops channel messages when requireMention and no mention', async () => {
    const access = makeAccess({
      channels: { C_MENTION: { requireMention: true, allowFrom: [] } },
    })
    const result = await gate(
      { user: 'U123', channel: 'C_MENTION', channel_type: 'channel', text: 'hello' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('delivers channel messages when requireMention and bot is mentioned', async () => {
    const access = makeAccess({
      channels: { C_MENTION: { requireMention: true, allowFrom: [] } },
    })
    const result = await gate(
      { user: 'U123', channel: 'C_MENTION', channel_type: 'channel', text: 'hey <@U_BOT> help' },
      makeOpts({ access, botUserId: 'U_BOT' }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops channel messages when user not in channel allowFrom', async () => {
    const access = makeAccess({
      channels: { C_RESTRICTED: { requireMention: false, allowFrom: ['U_VIP'] } },
    })
    const result = await gate(
      { user: 'U_NOBODY', channel: 'C_RESTRICTED', channel_type: 'channel' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('delivers channel messages when user is in channel allowFrom', async () => {
    const access = makeAccess({
      channels: { C_RESTRICTED: { requireMention: false, allowFrom: ['U_VIP'] } },
    })
    const result = await gate(
      { user: 'U_VIP', channel: 'C_RESTRICTED', channel_type: 'channel' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
  })

  // -- config.json auto-opt-in (bug b.iv5) --

  test('delivers channel messages when channel is in routeChannels but not access.json', async () => {
    const routeChannels = new Set(['C_ROUTED'])
    const result = await gate(
      { user: 'U123', channel: 'C_ROUTED', channel_type: 'channel' },
      makeOpts({ routeChannels }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops channel messages when channel is neither in routeChannels nor access.json', async () => {
    const routeChannels = new Set(['C_OTHER'])
    const result = await gate(
      { user: 'U123', channel: 'C_UNKNOWN', channel_type: 'channel' },
      makeOpts({ routeChannels }),
    )
    expect(result.action).toBe('drop')
  })

  test('access.json requireMention override applies to routed channel', async () => {
    const routeChannels = new Set(['C_ROUTED'])
    const access = makeAccess({
      channels: { C_ROUTED: { requireMention: true, allowFrom: [] } },
    })
    const result = await gate(
      { user: 'U123', channel: 'C_ROUTED', channel_type: 'channel', text: 'hello' },
      makeOpts({ access, routeChannels }),
    )
    expect(result.action).toBe('drop')
  })

  test('access.json requireMention override delivers when bot is mentioned on routed channel', async () => {
    const routeChannels = new Set(['C_ROUTED'])
    const access = makeAccess({
      channels: { C_ROUTED: { requireMention: true, allowFrom: [] } },
    })
    const result = await gate(
      { user: 'U123', channel: 'C_ROUTED', channel_type: 'channel', text: 'hey <@U_BOT> help' },
      makeOpts({ access, routeChannels, botUserId: 'U_BOT' }),
    )
    expect(result.action).toBe('deliver')
  })

  test('access.json allowFrom override applies to routed channel', async () => {
    const routeChannels = new Set(['C_ROUTED'])
    const access = makeAccess({
      channels: { C_ROUTED: { requireMention: false, allowFrom: ['U_VIP'] } },
    })
    const result = await gate(
      { user: 'U_NOBODY', channel: 'C_ROUTED', channel_type: 'channel' },
      makeOpts({ access, routeChannels }),
    )
    expect(result.action).toBe('drop')
  })

  test('routed channel with no access.json entry allows any user', async () => {
    const routeChannels = new Set(['C_ROUTED'])
    const result = await gate(
      { user: 'U_ANYONE', channel: 'C_ROUTED', channel_type: 'channel' },
      makeOpts({ routeChannels }),
    )
    expect(result.action).toBe('deliver')
  })
})

// ---------------------------------------------------------------------------
// assertSendable()
// ---------------------------------------------------------------------------

describe('assertSendable', () => {
  const stateDir = '/home/user/.claude/channels/slack'
  const inboxDir = '/home/user/.claude/channels/slack/inbox'

  test('blocks .env in state dir', () => {
    expect(() => assertSendable(`${stateDir}/.env`, stateDir, inboxDir)).toThrow('Blocked')
  })

  test('blocks access.json in state dir', () => {
    expect(() => assertSendable(`${stateDir}/access.json`, stateDir, inboxDir)).toThrow('Blocked')
  })

  test('blocks nested files in state dir', () => {
    expect(() => assertSendable(`${stateDir}/subdir/secret`, stateDir, inboxDir)).toThrow('Blocked')
  })

  test('allows files in inbox/', () => {
    expect(() => assertSendable(`${inboxDir}/photo.png`, stateDir, inboxDir)).not.toThrow()
  })

  test('allows files outside state dir entirely', () => {
    expect(() => assertSendable('/tmp/output.txt', stateDir, inboxDir)).not.toThrow()
  })

  test('allows home directory files', () => {
    expect(() => assertSendable('/home/user/project/file.ts', stateDir, inboxDir)).not.toThrow()
  })

  test('blocks traversal into state dir via ..', () => {
    // Path that traverses out of inbox/ back into the protected state dir
    expect(() => assertSendable(`${inboxDir}/../access.json`, stateDir, inboxDir)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// assertOutboundAllowed()
// ---------------------------------------------------------------------------

describe('assertOutboundAllowed', () => {
  test('allows opted-in channels', () => {
    const access = makeAccess({
      channels: { C_OPT: { requireMention: false, allowFrom: [] } },
    })
    expect(() => assertOutboundAllowed('C_OPT', access, new Set())).not.toThrow()
  })

  test('allows delivered channels', () => {
    const access = makeAccess()
    const delivered = new Set(['D_DELIVERED'])
    expect(() => assertOutboundAllowed('D_DELIVERED', access, delivered)).not.toThrow()
  })

  test('blocks unknown channels', () => {
    const access = makeAccess()
    expect(() => assertOutboundAllowed('C_RANDO', access, new Set())).toThrow('Outbound gate')
  })

  test('blocks channels not in either list', () => {
    const access = makeAccess({
      channels: { C_OTHER: { requireMention: false, allowFrom: [] } },
    })
    const delivered = new Set(['D_DIFFERENT'])
    expect(() => assertOutboundAllowed('C_ATTACKER', access, delivered)).toThrow('Outbound gate')
  })
})

// ---------------------------------------------------------------------------
// chunkText()
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  test('returns single chunk for short text', () => {
    const result = chunkText('hello', 4000, 'newline')
    expect(result).toEqual(['hello'])
  })

  test('returns single chunk at exactly the limit', () => {
    const text = 'a'.repeat(4000)
    const result = chunkText(text, 4000, 'length')
    expect(result).toEqual([text])
  })

  test('chunks by fixed length', () => {
    const text = 'a'.repeat(10)
    const result = chunkText(text, 4, 'length')
    expect(result).toEqual(['aaaa', 'aaaa', 'aa'])
  })

  test('chunks at newlines (paragraph-aware)', () => {
    const text = 'line1\nline2\nline3\nline4'
    const result = chunkText(text, 12, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should be <= 12 chars
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(12)
    }
  })

  test('newline mode keeps lines together when possible', () => {
    const text = 'short\nshort\nshort'
    const result = chunkText(text, 100, 'newline')
    expect(result).toEqual(['short\nshort\nshort'])
  })
})

// ---------------------------------------------------------------------------
// sanitizeFilename()
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  test('strips square brackets', () => {
    expect(sanitizeFilename('file[1].txt')).toBe('file_1_.txt')
  })

  test('strips newlines', () => {
    expect(sanitizeFilename('file\nname.txt')).toBe('file_name.txt')
  })

  test('strips carriage returns', () => {
    expect(sanitizeFilename('file\rname.txt')).toBe('file_name.txt')
  })

  test('strips semicolons', () => {
    expect(sanitizeFilename('file;name.txt')).toBe('file_name.txt')
  })

  test('replaces path traversal (..)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_/_/etc/passwd')
  })

  test('leaves clean names alone', () => {
    expect(sanitizeFilename('photo.png')).toBe('photo.png')
  })

  test('handles combined attack vector', () => {
    const result = sanitizeFilename('[../..\n;evil].txt')
    expect(result).not.toContain('[')
    expect(result).not.toContain('..')
    expect(result).not.toContain('\n')
    expect(result).not.toContain(';')
  })
})

// ---------------------------------------------------------------------------
// pruneExpired()
// ---------------------------------------------------------------------------

describe('pruneExpired', () => {
  test('removes expired codes', () => {
    const access = makeAccess({
      pending: {
        OLD: {
          senderId: 'U1',
          chatId: 'D1',
          createdAt: 0,
          expiresAt: 1, // long expired
          replies: 1,
        },
        FRESH: {
          senderId: 'U2',
          chatId: 'D2',
          createdAt: Date.now(),
          expiresAt: Date.now() + 999999,
          replies: 1,
        },
      },
    })
    pruneExpired(access)
    expect(access.pending['OLD']).toBeUndefined()
    expect(access.pending['FRESH']).toBeDefined()
  })

  test('handles empty pending', () => {
    const access = makeAccess()
    pruneExpired(access)
    expect(Object.keys(access.pending)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// generateCode()
// ---------------------------------------------------------------------------

describe('generateCode', () => {
  test('returns 6-character string', () => {
    const code = generateCode()
    expect(code.length).toBe(6)
  })

  test('only contains allowed characters (no 0/O/1/I)', () => {
    const forbidden = /[0O1I]/
    for (let i = 0; i < 100; i++) {
      expect(generateCode()).not.toMatch(forbidden)
    }
  })

  test('generates unique codes', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 50; i++) {
      codes.add(generateCode())
    }
    // With 30^6 = 729M possibilities, 50 codes should all be unique
    expect(codes.size).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// defaultAccess()
// ---------------------------------------------------------------------------

describe('defaultAccess', () => {
  test('returns pairing policy by default', () => {
    expect(defaultAccess().dmPolicy).toBe('pairing')
  })

  test('returns empty allowlist', () => {
    expect(defaultAccess().allowFrom).toEqual([])
  })

  test('returns empty channels', () => {
    expect(defaultAccess().channels).toEqual({})
  })

  test('returns empty pending', () => {
    expect(defaultAccess().pending).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// _buildIsSessionAliveAdapter (SRD § Liveness probe, Epic 2 Task 1)
// ---------------------------------------------------------------------------

describe('_buildIsSessionAliveAdapter', () => {
  type Emission = { channelId: string; text: string }

  /** Build per-test emission capture + stub client + outage-state harness. */
  function makeHarness(statusError?: Error, statusState?: string): {
    emissions: Emission[]
    adapter: (channelId: string) => Promise<boolean>
  } {
    const emissions: Emission[] = []
    _resetOutageState()
    initOutageState({
      postToChannel: (channelId, text) => { emissions.push({ channelId, text }) },
      getClient: () => makeStubClient() as unknown as Client,
    })
    const stubOpts = statusError
      ? { statusError }
      : { statusResult: { state: statusState ?? 'waiting' } }
    setClientForTests(makeStubClient(stubOpts) as unknown as Client)
    // Minimal routing config: channel C1 is routed
    const fakeConfig = { routes: { C1: { normalizedName: 'test-channel' } } }
    return {
      emissions,
      adapter: _buildIsSessionAliveAdapter(() => fakeConfig as any),
    }
  }

  afterEach(() => {
    resetClientForTests()
    _resetOutageState()
  })

  test('1. alive: status returns live state → clears ad-unreachable + tmux-unavailable; returns true', async () => {
    const { emissions, adapter } = makeHarness(undefined, 'waiting')
    // Pre-raise both flags so the clears are observable
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toBe(true)
    expect(getOutageFlags('C1').size).toBe(0)
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].channelId).toBe('C1')
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('tmux-unavailable')
  })

  test('2. ErrSpawnNotFound: status throws → clears ad-unreachable + tmux-unavailable; returns false', async () => {
    const { emissions, adapter } = makeHarness(
      new ErrSpawnNotFound('status', 'ErrSpawnNotFound', 'spawn not found'),
    )
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toBe(false)
    expect(getOutageFlags('C1').size).toBe(0)
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('tmux-unavailable')
  })

  test('3. ErrSystemInstallDisappeared: status throws → sets ad-unreachable with binaryPath as detail; returns false', async () => {
    const binaryPath = '/home/horde/.agent-director/bin/agent-director'
    const { emissions, adapter } = makeHarness(
      new ErrSystemInstallDisappeared('status', binaryPath),
    )

    const result = await adapter('C1')

    expect(result).toBe(false)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(true)
    expect(getOutageFlags('C1').has('tmux-unavailable')).toBe(false)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].channelId).toBe('C1')
    expect(emissions[0].text).toMatch(/agent-director unreachable/)
    expect(emissions[0].text).toContain(binaryPath)
  })

  test('4. ErrTmuxNotAvailable: status throws → sets tmux-unavailable (no detail); returns false', async () => {
    const { emissions, adapter } = makeHarness(
      new ErrTmuxNotAvailable('status', 'ErrTmuxNotAvailable', 'tmux not found'),
    )

    const result = await adapter('C1')

    expect(result).toBe(false)
    expect(getOutageFlags('C1').has('tmux-unavailable')).toBe(true)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(false)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].channelId).toBe('C1')
    expect(emissions[0].text).toMatch(/tmux unavailable/)
    // ONSET_TEMPLATES['tmux-unavailable'] ignores the detail arg — nothing extra
    expect(emissions[0].text).not.toContain('undefined')
  })
})

// ---------------------------------------------------------------------------
// _runJsonlPersistenceSafeguard — server-seam Slack/error matrix (SR-24.4)
// ---------------------------------------------------------------------------

describe('_runJsonlPersistenceSafeguard', () => {
  // Realistic multi-mount mountinfo: root on ext4, /tmp on tmpfs
  const MULTI_MOUNT_MOUNTINFO = `\
23 0 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,data=ordered
24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw,data=ordered
25 23 0:20 / /tmp rw,nosuid,nodev shared:3 - tmpfs tmpfs rw,size=4096m
`

  /** Build a stub web client that records postFn calls. */
  function makeMockWeb(): {
    web: { chat: { postMessage: (...a: unknown[]) => Promise<unknown> } }
    calls: Array<{ channel: string; text: string }>
  } {
    const calls: Array<{ channel: string; text: string }> = []
    const web = {
      chat: {
        postMessage: async (...a: unknown[]) => {
          const opts = a[0] as { channel: string; text: string }
          calls.push({ channel: opts.channel, text: opts.text })
          return {}
        },
      },
    }
    return { web, calls }
  }

  /** Build recording recordStartupError stub. */
  function makeRecordStartupError(): {
    recorded: Array<{ classLabel: string; message: string }>
    fn: (classLabel: string, message: string) => void
  } {
    const recorded: Array<{ classLabel: string; message: string }> = []
    return {
      recorded,
      fn: (classLabel: string, message: string) => { recorded.push({ classLabel, message }) },
    }
  }

  /** Build recording postFn stub. */
  function makePostFn(): {
    posts: Array<{ channelId: string; text: string }>
    fn: (_web: unknown, channelId: string, text: string) => Promise<void>
  } {
    const posts: Array<{ channelId: string; text: string }> = []
    return {
      posts,
      fn: async (_web: unknown, channelId: string, text: string) => {
        posts.push({ channelId, text })
      },
    }
  }

  test('1. tmpfs + web present → postFn called for every configured route channel + jsonl-non-persistent recorded', async () => {
    // Config with two routes, both using /tmp/claude-config (tmpfs in fixture)
    const config = makeRoutingConfig({
      routes: {
        C_CHAN1: { cwd: '/repo/a', claude_config_dir: '/tmp/claude-config' },
        C_CHAN2: { cwd: '/repo/b', claude_config_dir: '/tmp/claude-config' },
      },
      claude_config_dir: undefined,
    })
    const { web } = makeMockWeb()
    const errorTracker = makeRecordStartupError()
    const postTracker = makePostFn()

    await _runJsonlPersistenceSafeguard(
      config,
      web as unknown as import('@slack/web-api').WebClient,
      {
        readMountinfo: () => MULTI_MOUNT_MOUNTINFO,
        recordStartupError: errorTracker.fn,
        postFn: postTracker.fn as unknown as (web: import('@slack/web-api').WebClient, channelId: string, text: string) => Promise<void>,
      },
    )

    // Wait for the fire-and-forget postFn promise to resolve
    await new Promise(resolve => setTimeout(resolve, 10))

    // Error must be recorded
    expect(errorTracker.recorded).toHaveLength(1)
    expect(errorTracker.recorded[0].classLabel).toBe('jsonl-non-persistent')
    expect(errorTracker.recorded[0].message).toContain('/tmp/claude-config/projects')

    // postFn must be called for every configured route channel
    const channelIds = Object.keys(config.routes)
    expect(postTracker.posts).toHaveLength(channelIds.length)
    for (const channelId of channelIds) {
      const post = postTracker.posts.find(p => p.channelId === channelId)
      expect(post).toBeDefined()
      expect(post!.text).toContain('/tmp/claude-config/projects')
    }
  })

  test('2. tmpfs + web undefined → no postFn calls, error still recorded, no crash', async () => {
    const config = makeRoutingConfig({
      routes: {
        C_CHAN1: { cwd: '/repo/a', claude_config_dir: '/tmp/claude-config' },
      },
      claude_config_dir: undefined,
    })
    const errorTracker = makeRecordStartupError()
    const postTracker = makePostFn()

    await _runJsonlPersistenceSafeguard(
      config,
      undefined, // web absent
      {
        readMountinfo: () => MULTI_MOUNT_MOUNTINFO,
        recordStartupError: errorTracker.fn,
        postFn: postTracker.fn as unknown as (web: import('@slack/web-api').WebClient, channelId: string, text: string) => Promise<void>,
      },
    )

    await new Promise(resolve => setTimeout(resolve, 10))

    // Error recorded
    expect(errorTracker.recorded).toHaveLength(1)
    expect(errorTracker.recorded[0].classLabel).toBe('jsonl-non-persistent')
    // No Slack posts
    expect(postTracker.posts).toHaveLength(0)
  })

  test('3. persistent fstype (ext4) → no postFn, no error recorded', async () => {
    const config = makeRoutingConfig({
      routes: {
        C_CHAN1: { cwd: '/repo/a', claude_config_dir: '/home/user/.claude' },
      },
      claude_config_dir: undefined,
    })
    const { web } = makeMockWeb()
    const errorTracker = makeRecordStartupError()
    const postTracker = makePostFn()

    await _runJsonlPersistenceSafeguard(
      config,
      web as unknown as import('@slack/web-api').WebClient,
      {
        readMountinfo: () => MULTI_MOUNT_MOUNTINFO,
        recordStartupError: errorTracker.fn,
        postFn: postTracker.fn as unknown as (web: import('@slack/web-api').WebClient, channelId: string, text: string) => Promise<void>,
      },
    )

    expect(errorTracker.recorded).toHaveLength(0)
    expect(postTracker.posts).toHaveLength(0)
  })

  test('4. warning path (unreadable mountinfo) → jsonl-persistence-check-warning recorded once per root, no postFn', async () => {
    const config = makeRoutingConfig({
      routes: {
        C_CHAN1: { cwd: '/repo/a', claude_config_dir: '/home/user/.claude' },
      },
      claude_config_dir: undefined,
    })
    const { web } = makeMockWeb()
    const errorTracker = makeRecordStartupError()
    const postTracker = makePostFn()

    await _runJsonlPersistenceSafeguard(
      config,
      web as unknown as import('@slack/web-api').WebClient,
      {
        readMountinfo: () => { throw new Error('EACCES: permission denied, open \'/proc/self/mountinfo\'') },
        recordStartupError: errorTracker.fn,
        postFn: postTracker.fn as unknown as (web: import('@slack/web-api').WebClient, channelId: string, text: string) => Promise<void>,
      },
    )

    // One warning per root (one root in config)
    expect(errorTracker.recorded).toHaveLength(1)
    expect(errorTracker.recorded[0].classLabel).toBe('jsonl-persistence-check-warning')
    // No Slack post for warning path
    expect(postTracker.posts).toHaveLength(0)
  })

  test('4b. warning path: two routes with distinct roots → two warnings recorded', async () => {
    const config = makeRoutingConfig({
      routes: {
        C_CHAN1: { cwd: '/repo/a', claude_config_dir: '/home/user/.claude-a' },
        C_CHAN2: { cwd: '/repo/b', claude_config_dir: '/home/user/.claude-b' },
      },
      claude_config_dir: undefined,
    })
    const { web } = makeMockWeb()
    const errorTracker = makeRecordStartupError()
    const postTracker = makePostFn()

    await _runJsonlPersistenceSafeguard(
      config,
      web as unknown as import('@slack/web-api').WebClient,
      {
        readMountinfo: () => { throw new Error('EACCES: cannot read mountinfo') },
        recordStartupError: errorTracker.fn,
        postFn: postTracker.fn as unknown as (web: import('@slack/web-api').WebClient, channelId: string, text: string) => Promise<void>,
      },
    )

    // Two distinct roots → two warnings
    expect(errorTracker.recorded).toHaveLength(2)
    expect(errorTracker.recorded.every(r => r.classLabel === 'jsonl-persistence-check-warning')).toBe(true)
    expect(postTracker.posts).toHaveLength(0)
  })

  test('5. helper own deps throwing unexpectedly → returns without throwing, single warning logged to stderr', async () => {
    const config = makeRoutingConfig({
      routes: {
        C_CHAN1: { cwd: '/repo/a' },
      },
    })
    const { web } = makeMockWeb()
    // recordStartupError throws unexpectedly — helper must catch and not re-throw
    const bombRecordError = (_classLabel: string, _message: string) => {
      throw new Error('unexpected internal failure')
    }

    // Must not throw
    await expect(
      _runJsonlPersistenceSafeguard(
        config,
        web as unknown as import('@slack/web-api').WebClient,
        {
          readMountinfo: () => { throw new Error('simulate unreadable') },
          recordStartupError: bombRecordError,
        },
      ),
    ).resolves.toBeUndefined()
  })
})
