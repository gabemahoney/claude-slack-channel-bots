/**
 * Reaction intake's server-log lines (SR-10.1): the class labels and the pure
 * builders, pinned once here; the received and dropped lines' content-free,
 * redacted, single-line rendering of whatever reaches them. The intake and bot-tool
 * failure lines take an already safe description, so routing's tests own
 * their redaction.
 */
import { describe, expect, test } from 'bun:test'
import { FUNGIBLE_REFUSALS, type ReactionDropReason, type ReactionFungibleRefusal } from '../src/delivery-decision.ts'
import type { ReactionAcceptedRecord, ReactionChange } from '../src/delivery-queue.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import {
  buildBotToolReactionErrorLine,
  buildBotToolReactionStoreFailedLine,
  buildReactionAckFailedLine,
  buildReactionDroppedLine,
  buildReactionEventErrorLine,
  buildReactionPreparationFailedLine,
  buildReactionReceivedLine,
  buildReactionStoreFailedLine,
  REACTION_DROPPED,
  REACTION_LOGGED_DROP_REASONS,
  REACTION_RECEIVED,
  type ReactionDroppedInput,
  type ReactionIntakePersona,
} from '../src/reaction-intake-diagnostics.ts'
import { REDACTED_TOKEN_PLACEHOLDER, REDACTED_URL_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import {
  assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, sentinelInMessage, sentinelTicketUrl, withoutName,
} from './test-helpers/credentials.ts'

const NAMED: ReactionIntakePersona = { key: 'ops_bot', name: 'Ops Bot' }
const KEY_ONLY: ReactionIntakePersona = { key: 'ops_bot' }
const CHAT = 'C0GENERAL'
const MSG_TS = '1700000100.000100'
const EVENT_TS = '1700000200.000200'
/** Plain message text: assertNoLeak cannot see it, so its absence is asserted directly. */
const BODY = 'private reaction intake body marker'

type Reactor = { user: string } | { bot_id: string }

/** A stored Reaction Item as routing hands it to the builder: exactly one of user or bot_id. */
function reaction(overrides: Partial<ReactionAcceptedRecord> = {}, reactor: Reactor = { user: 'U0REACTOR' }): ReactionAcceptedRecord {
  const change: ReactionChange = overrides.change ?? 'added'
  const emoji = overrides.emoji ?? 'thumbsup'
  const reactorId = 'user' in reactor ? reactor.user : reactor.bot_id
  return {
    v: 1, seq: 7, kind: 'accepted', received_at: 1_700_000_300_000,
    source: 'reaction', text: '', channel: CHAT, message_ts: MSG_TS, ts: EVENT_TS, change, emoji, ...reactor,
    origin: 'slack-event', mode: 'strict',
    reaction_key: { chat_id: CHAT, message_ts: MSG_TS, reactor: reactorId, emoji, change, event_ts: EVENT_TS },
    ...overrides,
  }
}

const quoted = (value: string) => JSON.stringify(value)
const ref = (p: ReactionIntakePersona) => (p.name === undefined ? p.key : renderPersonaRef(p.name, p.key))

describe('pins: the one place the class labels and line spelling are written out', () => {
  test('labels and the logged drop reasons', () => {
    expect(REACTION_RECEIVED).toBe('reaction-received')
    expect(REACTION_DROPPED).toBe('reaction-dropped')
    expect([...REACTION_LOGGED_DROP_REASONS]).toEqual(['no-reactor', 'notices-off', 'dm-disabled', 'unserved-conversation', 'fungible-refused'])
  })

  test('lines', () => {
    const lines = [
      buildReactionReceivedLine(NAMED, reaction()),
      buildReactionDroppedLine(NAMED, { reason: 'fungible-refused', chat_id: CHAT, message_ts: MSG_TS, refusal: 'externally-shared' }),
      buildBotToolReactionStoreFailedLine(ref(NAMED), ' (reason=internal_error): Error code=EIO message="store refused"'),
      buildBotToolReactionErrorLine(`key=${KEY_ONLY.key}`, ': TypeError message="lookup broke"'),
    ]
    expect(lines).toEqual([
      '[slack] reaction-received: persona="Ops Bot" (key=ops_bot) chat_id="C0GENERAL" message_ts="1700000100.000100" change=added emoji="thumbsup" user="U0REACTOR" seq=7',
      '[slack] reaction-dropped: persona="Ops Bot" (key=ops_bot) chat_id="C0GENERAL" message_ts="1700000100.000100" reason=fungible-refused refusal=externally-shared',
      '[slack] persona-routing: bot-tool reaction store failed for persona "Ops Bot" (key=ops_bot) (reason=internal_error): Error code=EIO message="store refused"',
      '[slack] persona-routing: error handling bot-tool reaction for persona key=ops_bot: TypeError message="lookup broke"',
    ])
    assertNoLeak(lines)
  })

  test.each([
    [buildReactionEventErrorLine, '[slack] persona-routing: error handling reaction event for persona='],
    [buildReactionAckFailedLine, '[slack] persona-routing: failed to ack reaction event for persona='],
    [buildReactionPreparationFailedLine, '[slack] persona-routing: post-accept reaction preparation failed for persona='],
    [buildReactionStoreFailedLine, '[slack] persona-routing: reaction store failed for persona='],
  ] as const)('%p names the receiving persona, with its safe failure description', (build, prefix) => {
    const described = ' (reason=internal_error): Error code=EIO message="store refused"'
    const suffix = build === buildReactionStoreFailedLine ? ' — not acked, so Slack sends it again' : ''
    const lines = [build(NAMED, described), build(KEY_ONLY, described)]
    expect(lines).toEqual([
      `${prefix}"Ops Bot" (key=ops_bot)${suffix}${described}`,
      `${prefix}ops_bot${suffix}${described}`,
    ])
    assertNoLeak(lines)
  })
})

describe('drop reasons', () => {
  // A Record over the full union: the compiler fails this file when a drop reason is added without a logged/silent choice.
  const LOGGING: Record<ReactionDropReason, 'logged' | 'silent'> = {
    'not-a-message-reaction': 'silent',
    'not-own-message': 'silent',
    'no-reactor': 'logged',
    'notices-off': 'logged',
    'own-reaction': 'silent',
    'bot-reaction': 'silent',
    'dm-disabled': 'logged',
    'unserved-conversation': 'logged',
    'fungible-refused': 'logged',
  }

  test('exactly the logged reasons are exported; not-a-message-reaction, not-own-message, own-reaction and bot-reaction log nothing', () => {
    const logged = Object.entries(LOGGING).filter(([, how]) => how === 'logged').map(([reason]) => reason)
    expect([...REACTION_LOGGED_DROP_REASONS].sort() as string[]).toEqual(logged.sort())
  })
})

describe('reaction-received', () => {
  const ROWS: Array<[string, ReactionIntakePersona, ReactionChange, Reactor, string, number]> = []
  for (const persona of [NAMED, KEY_ONLY]) {
    for (const change of ['added', 'removed'] as const) {
      for (const reactor of [{ user: 'U0REACTOR' }, { bot_id: 'B0REACTOR' }] as const) {
        const emoji = change === 'added' ? '+1::skin-tone-3' : 'eyes'
        ROWS.push([`${persona.name === undefined ? 'key-only' : 'named'} ${change} by ${'user' in reactor ? 'user' : 'bot_id'}`, persona, change, reactor, emoji, ROWS.length + 1])
      }
    }
  }

  test.each(ROWS)('%s: persona, conversation, message ts, change, emoji, reactor ID and sequence', (_label, persona, change, reactor, emoji, seq) => {
    const line = buildReactionReceivedLine(persona, reaction({ change, emoji, seq }, reactor))
    const [field, id] = 'user' in reactor ? ['user', reactor.user] : ['bot_id', reactor.bot_id]
    expect(line).toBe(`[slack] ${REACTION_RECEIVED}: persona=${ref(persona)} chat_id=${quoted(CHAT)} message_ts=${quoted(MSG_TS)} change=${change} emoji=${quoted(emoji)} ${field}=${quoted(id)} seq=${seq}`)
    expect(line).not.toContain(EVENT_TS)
    assertNoLeak(line)
  })
})

describe('reaction-dropped', () => {
  const REFUSALS: ReactionFungibleRefusal[] = ['channel-id-malformed', 'flag-missing', 'flag-not-boolean', 'externally-shared']

  test('the refusals rendered here are every fungible refusal a reaction can have', () => {
    expect(REFUSALS).toEqual(FUNGIBLE_REFUSALS.filter(refusal => refusal !== 'not-a-channel'))
  })

  const DROPS: ReactionDroppedInput[] = [
    ...REACTION_LOGGED_DROP_REASONS.filter(reason => reason !== 'fungible-refused').map(reason => ({ reason, chat_id: CHAT, message_ts: MSG_TS }) as ReactionDroppedInput),
    ...REFUSALS.map(refusal => ({ reason: 'fungible-refused', chat_id: CHAT, message_ts: MSG_TS, refusal }) as ReactionDroppedInput),
  ]
  const ROWS = [NAMED, KEY_ONLY].flatMap(persona => DROPS.map(drop =>
    [`${persona.name === undefined ? 'key-only' : 'named'} ${drop.reason}${drop.refusal ? ` ${drop.refusal}` : ''}`, persona, drop] as const))

  test.each(ROWS)('%s: the reason, and the refusal only for fungible-refused', (_label, persona, drop) => {
    const line = buildReactionDroppedLine(persona, drop)
    const end = `reason=${drop.reason}${drop.reason === 'fungible-refused' ? ` refusal=${drop.refusal}` : ''}`
    expect(line).toBe(`[slack] ${REACTION_DROPPED}: persona=${ref(persona)} chat_id=${quoted(CHAT)} message_ts=${quoted(MSG_TS)} ${end}`)
    assertNoLeak(line)
  })

  test('notices-off carries no refusal: the input type refuses one, and one planted on it is not rendered', () => {
    // @ts-expect-error a refusal belongs only to fungible-refused
    const typed: ReactionDroppedInput = { reason: 'notices-off', chat_id: CHAT, message_ts: MSG_TS, refusal: 'externally-shared' }
    const line = buildReactionDroppedLine(NAMED, typed)
    expect(line).toBe(buildReactionDroppedLine(NAMED, { reason: 'notices-off', chat_id: CHAT, message_ts: MSG_TS }))
    expect(line).toBe(`[slack] ${REACTION_DROPPED}: persona=${ref(NAMED)} chat_id=${quoted(CHAT)} message_ts=${quoted(MSG_TS)} reason=notices-off`)
  })

  test('the conversation and the reacted message appear only when known', () => {
    const lines = [
      buildReactionDroppedLine(NAMED, { reason: 'no-reactor' }),
      buildReactionDroppedLine(NAMED, { reason: 'no-reactor', chat_id: CHAT }),
      buildReactionDroppedLine(KEY_ONLY, { reason: 'fungible-refused', message_ts: MSG_TS, refusal: 'flag-missing' }),
    ]
    expect(lines).toEqual([
      `[slack] ${REACTION_DROPPED}: persona=${ref(NAMED)} reason=no-reactor`,
      `[slack] ${REACTION_DROPPED}: persona=${ref(NAMED)} chat_id=${quoted(CHAT)} reason=no-reactor`,
      `[slack] ${REACTION_DROPPED}: persona=${KEY_ONLY.key} message_ts=${quoted(MSG_TS)} reason=fungible-refused refusal=flag-missing`,
    ])
    assertNoLeak(lines)
  })
})

describe('event values stay on one line, redacted and escaped', () => {
  // Every value is built so its redacted, JSON-quoted, escaped form is known exactly.
  const HOSTILE_CHAT = `${CHAT}\r\n[slack] ${REACTION_RECEIVED}: persona=forged ${fakeToken(BOT_TOKEN_PREFIX, 'chat')}`
  const HOSTILE_MSG_TS = `${MSG_TS}\u2028${sentinelTicketUrl()}`
  const CHAT_OUT = `chat_id="${CHAT}\\r\\n[slack] ${REACTION_RECEIVED}: persona=forged ${REDACTED_TOKEN_PLACEHOLDER}"`
  const MSG_TS_OUT = `message_ts="${MSG_TS}\\u2028${REDACTED_URL_PLACEHOLDER}"`
  const UNSAFE = /[\p{Cc}\u2028\u2029]/u

  test('reaction-received: conversation, message ts, emoji and reactor (user or bot_id)', () => {
    const emoji = 'thumbsup\u007f\u0085\u001b[31m'
    const user = `U0REACTOR\n[slack] ${REACTION_DROPPED}: persona=forged https://files.slack.com/files-pri/T0/F0/x?pub_secret=${LEAK_SENTINEL}`
    const botId = `B0REACTOR\u2029${sentinelInMessage('bot')}`
    const hostile = { channel: HOSTILE_CHAT, message_ts: HOSTILE_MSG_TS, emoji }
    const lines = [buildReactionReceivedLine(NAMED, reaction(hostile, { user })), buildReactionReceivedLine(KEY_ONLY, reaction(hostile, { bot_id: botId }))]
    const middle = `${CHAT_OUT} ${MSG_TS_OUT} change=added emoji="thumbsup\\u007f\\u0085\\u001b[31m"`
    expect(lines).toEqual([
      `[slack] ${REACTION_RECEIVED}: persona=${ref(NAMED)} ${middle} user="U0REACTOR\\n[slack] ${REACTION_DROPPED}: persona=forged ${REDACTED_URL_PLACEHOLDER}" seq=7`,
      `[slack] ${REACTION_RECEIVED}: persona=${KEY_ONLY.key} ${middle} bot_id="B0REACTOR\\u2029${REDACTED_SENTINEL_TAIL}" seq=7`,
    ])
    for (const line of lines) expect(line).not.toMatch(UNSAFE)
    assertNoLeak(lines)
  })

  test('reaction-dropped: conversation and message ts', () => {
    const lines = [
      buildReactionDroppedLine(NAMED, { reason: 'unserved-conversation', chat_id: HOSTILE_CHAT, message_ts: HOSTILE_MSG_TS }),
      buildReactionDroppedLine(KEY_ONLY, { reason: 'fungible-refused', chat_id: HOSTILE_CHAT, message_ts: HOSTILE_MSG_TS, refusal: 'channel-id-malformed' }),
      buildReactionDroppedLine(KEY_ONLY, { reason: 'notices-off', chat_id: HOSTILE_CHAT, message_ts: HOSTILE_MSG_TS }),
    ]
    expect(lines).toEqual([
      `[slack] ${REACTION_DROPPED}: persona=${ref(NAMED)} ${CHAT_OUT} ${MSG_TS_OUT} reason=unserved-conversation`,
      `[slack] ${REACTION_DROPPED}: persona=${KEY_ONLY.key} ${CHAT_OUT} ${MSG_TS_OUT} reason=fungible-refused refusal=channel-id-malformed`,
      `[slack] ${REACTION_DROPPED}: persona=${KEY_ONLY.key} ${CHAT_OUT} ${MSG_TS_OUT} reason=notices-off`,
    ])
    for (const line of lines) expect(line).not.toMatch(UNSAFE)
    assertNoLeak(lines)
  })
})

describe('only the listed metadata reaches a line', () => {
  const MARKERS = ['Reactor Display Marker', 'Bot Profile Marker', 'Reactor Persona Marker', 'file-name-marker']
  const extras = {
    text: `${BODY} ${LEAK_SENTINEL}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${BODY} ${LEAK_SENTINEL}` } }],
    files: [{ name: `${MARKERS[3]} ${LEAK_SENTINEL}`, mimetype: 'text/plain' }],
    username: MARKERS[0],
    bot_profile_name: MARKERS[1],
    reactor_persona_name: MARKERS[2],
    user_profile: { display_name: MARKERS[0], real_name: LEAK_SENTINEL },
    error: new Error(sentinelInMessage('store')),
    response: { ok: false, error: 'not_in_channel', token: fakeToken(BOT_TOKEN_PREFIX, 'response'), stack: LEAK_SENTINEL },
    event: { type: 'reaction_added', item: { type: 'message', channel: CHAT, ts: MSG_TS, text: BODY }, token: fakeToken(BOT_TOKEN_PREFIX, 'event') },
  }

  function expectClean(lines: string[], clean: string[]) {
    expect(lines).toEqual(clean)
    const joined = lines.join('\n')
    for (const marker of [BODY, ...MARKERS]) expect(joined).not.toContain(marker)
    assertNoLeak(lines)
  }

  test('reaction-received ignores text, blocks, files, display names, errors and responses on the record', () => {
    const planted = (reactor: Reactor) => ({ ...reaction({}, reactor), ...extras }) as unknown as ReactionAcceptedRecord
    expectClean(
      [buildReactionReceivedLine(NAMED, planted({ user: 'U0REACTOR' })), buildReactionReceivedLine(KEY_ONLY, planted({ bot_id: 'B0REACTOR' }))],
      [buildReactionReceivedLine(NAMED, reaction()), buildReactionReceivedLine(KEY_ONLY, reaction({}, { bot_id: 'B0REACTOR' }))],
    )
  })

  test('reaction-dropped ignores the same extras on its input', () => {
    const drops: ReactionDroppedInput[] = [
      { reason: 'dm-disabled', chat_id: 'D0DIRECT1', message_ts: MSG_TS },
      { reason: 'notices-off', chat_id: CHAT, message_ts: MSG_TS },
      { reason: 'fungible-refused', chat_id: CHAT, message_ts: MSG_TS, refusal: 'flag-not-boolean' },
    ]
    expectClean(
      drops.map(drop => buildReactionDroppedLine(NAMED, { ...drop, ...extras, user: 'U0REACTOR', emoji: 'thumbsup' } as unknown as ReactionDroppedInput)),
      drops.map(drop => buildReactionDroppedLine(NAMED, drop)),
    )
  })
})

describe('the receiving persona name, as configured', () => {
  test('a token-shaped name appears unredacted and leaks nothing else', () => {
    const name = fakeToken(BOT_TOKEN_PREFIX, 'persona-name')
    const persona: ReactionIntakePersona = { key: personaKey(name), name }
    const lines = [buildReactionReceivedLine(persona, reaction()), buildReactionDroppedLine(persona, { reason: 'dm-disabled', chat_id: 'D0DIRECT1', message_ts: MSG_TS })]
    expect(lines).toEqual([
      `[slack] ${REACTION_RECEIVED}: persona=${renderPersonaRef(name, persona.key)} chat_id=${quoted(CHAT)} message_ts=${quoted(MSG_TS)} change=added emoji="thumbsup" user="U0REACTOR" seq=7`,
      `[slack] ${REACTION_DROPPED}: persona=${renderPersonaRef(name, persona.key)} chat_id="D0DIRECT1" message_ts=${quoted(MSG_TS)} reason=dm-disabled`,
    ])
    for (const line of lines) expect(line).not.toContain(REDACTED_TOKEN_PLACEHOLDER)
    assertNoLeak(withoutName(lines, name, persona.key))
  })

  test('a name with quotes, control characters and a URL keeps its JSON-quoted form on one line', () => {
    const name = 'Ops "Night"\r\nDesk\t\\\u2028 https://ops.example.test/desk'
    const persona: ReactionIntakePersona = { key: personaKey(name), name }
    const escaped = `"Ops \\"Night\\"\\r\\nDesk\\t\\\\\\u2028 https://ops.example.test/desk" (key=${persona.key})`
    const lines = [buildReactionReceivedLine(persona, reaction({}, { bot_id: 'B0REACTOR' })), buildReactionDroppedLine(persona, { reason: 'no-reactor', chat_id: CHAT, message_ts: MSG_TS })]
    for (const line of lines) {
      expect(line).toContain(` persona=${escaped} chat_id=${quoted(CHAT)} `)
      expect(line).not.toMatch(/[\p{Cc}\u2028\u2029]/u)
      expect(line).not.toContain(REDACTED_URL_PLACEHOLDER)
    }
    assertNoLeak(lines)
  })
})
