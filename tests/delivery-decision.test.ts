/**
 * delivery-decision.test.ts — The pure channel delivery decision (b.av2
 * SR-4.2 steps in order, SR-4.3 interim DM drop, SR-4.4 `via` precedence)
 * and `stripPersonaMention`.
 *
 * Imports the module directly: no server, no `mock.module`, no I/O. Events
 * come from the Slack stub's event factories; P and the applied view are
 * built by `persona` / `view` below.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import type { ChannelEntry } from '../src/config.ts'
import {
  type AppliedPersonaView,
  type DeliveryDecision,
  type DeliveryDropReason,
  type DeliveryPersona,
  type Via,
  decideDelivery,
  stripPersonaMention,
} from '../src/delivery-decision.ts'
import {
  broadcastText,
  makeAppMention,
  makeBotMessage,
  makeChannelMessage,
  makeDm,
  makeWebhookPost,
  mentionText,
  userGroupMentionText,
} from './test-helpers/slack-stub.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** P, the receiving persona, and Q, another applied persona. */
const P_USER = 'U0PERSONAP'
const P_BOT = 'B0PERSONAP'
const Q_USER = 'U0PERSONAQ'
const Q_BOT = 'B0PERSONAQ'

/** P's `delivery: all` channel and `delivery: mentions` channel. */
const ALL = 'C0ALLCHAN1'
const MENTIONS = 'C0MENTION1'
/** Only Q lists this channel. */
const Q_ONLY = 'C0QONLY001'
/** No applied persona lists this channel. */
const NOBODY = 'C0NOBODY01'

function persona(
  key: string,
  botUserId: string | undefined,
  botId: string | undefined,
  channels: readonly ChannelEntry[],
): DeliveryPersona {
  return { key, botUserId, botId, channels }
}

function view(p: DeliveryPersona): AppliedPersonaView {
  return { key: p.key, channels: p.channels }
}

const P = persona('p', P_USER, P_BOT, [
  { id: ALL, delivery: 'all' },
  { id: MENTIONS, delivery: 'mentions' },
])
const Q = persona('q', Q_USER, Q_BOT, [
  { id: Q_ONLY, delivery: 'all' },
  { id: MENTIONS, delivery: 'mentions' },
])

/** P's decision on `event`, with P and Q applied unless `applied` is given. */
function decide(
  event: unknown,
  receiver: DeliveryPersona = P,
  applied: readonly AppliedPersonaView[] = [view(P), view(Q)],
): DeliveryDecision {
  return decideDelivery(event, receiver, applied)
}

const deliver = (via: Via): DeliveryDecision => ({ action: 'deliver', via })
const drop = (reason: Exclude<DeliveryDropReason, 'channel-not-configured'>): DeliveryDecision => ({ action: 'drop', reason })

// ---------------------------------------------------------------------------
// Step 1: message shape
// ---------------------------------------------------------------------------

describe('step 1: message shape', () => {
  test.each([undefined, 'file_share', 'bot_message', 'thread_broadcast', 'me_message'])(
    'subtype %p is delivered in an all channel',
    (subtype) => {
      expect(decide(makeChannelMessage({ channel: ALL, subtype }))).toEqual(deliver('receive_all'))
    },
  )

  test.each(['message_changed', 'message_deleted', 'channel_join', 'channel_leave', 'channel_topic', 'some_future_subtype'])(
    'subtype %s is dropped as non-message',
    (subtype) => {
      expect(decide(makeChannelMessage({ channel: ALL, subtype }))).toEqual(drop('non-message'))
    },
  )

  test.each<[string, unknown]>([
    ['null', null],
    ['a string', 'hello'],
    ['a number', 42],
    ['undefined', undefined],
    ['an event with no channel', makeChannelMessage({ channel: undefined })],
    ['an event with an empty channel', makeChannelMessage({ channel: '' })],
    ['an event with a non-string subtype', makeChannelMessage({ channel: ALL, subtype: 7 })],
  ])('%s is dropped as non-message', (_label, event) => {
    expect(decide(event)).toEqual(drop('non-message'))
  })

  test.each<[string, Record<string, unknown>]>([
    ["P's own edit mentioning P", { user: P_USER, bot_id: P_BOT, subtype: 'message_changed', text: mentionText(P_USER) }],
    ['an edit with no author', { user: undefined, subtype: 'message_changed' }],
    ['a join in a channel P is not in', { channel: NOBODY, subtype: 'channel_join' }],
  ])('step 1 runs first: %s is non-message', (_label, overrides) => {
    expect(decide(makeChannelMessage({ channel: ALL, ...overrides }))).toEqual(drop('non-message'))
  })
})

// ---------------------------------------------------------------------------
// Step 2: author and self-exclusion
// ---------------------------------------------------------------------------

describe('step 2: author and self-exclusion', () => {
  test.each<[string, Record<string, unknown>]>([
    ['no user and no bot ID', { user: undefined }],
    ['an empty user and an empty bot ID', { user: '', bot_id: '' }],
    ['no author, in a DM channel', { user: undefined, channel_type: 'im' }],
    ['no author, mentioning P', { user: undefined, channel: MENTIONS, text: mentionText(P_USER) }],
  ])('%s is dropped as no-author', (_label, overrides) => {
    expect(decide(makeChannelMessage({ channel: ALL, ...overrides }))).toEqual(drop('no-author'))
  })

  test.each<[string, Record<string, unknown>]>([
    ["P's bot user as author", makeChannelMessage({ channel: ALL, user: P_USER })],
    ["P's app post (P's bot user and bot ID)", makeBotMessage({ channel: ALL, user: P_USER, bot_id: P_BOT })],
    ["no user, P's bot ID", makeWebhookPost({ channel: ALL, bot_id: P_BOT })],
    ["another user, P's bot ID", makeBotMessage({ channel: ALL, user: Q_USER, bot_id: P_BOT })],
    ['own post mentioning P in a mentions channel', makeChannelMessage({ channel: MENTIONS, user: P_USER, text: mentionText(P_USER) })],
    ['own post broadcasting in a mentions channel', makeChannelMessage({ channel: MENTIONS, user: P_USER, text: broadcastText('here') })],
    ['own post by bot ID with a labelled mention of P', makeWebhookPost({ channel: MENTIONS, bot_id: P_BOT, text: mentionText(P_USER, 'p') })],
    ['own post in a DM', makeDm({ user: P_USER })],
    ['own post in a channel P is not in', makeChannelMessage({ channel: NOBODY, user: P_USER })],
  ])('%s is dropped as own', (_label, event) => {
    expect(decide(event)).toEqual(drop('own'))
  })

  test.each<[string, Record<string, unknown>]>([
    ["another persona's post", makeBotMessage({ channel: ALL, user: Q_USER, bot_id: Q_BOT })],
    ["a person's post", makeChannelMessage({ channel: ALL })],
    ["another app's bot post", makeBotMessage({ channel: ALL })],
    ['a webhook post', makeWebhookPost({ channel: ALL })],
    ['an integration post', makeWebhookPost({ channel: ALL, bot_id: 'B0INTEG001', app_id: 'A0INTEG001', username: 'integration' })],
  ])('%s is delivered in an all channel', (_label, event) => {
    expect(decide(event)).toEqual(deliver('receive_all'))
  })

  test.each<[string, DeliveryPersona, Record<string, unknown>]>([
    ['empty bot user ID, webhook post', persona('p', '', P_BOT, P.channels), makeWebhookPost({ channel: ALL })],
    ['absent bot user ID, webhook post', persona('p', undefined, P_BOT, P.channels), makeWebhookPost({ channel: ALL })],
    ['empty bot user ID, empty event user', persona('p', '', P_BOT, P.channels), makeWebhookPost({ channel: ALL, user: '' })],
    ["empty bot ID, a person's post", persona('p', P_USER, '', P.channels), makeChannelMessage({ channel: ALL })],
    ["absent bot ID, a person's post", persona('p', P_USER, undefined, P.channels), makeChannelMessage({ channel: ALL })],
    ['empty bot ID, empty event bot ID', persona('p', P_USER, '', P.channels), makeChannelMessage({ channel: ALL, bot_id: '' })],
    ["absent bot user ID and bot ID, a person's post", persona('p', undefined, undefined, P.channels), makeChannelMessage({ channel: ALL })],
  ])('an unknown own ID never matches an author: %s', (_label, receiver, event) => {
    expect(decide(event, receiver, [view(receiver)])).toEqual(deliver('receive_all'))
  })
})

// ---------------------------------------------------------------------------
// Step 3: DMs (interim drop)
// ---------------------------------------------------------------------------

describe('step 3: DMs', () => {
  test.each<[string, Record<string, unknown>]>([
    ['a plain DM', makeDm()],
    ['a DM mentioning P', makeDm({ text: `${mentionText(P_USER)} hi` })],
    ['a DM in a channel ID P lists as all', makeDm({ channel: ALL })],
  ])('%s is dropped as dm', (_label, event) => {
    expect(decide(event)).toEqual(drop('dm'))
  })
})

// ---------------------------------------------------------------------------
// Step 4: channel membership
// ---------------------------------------------------------------------------

describe('step 4: channel membership', () => {
  test.each<[string, Record<string, unknown>, boolean]>([
    ['a channel no applied persona lists', makeChannelMessage({ channel: NOBODY }), true],
    ['a channel only another persona lists', makeChannelMessage({ channel: Q_ONLY }), false],
    [
      'P mentioned in a channel it is not in (membership is checked before mentions)',
      makeChannelMessage({ channel: Q_ONLY, text: `${mentionText(P_USER)} ${broadcastText('here')}` }),
      false,
    ],
  ])('%s is dropped as channel-not-configured, unclaimed=%p', (_label, event, unclaimed) => {
    expect(decide(event)).toEqual({ action: 'drop', reason: 'channel-not-configured', unclaimed })
  })
})

// ---------------------------------------------------------------------------
// Steps 5 and 6: delivery all / delivery mentions
// ---------------------------------------------------------------------------

describe('steps 5 and 6: delivery setting', () => {
  test('delivery all delivers a plain message', () => {
    expect(decide(makeChannelMessage({ channel: ALL, text: 'plain words' }))).toEqual(deliver('receive_all'))
  })

  test.each<[string, string, Via]>([
    ["P's user mention", mentionText(P_USER), 'mention'],
    ["P's labelled user mention", mentionText(P_USER, 'p-bot'), 'mention'],
    ['<!here>', broadcastText('here'), 'broadcast'],
    ['<!here|…>', broadcastText('here', 'here'), 'broadcast'],
    ['<!channel>', broadcastText('channel'), 'broadcast'],
    ['<!channel|…>', broadcastText('channel', 'channel'), 'broadcast'],
  ])('a mentions channel delivers on %s', (_label, token, via) => {
    const event = makeChannelMessage({ channel: MENTIONS, text: `hey ${token} look` })
    expect(decide(event)).toEqual(deliver(via))
  })

  test.each<[string, unknown]>([
    ['plain text', 'hello there'],
    ['no text', undefined],
    ['<!everyone>', `${broadcastText('everyone')} hi`],
    ['<!everyone|…>', `${broadcastText('everyone', 'everyone')} hi`],
    ['a bare user-group mention', `${userGroupMentionText()} hi`],
    ['a labelled user-group mention', `${userGroupMentionText(undefined, '@team')} hi`],
    ["another persona's mention only", `${mentionText(Q_USER)} hi`],
    ["another persona's labelled mention only", `${mentionText(Q_USER, 'q')} hi`],
    ["a person's mention only", `${mentionText('U0STUBUSR9')} hi`],
    ["a mention of an ID that starts with P's", `${mentionText(`${P_USER}X`)} hi`],
    ['the words here, channel and everyone', 'here in the channel, everyone'],
  ])('a mentions channel drops %s as not-mentioned', (_label, text) => {
    expect(decide(makeChannelMessage({ channel: MENTIONS, text }))).toEqual(drop('not-mentioned'))
  })

  test.each(['', undefined])('an unknown bot user ID %p never matches a mention', (botUserId) => {
    const receiver = persona('p', botUserId, undefined, P.channels)
    const event = makeChannelMessage({ channel: MENTIONS, text: `${mentionText('')} hi` })
    expect(decide(event, receiver, [view(receiver)])).toEqual(drop('not-mentioned'))
  })

  test("another persona's delivery all does not open P's mentions channel", () => {
    const qAll = persona('q', Q_USER, Q_BOT, [{ id: MENTIONS, delivery: 'all' }])
    expect(decide(makeChannelMessage({ channel: MENTIONS }), P, [view(P), view(qAll)])).toEqual(drop('not-mentioned'))
  })

  test.each<[string, Record<string, unknown>]>([
    ["another app's bot post", makeBotMessage({ channel: MENTIONS, text: `${mentionText(P_USER)} hi` })],
    ['a webhook post', makeWebhookPost({ channel: MENTIONS, text: `${mentionText(P_USER)} hi` })],
    ["another persona's post", makeBotMessage({ channel: MENTIONS, user: Q_USER, bot_id: Q_BOT, text: `${mentionText(P_USER)} hi` })],
  ])('a mentions channel delivers %s that mentions P, whoever wrote it', (_label, event) => {
    expect(decide(event)).toEqual(deliver('mention'))
  })

  test('an app_mention event is decided like a message', () => {
    expect(decide(makeAppMention({ channel: MENTIONS, text: `${mentionText(P_USER)} hi` }))).toEqual(deliver('mention'))
    expect(decide(makeAppMention({ channel: MENTIONS, text: `${mentionText(Q_USER)} hi` }))).toEqual(drop('not-mentioned'))
  })
})

// ---------------------------------------------------------------------------
// via precedence (SR-4.4)
// ---------------------------------------------------------------------------

describe('via precedence', () => {
  const mention = mentionText(P_USER)
  const here = broadcastText('here')

  test.each<[string, 'all' | 'mentions', 'all' | 'mentions' | undefined, string, Via]>([
    ['mentions, P mentioned', 'mentions', undefined, `${mention} hi`, 'mention'],
    ['mentions, broadcast', 'mentions', undefined, `${here} hi`, 'broadcast'],
    ['mentions, broadcast then P mentioned', 'mentions', undefined, `${here} ${mention} hi`, 'mention'],
    ['all alone, plain', 'all', undefined, 'hi', 'receive_all'],
    ['all alone, broadcast', 'all', undefined, `${here} hi`, 'broadcast'],
    ['all alone, P mentioned', 'all', undefined, `${mention} hi`, 'mention'],
    ['all shared, plain', 'all', 'all', 'hi', 'receive_all_shared'],
    ['all shared, broadcast', 'all', 'all', `${broadcastText('channel')} hi`, 'broadcast'],
    ['all shared, P mentioned', 'all', 'all', `${mention} hi`, 'mention'],
    ['all shared, broadcast then P mentioned', 'all', 'all', `${here} ${mention} hi`, 'mention'],
    ['all, other persona has it as mentions, plain', 'all', 'mentions', 'hi', 'receive_all'],
  ])('%s gives %s', (_label, pDelivery, otherDelivery, text, via) => {
    const receiver = persona('p', P_USER, P_BOT, [{ id: ALL, delivery: pDelivery }])
    const other = persona('q', Q_USER, Q_BOT, otherDelivery === undefined ? [] : [{ id: ALL, delivery: otherDelivery }])
    const event = makeChannelMessage({ channel: ALL, text })
    expect(decide(event, receiver, [view(receiver), view(other)])).toEqual(deliver(via))
  })
})

// ---------------------------------------------------------------------------
// No arbitration or throttling
// ---------------------------------------------------------------------------

describe('no arbitration', () => {
  test('two personas mentioning each other 20 times are delivered every time', () => {
    const applied = [view(P), view(Q)]
    const results: DeliveryDecision[] = []
    for (let i = 0; i < 20; i++) {
      const toP = i % 2 === 0
      const event = toP
        ? makeBotMessage({ channel: MENTIONS, user: Q_USER, bot_id: Q_BOT, text: `${mentionText(P_USER)} ping ${i}` })
        : makeBotMessage({ channel: MENTIONS, user: P_USER, bot_id: P_BOT, text: `${mentionText(Q_USER)} pong ${i}` })
      results.push(decideDelivery(event, toP ? P : Q, applied))
    }
    expect(results).toEqual(Array.from({ length: 20 }, () => deliver('mention')))
  })
})

// ---------------------------------------------------------------------------
// stripPersonaMention
// ---------------------------------------------------------------------------

describe('stripPersonaMention', () => {
  test.each<[string, string, string]>([
    ['a leading mention', `${mentionText(P_USER)} hello`, 'hello'],
    ['a leading labelled mention', `${mentionText(P_USER, 'p-bot')} hello`, 'hello'],
    ['a mid-text mention', `hi ${mentionText(P_USER)} there`, 'hi there'],
    ['every form, repeated', `${mentionText(P_USER)}  ${mentionText(P_USER, 'x')}   hello`, 'hello'],
    ['surrounding whitespace', `  ${mentionText(P_USER)}  `, ''],
    ["P's mention, keeping another persona's", `${mentionText(P_USER)} ${mentionText(Q_USER, 'q')} hi`, `${mentionText(Q_USER, 'q')} hi`],
    ["P's mention, keeping a broadcast", `${broadcastText('here')} ${mentionText(P_USER)} hi`, `${broadcastText('here')} hi`],
    ['nothing when P is not mentioned', `${mentionText(Q_USER)} hi`, `${mentionText(Q_USER)} hi`],
    ["nothing for an ID that starts with P's", `${mentionText(`${P_USER}X`)} hi`, `${mentionText(`${P_USER}X`)} hi`],
  ])('strips %s', (_label, text, expected) => {
    expect(stripPersonaMention(text, P_USER)).toBe(expected)
  })

  test.each(['', undefined])('an unknown bot user ID %p leaves the text unchanged', (botUserId) => {
    const text = `${mentionText('')} ${mentionText(P_USER)} hi`
    expect(stripPersonaMention(text, botUserId)).toBe(text)
  })
})
