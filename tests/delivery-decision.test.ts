/**
 * delivery-decision.test.ts — The pure inbound decisions: `decideDelivery`'s
 * steps in order, direct messages and group DMs, and `via` precedence; and
 * `decideReaction`'s rules in order, its accepted fields, its
 * `reaction_notices` rule (rule 4) and where it sits among the others, its
 * conversation rule in both channel modes, its reading of the configuration
 * passed at each call, and the two rules a `bot-tool` reaction skips.
 *
 * Imports the module directly: no server, no `mock.module`, no I/O. Message
 * events come from the Slack stub's event factories and reaction events from
 * `reaction` below; P and the applied view are built by `persona` / `view`,
 * and a reaction's receiver by `receiving`.
 *
 * SPDX-License-Identifier: MIT
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import { CHANNEL_ID_RE, type ChannelEntry, type DeliveryMode } from '../src/config.ts'
import {
  type AppliedPersonaView,
  type DeliveryDecision,
  type DeliveryDropReason,
  type DeliveryPersona,
  type FungibleDecisionInputs,
  type ReactionAcceptDecision,
  type ReactionDecision,
  type ReactionDecisionInputs,
  type ReactionDecisionPersona,
  type ReactionDropReason,
  type ReactionFungibleRefusal,
  type ReactionReactor,
  type Via,
  decideDelivery,
  decideReaction,
  parseReactionShape,
} from '../src/delivery-decision.ts'
import {
  broadcastText,
  ENVELOPE_FLAG_FORMS,
  envelopeFlagOf,
  makeAppMention,
  makeBotMessage,
  makeChannelMessage,
  makeDm,
  makeReaction,
  makeWebhookPost,
  mentionText,
  userGroupMentionText,
  type EnvelopeFlagForm,
  type EventOverrides,
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
/** A direct-message conversation (IDs start `D`) and a group DM (`G`). */
const DM = 'D0DIRECT01'
const GROUP_DM = 'G0GROUPDM1'

function persona(
  key: string,
  botUserId: string | undefined,
  botId: string | undefined,
  channels: readonly ChannelEntry[],
  dmEnabled = true,
): DeliveryPersona {
  return { key, botUserId, botId, channels, dmEnabled }
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
// Step 3: conversation kind (DMs and group DMs)
// ---------------------------------------------------------------------------

describe('step 3: DMs and group DMs', () => {
  const pOff = persona('p', P_USER, P_BOT, P.channels, false)
  /** P with no channel entries: a DM does not depend on channel membership. */
  const pNoChannels = persona('p', P_USER, P_BOT, [])
  const pNoChannelsOff = persona('p', P_USER, P_BOT, [], false)
  const mention = mentionText(P_USER)
  const here = broadcastText('here')
  // Slack does not send app_mention for DMs. The app_mention-shaped rows are
  // defensive: an event with no channel_type and a D… ID is still a DM.

  test.each<[string, Record<string, unknown>]>([
    ['a plain DM', makeDm({ channel: DM })],
    ['a DM with no text', makeDm({ channel: DM, text: undefined })],
    ['a DM mentioning P', makeDm({ channel: DM, text: `${mention} hi` })],
    ['a DM with <!here>', makeDm({ channel: DM, text: `${here} hi` })],
    ['a DM with <!channel>', makeDm({ channel: DM, text: `${broadcastText('channel')} hi` })],
    ["a DM with P's mention and <!here>", makeDm({ channel: DM, text: `${here} ${mention} hi` })],
    ['a DM mentioning only another persona', makeDm({ channel: DM, text: `${mentionText(Q_USER)} hi` })],
    ['an app_mention-shaped event with no channel_type and a D… ID', makeAppMention({ channel: DM, text: `${mention} hi` })],
    ['a message with no channel_type and a D… ID', makeDm({ channel: DM, channel_type: undefined })],
    ["another persona's DM to P", makeBotMessage({ channel: DM, channel_type: 'im', user: Q_USER, bot_id: Q_BOT })],
    ['a webhook-style post in a DM', makeWebhookPost({ channel: DM, channel_type: 'im' })],
    ['a file_share in a DM', makeDm({ channel: DM, subtype: 'file_share' })],
    ['a thread_broadcast in a DM', makeDm({ channel: DM, subtype: 'thread_broadcast' })],
    ['a DM whose ID P lists as all', makeDm({ channel: ALL })],
    ['a DM whose ID P lists as mentions, without a mention', makeDm({ channel: MENTIONS })],
    ['a DM whose ID only another persona lists', makeDm({ channel: Q_ONLY })],
  ])('DMs on: %s is delivered with via dm', (_label, event) => {
    expect(decide(event)).toEqual(deliver('dm'))
  })

  test.each<[string, Record<string, unknown>]>([
    ['a plain DM', makeDm({ channel: DM })],
    ["a DM with P's mention and <!here>", makeDm({ channel: DM, text: `${here} ${mention} hi` })],
    ['an app_mention-shaped event with no channel_type and a D… ID', makeAppMention({ channel: DM, text: `${mention} hi` })],
    ['a DM whose ID P lists as all', makeDm({ channel: ALL })],
  ])('DMs off: %s is dropped as dm-disabled', (_label, event) => {
    expect(decide(event, pOff, [view(pOff), view(Q)])).toEqual(drop('dm-disabled'))
  })

  test.each<[string, DeliveryPersona, DeliveryDecision]>([
    ['DMs on', pNoChannels, deliver('dm')],
    ['DMs off', pNoChannelsOff, drop('dm-disabled')],
  ])('a zero-channel persona with %s: a DM nobody lists is decided by the switch alone', (_label, receiver, expected) => {
    expect(decide(makeDm({ channel: DM }), receiver, [view(receiver)])).toEqual(expected)
    expect(decide(makeAppMention({ channel: DM, text: `${mention} hi` }), receiver, [view(receiver)])).toEqual(expected)
  })

  test.each<[string, DeliveryPersona, Record<string, unknown>]>([
    ['DMs on, plain', P, makeDm({ channel: GROUP_DM, channel_type: 'mpim' })],
    ['DMs off, plain', pOff, makeDm({ channel: GROUP_DM, channel_type: 'mpim' })],
    ["DMs on, P's mention and <!here>", P, makeDm({ channel: GROUP_DM, channel_type: 'mpim', text: `${here} ${mention} hi` })],
    ['DMs on, a group DM whose ID P lists as all', P, makeDm({ channel: ALL, channel_type: 'mpim' })],
    ['DMs on, a group DM with a D… ID', P, makeDm({ channel: DM, channel_type: 'mpim' })],
    ['zero-channel persona, DMs on', pNoChannels, makeDm({ channel: GROUP_DM, channel_type: 'mpim' })],
  ])('a group DM is dropped as group-dm: %s', (_label, receiver, event) => {
    expect(decide(event, receiver, [view(receiver), view(Q)])).toEqual(drop('group-dm'))
  })

  test.each<[string, DeliveryPersona, Record<string, unknown>, DeliveryDecision]>([
    ["P's own DM by user ID", P, makeDm({ channel: DM, user: P_USER }), drop('own')],
    ["P's own DM by bot ID", P, makeDm({ channel: DM, user: undefined, bot_id: P_BOT }), drop('own')],
    ["P's own app_mention-shaped event with no channel_type and a D… ID", P, makeAppMention({ channel: DM, user: P_USER, text: `${mention} hi` }), drop('own')],
    ["P's own DM mentioning P, DMs off", pOff, makeDm({ channel: DM, user: P_USER, text: `${mention} hi` }), drop('own')],
    ["P's own group DM", P, makeDm({ channel: GROUP_DM, channel_type: 'mpim', bot_id: P_BOT }), drop('own')],
    ['a DM with no author', P, makeDm({ channel: DM, user: undefined }), drop('no-author')],
    ['a DM with no author, DMs off', pOff, makeDm({ channel: DM, user: undefined }), drop('no-author')],
    ['a message_changed in a DM', P, makeDm({ channel: DM, subtype: 'message_changed' }), drop('non-message')],
    ['a message_deleted in a DM', P, makeDm({ channel: DM, subtype: 'message_deleted' }), drop('non-message')],
    ['a message_changed in a DM, DMs off', pOff, makeDm({ channel: DM, subtype: 'message_changed' }), drop('non-message')],
    ['a channel_join in a group DM', P, makeDm({ channel: GROUP_DM, channel_type: 'mpim', subtype: 'channel_join' }), drop('non-message')],
  ])('steps 1 and 2 run before the DM decision: %s', (_label, receiver, event, expected) => {
    expect(decide(event, receiver, [view(receiver), view(Q)])).toEqual(expected)
  })

  test.each<[string, Record<string, unknown>, DeliveryDecision]>([
    ['channel_type channel, an ID nobody lists', makeChannelMessage({ channel: DM }), { action: 'drop', reason: 'channel-not-configured', unclaimed: true }],
    ['channel_type group, an ID nobody lists', makeChannelMessage({ channel: DM, channel_type: 'group' }), { action: 'drop', reason: 'channel-not-configured', unclaimed: true }],
    ['channel_type channel, an ID P lists as all', makeChannelMessage({ channel: 'D0LISTED01' }), deliver('receive_all')],
    ['channel_type channel, an ID P lists as mentions, no mention', makeChannelMessage({ channel: 'D0LISTED02' }), drop('not-mentioned')],
  ])('a D… ID with a non-im channel_type is decided as a channel: %s', (_label, event, expected) => {
    const receiver = persona('p', P_USER, P_BOT, [
      ...P.channels,
      { id: 'D0LISTED01', delivery: 'all' },
      { id: 'D0LISTED02', delivery: 'mentions' },
    ])
    expect(decide(event, receiver, [view(receiver), view(Q)])).toEqual(expected)
  })

  test.each<[string, Record<string, unknown>, DeliveryDecision]>([
    ['a plain message in an all channel', makeChannelMessage({ channel: ALL }), deliver('receive_all')],
    ['an app_mention of P in a mentions channel', makeAppMention({ channel: MENTIONS, text: `${mention} hi` }), deliver('mention')],
    ['a channel nobody lists', makeChannelMessage({ channel: NOBODY }), { action: 'drop', reason: 'channel-not-configured', unclaimed: true }],
  ])('the DMs switch off does not change a channel decision: %s', (_label, event, expected) => {
    expect(decide(event, pOff, [view(pOff), view(Q)])).toEqual(expected)
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
// via precedence
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
// Reactions (decideReaction): fixtures
// ---------------------------------------------------------------------------

/** A person who reacts: no persona's bot user and not a Run Bot Identity. */
const PERSON = 'U0PERSON01'
/** The bot user of a persona removed during this server run: a Run Bot Identity no persona has now. */
const RETIRED_USER = 'U0RETIRED1'
/** An integration's bot ID, not a Run Bot Identity. */
const INTEGRATION_BOT = 'B0INTEG001'
/** The Run Bot Identities the injected predicate answers from: P's, Q's and the removed persona's bot users. */
const RUN_BOTS: ReadonlySet<string> = new Set([P_USER, Q_USER, RETIRED_USER])

/** The reacted message's ts, the event's ts and the emoji; distinct, so a swapped field shows. */
const MESSAGE_TS = '1700000001.000100'
const EVENT_TS = '1700000123.000456'
const EMOJI = 'eyes'

/** A conversation ID that fails `CHANNEL_ID_RE` and does not start with `D`. */
const MALFORMED = 'C0-NOT-AN-ID'

/** The Slack stub's four envelope flag forms. */
const FLAG_FORMS = Object.keys(ENVELOPE_FLAG_FORMS) as EnvelopeFlagForm[]

/**
 * A `reaction_added` event: a person's reaction on P's message in P's `all`
 * channel. `overrides` replace the event's fields (`item` as a whole
 * included) and `item` replaces fields of the default item; a key set to
 * undefined is removed.
 */
function reaction(overrides: EventOverrides = {}, item: EventOverrides = {}): Record<string, unknown> {
  return makeReaction('reaction_added', {
    user: PERSON,
    reaction: EMOJI,
    item_user: P_USER,
    event_ts: EVENT_TS,
    ...overrides,
  }, { channel: ALL, ts: MESSAGE_TS, ...item })
}

/** The default reaction in conversation `channel`, with `overrides`. */
function reactionIn(channel: string, overrides: EventOverrides = {}): Record<string, unknown> {
  return reaction(overrides, { channel })
}

/** Declarative-mode inputs for a Slack event, the Run Bot Identities `RUN_BOTS`, with `overrides`. */
function reactionInputs(overrides: Partial<ReactionDecisionInputs> = {}): ReactionDecisionInputs {
  return {
    mode: 'declarative',
    origin: 'slack-event',
    channelIdPattern: CHANNEL_ID_RE,
    isRunBotIdentity: (id) => RUN_BOTS.has(id),
    ...overrides,
  }
}

/** Fungible-mode inputs whose envelope flag is the one the Slack stub's `form` carries. */
function fungibleInputs(form: EnvelopeFlagForm = 'false'): ReactionDecisionInputs {
  return reactionInputs({ mode: 'fungible', isExtSharedChannel: envelopeFlagOf(ENVELOPE_FLAG_FORMS[form]) })
}

/** `base` as a reaction's receiver, its `reaction_notices` switch on unless `notices` is false. */
function receiving(base: DeliveryPersona, notices = true): ReactionDecisionPersona {
  return { ...base, reaction_notices: notices }
}

/** P as a reaction's receiver, its reaction notices on. */
const RP = receiving(P)
/** P with DMs off; with no confirmed bot user ID, absent or empty; listing only a `G…` ID; listing nothing. */
const P_DM_OFF = receiving(persona('p', P_USER, P_BOT, P.channels, false))
const P_NO_ID = receiving(persona('p', undefined, P_BOT, P.channels))
const P_EMPTY_ID = receiving(persona('p', '', P_BOT, P.channels))
const P_LISTS_G = receiving(persona('p', P_USER, P_BOT, [{ id: GROUP_DM, delivery: 'mentions' }]))
const P_NO_CHANNELS = receiving(persona('p', P_USER, P_BOT, []))
/** P with its reaction notices off; with DMs off too. */
const P_NOTICES_OFF = receiving(P, false)
const P_NOTICES_DM_OFF = receiving(persona('p', P_USER, P_BOT, P.channels, false), false)

/** `base` whose channel entries throw when read, for fungible-mode rows: that mode never reads them. */
function unreadChannels(base: ReactionDecisionPersona): ReactionDecisionPersona {
  return Object.defineProperty({ ...base }, 'channels', {
    enumerable: true,
    get(): never {
      throw new Error("decideReaction read P's channel entries in fungible mode")
    },
  })
}
const FP = unreadChannels(RP)
const FP_DM_OFF = unreadChannels(P_DM_OFF)
const FP_NOTICES_OFF = unreadChannels(P_NOTICES_OFF)

/** A deep copy of `value` with every object and array frozen; accessors are copied unread, functions and regexes kept. */
function frozen<T>(value: T): T {
  if (typeof value !== 'object' || value === null || value instanceof RegExp) return value
  const copy: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    Object.defineProperty(copy, key, 'value' in descriptor ? { ...descriptor, value: frozen(descriptor.value) } : descriptor)
  }
  return Object.freeze(copy) as T
}

/** `receiver`'s decision on `event`, each argument passed as a deep-frozen copy, so a write to one throws. */
function react(event: unknown, receiver: ReactionDecisionPersona = RP, inputs: ReactionDecisionInputs = reactionInputs()): ReactionDecision {
  return decideReaction(frozen(event), frozen(receiver), frozen(inputs))
}

/** The default reaction's accept outcome under declarative-mode inputs. */
const ACCEPTED = {
  action: 'accept',
  channel: ALL,
  message_ts: MESSAGE_TS,
  ts: EVENT_TS,
  change: 'added',
  emoji: EMOJI,
  mode: 'declarative',
  origin: 'slack-event',
} as const

type AcceptedFacts = Partial<Pick<ReactionAcceptDecision, 'channel' | 'message_ts' | 'ts' | 'change' | 'emoji' | 'mode' | 'origin'>>

/** An accept outcome: `ACCEPTED` with `facts` over it, and the reactor (the person unless given). */
function accepted(facts: AcceptedFacts = {}, reactor: ReactionReactor = { user: PERSON }): ReactionDecision {
  return { ...ACCEPTED, ...facts, ...reactor }
}

const dropped = (reason: Exclude<ReactionDropReason, 'fungible-refused'>): ReactionDecision => ({ action: 'drop', reason })
const refused = (refusal: ReactionFungibleRefusal): ReactionDecision => ({ action: 'drop', reason: 'fungible-refused', refusal })

type ReactionRow = [label: string, event: unknown, expected: ReactionDecision, receiver: ReactionDecisionPersona, inputs: ReactionDecisionInputs]

/** One table row: P under declarative-mode inputs unless `receiver` or `inputs` is given. */
function row(
  label: string,
  event: unknown,
  expected: ReactionDecision,
  receiver: ReactionDecisionPersona = RP,
  inputs: ReactionDecisionInputs = reactionInputs(),
): ReactionRow {
  return [label, event, expected, receiver, inputs]
}

/** The one assertion of a row: the whole outcome, by strict equality. */
function expectRow(_label: string, event: unknown, expected: ReactionDecision, receiver: ReactionDecisionPersona, inputs: ReactionDecisionInputs): void {
  expect(react(event, receiver, inputs)).toStrictEqual(expected)
}

// ---------------------------------------------------------------------------
// Reactions: parsed lookup and storage facts
// ---------------------------------------------------------------------------

describe('parseReactionShape: facts before policy', () => {
  test.each([
    ['reaction_added', 'added', ` ${PERSON} `, Q_USER, { id: ` ${PERSON} `, fields: { user: ` ${PERSON} ` } }],
    ['reaction_removed', 'removed', '', ` ${INTEGRATION_BOT} `, { id: ` ${INTEGRATION_BOT} `, fields: { bot_id: ` ${INTEGRATION_BOT} ` } }],
  ] as const)('%s keeps untrimmed lookup facts and the selected reactor in its durable key', (type, change, user, bot_id, reactor) => {
    const event = frozen(reaction({ type, user, bot_id, reaction: ' :+1::skin-tone-2: ', event_ts: ` ${EVENT_TS} `, item_user: ` ${P_USER} ` }, { channel: ` ${ALL} `, ts: ` ${MESSAGE_TS} ` }))
    expect(parseReactionShape(event)).toStrictEqual({
      change, channel: ` ${ALL} `, messageTs: ` ${MESSAGE_TS} `,
      emoji: ' :+1::skin-tone-2: ', eventTs: ` ${EVENT_TS} `, itemUser: ` ${P_USER} `, reactor,
      reactionKey: { chat_id: ` ${ALL} `, message_ts: ` ${MESSAGE_TS} `, reactor: reactor.id, emoji: ' :+1::skin-tone-2: ', change, event_ts: ` ${EVENT_TS} ` },
    })
  })

  test('a missing reactor preserves the message location and ownership facts without inventing a durable key', () => {
    expect(parseReactionShape(frozen(reaction({ user: undefined, item_user: Q_USER })))).toStrictEqual({
      change: 'added', channel: ALL, messageTs: MESSAGE_TS, emoji: EMOJI, eventTs: EVENT_TS,
      itemUser: Q_USER, reactor: undefined, reactionKey: undefined,
    })
  })
})

// ---------------------------------------------------------------------------
// Reactions: accepted
// ---------------------------------------------------------------------------

describe('reactions: accepted, the reaction kept exactly as received', () => {
  test.each<ReactionRow>([
    row("declarative: reaction_added by a person on P's message in P's all channel", reaction(), accepted()),
    row('declarative: reaction_removed', reaction({ type: 'reaction_removed' }), accepted({ change: 'removed' })),
    row('fungible: reaction_added', reaction(), accepted({ mode: 'fungible' }), FP, fungibleInputs()),
    row('fungible: reaction_removed', reaction({ type: 'reaction_removed' }), accepted({ change: 'removed', mode: 'fungible' }), FP, fungibleInputs()),
    row("an integration's bot ID with no user, not a Run Bot Identity", reaction({ user: undefined, bot_id: INTEGRATION_BOT }), accepted({}, { bot_id: INTEGRATION_BOT })),
    row('an empty user: the bot ID is the reactor', reaction({ user: '', bot_id: INTEGRATION_BOT }), accepted({}, { bot_id: INTEGRATION_BOT })),
    row('a non-string user: the bot ID is the reactor', reaction({ user: 42, bot_id: INTEGRATION_BOT }), accepted({}, { bot_id: INTEGRATION_BOT })),
    row("a person's user beside a Run Bot Identity as bot ID: the user alone is the reactor", reaction({ bot_id: Q_USER }), accepted()),
    row(
      'colons, a skin tone and padding in the emoji and both timestamps are kept',
      reaction({ reaction: ' :+1::skin-tone-2: ', event_ts: ` ${EVENT_TS}` }, { ts: `${MESSAGE_TS} ` }),
      accepted({ emoji: ' :+1::skin-tone-2: ', ts: ` ${EVENT_TS}`, message_ts: `${MESSAGE_TS} ` }),
    ),
  ])('%s', expectRow)
})

// ---------------------------------------------------------------------------
// Reactions, rule 1: shape
// ---------------------------------------------------------------------------

describe('reactions, rule 1: not-a-message-reaction', () => {
  /** Each string the shape rule requires, set to a value (undefined removes it). */
  const REQUIRED: [string, (value: unknown) => unknown][] = [
    ['item.channel', (value) => reaction({}, { channel: value })],
    ['item.ts', (value) => reaction({}, { ts: value })],
    ['reaction', (value) => reaction({ reaction: value })],
    ['event_ts', (value) => reaction({ event_ts: value })],
  ]
  const NOT_NON_EMPTY: [string, unknown][] = [['absent', undefined], ['empty', ''], ['a number', 7]]

  test.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'reaction_added'],
    ['an array carrying valid reaction fields', Object.assign([], reaction())],
    ['a message event', makeChannelMessage({ channel: ALL })],
    ['an event with no type', reaction({ type: undefined })],
    ['a pin_added event on a message', reaction({ type: 'pin_added' })],
    ['a type in another case', reaction({ type: 'Reaction_Added' })],
    ['a non-string type', reaction({ type: 1 })],
    ['no item', reaction({ item: undefined })],
    ['a null item', reaction({ item: null })],
    ['a string item', reaction({ item: 'message' })],
    ['an array item carrying valid message fields', reaction({ item: Object.assign([], reaction().item) })],
    ['an item of type file', reaction({}, { type: 'file' })],
    ['a reaction_removed on an item of type file_comment', reaction({ type: 'reaction_removed' }, { type: 'file_comment' })],
    ['an item with no type', reaction({}, { type: undefined })],
    ...REQUIRED.flatMap(([field, build]) => NOT_NON_EMPTY.map(([form, value]): [string, unknown] => [`${field} ${form}`, build(value)])),
  ])('%s is not-a-message-reaction', (_label, event) => {
    expect(react(event)).toStrictEqual(dropped('not-a-message-reaction'))
    expect(parseReactionShape(frozen(event))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Reactions, rule 2: P's own message
// ---------------------------------------------------------------------------

describe("reactions, rule 2: not-own-message", () => {
  test.each<[string, unknown, ReactionDecisionPersona]>([
    ["Q's message", reaction({ item_user: Q_USER }), RP],
    ['no item_user', reaction({ item_user: undefined }), RP],
    ['an empty item_user', reaction({ item_user: '' }), RP],
    ['a non-string item_user', reaction({ item_user: 7 }), RP],
    ["P's bot user ID after a space", reaction({ item_user: ` ${P_USER}` }), RP],
    ["P's bot user ID in lower case", reaction({ item_user: P_USER.toLowerCase() }), RP],
    ['P with no confirmed bot user ID', reaction(), P_NO_ID],
    ['P with no confirmed bot user ID, no item_user', reaction({ item_user: undefined }), P_NO_ID],
    ["P's confirmed bot user ID empty, item_user empty", reaction({ item_user: '' }), P_EMPTY_ID],
    ["P's confirmed bot user ID empty, no item_user", reaction({ item_user: undefined }), P_EMPTY_ID],
  ])('%s is not-own-message', (_label, event, receiver) => {
    expect(react(event, receiver)).toStrictEqual(dropped('not-own-message'))
  })
})

// ---------------------------------------------------------------------------
// Reactions, rule 3: the reactor
// ---------------------------------------------------------------------------

describe('reactions, rule 3: the reactor', () => {
  test.each<ReactionRow>([
    row('no user and no bot ID', reaction({ user: undefined }), dropped('no-reactor')),
    row('an empty user and an empty bot ID', reaction({ user: '', bot_id: '' }), dropped('no-reactor')),
    row('a non-string user and bot ID', reaction({ user: 7, bot_id: null }), dropped('no-reactor')),
    row("P's own reaction, P's bot user being a Run Bot Identity too", reaction({ user: P_USER }), dropped('own-reaction')),
    row("P's bot user ID as the bot ID of a reaction with no user", reaction({ user: undefined, bot_id: P_USER }), dropped('own-reaction')),
    row("Q's reaction", reaction({ user: Q_USER }), dropped('bot-reaction')),
    row("a removed persona's reaction, a Run Bot Identity no persona has now", reaction({ user: RETIRED_USER }), dropped('bot-reaction')),
    row('an empty user beside a Run Bot Identity as bot ID', reaction({ user: '', bot_id: Q_USER }), dropped('bot-reaction')),
    row("P's removed reaction by user, before notices-off", reaction({ type: 'reaction_removed', user: P_USER }), dropped('own-reaction'), P_NOTICES_OFF),
    row("P's removed reaction by bot ID, before notices-off", reaction({ type: 'reaction_removed', user: undefined, bot_id: P_USER }), dropped('own-reaction'), P_NOTICES_OFF),
    row("Q's removed reaction, before notices-off", reaction({ type: 'reaction_removed', user: Q_USER }), dropped('bot-reaction'), P_NOTICES_OFF),
    row("a retired Run Bot Identity's removed reaction, before notices-off", reaction({ type: 'reaction_removed', user: RETIRED_USER }), dropped('bot-reaction'), P_NOTICES_OFF),
  ])('%s', expectRow)
})

// ---------------------------------------------------------------------------
// Reactions, rule 4: P's reaction notices
// ---------------------------------------------------------------------------

describe('reactions, rule 4: notices-off', () => {
  test.each<ReactionRow>([
    row('declarative: reaction_added', reaction(), dropped('notices-off'), P_NOTICES_OFF),
    row('declarative: reaction_removed', reaction({ type: 'reaction_removed' }), dropped('notices-off'), P_NOTICES_OFF),
    row("declarative: an integration's bot ID with no user", reaction({ user: undefined, bot_id: INTEGRATION_BOT }), dropped('notices-off'), P_NOTICES_OFF),
    row('declarative: a DM, DMs on', reactionIn(DM), dropped('notices-off'), P_NOTICES_OFF),
    row('fungible: reaction_added', reaction(), dropped('notices-off'), FP_NOTICES_OFF, fungibleInputs()),
    row('fungible: reaction_removed', reaction({ type: 'reaction_removed' }), dropped('notices-off'), FP_NOTICES_OFF, fungibleInputs()),
  ])("%s, otherwise accepted, with P's reaction notices off", expectRow)
})

// ---------------------------------------------------------------------------
// Reactions: rule order
// ---------------------------------------------------------------------------

describe('reactions: the first rule an event fails decides', () => {
  test.each<ReactionRow>([
    row(
      "every rule failing: a file reaction with no reactor on Q's message in a DM, DMs and reaction notices off",
      reaction({ user: undefined, item_user: Q_USER }, { type: 'file', channel: DM }),
      dropped('not-a-message-reaction'),
      P_NOTICES_DM_OFF,
    ),
    row("P's own reaction on Q's message", reaction({ user: P_USER, item_user: Q_USER }), dropped('not-own-message')),
    row("no reactor on Q's message", reaction({ user: undefined, item_user: Q_USER }), dropped('not-own-message')),
    row("Q's reaction in a channel nobody lists", reactionIn(NOBODY, { user: Q_USER }), dropped('bot-reaction')),
    row("Q's reaction in a DM, DMs off", reactionIn(DM, { user: Q_USER }), dropped('bot-reaction'), P_DM_OFF),
    row("fungible: Q's reaction on a malformed ID, flag absent", reactionIn(MALFORMED, { user: Q_USER }), dropped('bot-reaction'), FP, fungibleInputs('absent')),
    row("a DM reaction on Q's message, DMs on", reactionIn(DM, { item_user: Q_USER }), dropped('not-own-message')),
    row('a DM reaction, DMs on, P with no confirmed bot user ID', reactionIn(DM), dropped('not-own-message'), P_NO_ID),
    row('a DM reaction with no reactor, DMs on', reactionIn(DM, { user: undefined }), dropped('no-reactor')),
    row("P's own reaction in a DM, DMs on", reactionIn(DM, { user: P_USER }), dropped('own-reaction')),
    row("P's own reaction in a DM, DMs off", reactionIn(DM, { user: P_USER }), dropped('own-reaction'), P_DM_OFF),
    row('fungible: a DM reaction with no reactor, DMs off', reactionIn(DM, { user: undefined }), dropped('no-reactor'), FP_DM_OFF, fungibleInputs()),
    // Rule 3 wins before rule 4; rule 4 wins before the conversation rule.
    row("reaction notices off: Q's reaction in a channel nobody lists", reactionIn(NOBODY, { user: Q_USER }), dropped('bot-reaction'), P_NOTICES_OFF),
    row('reaction notices off: declarative, a channel nobody lists', reactionIn(NOBODY), dropped('notices-off'), P_NOTICES_OFF),
  ])('%s', expectRow)
})

// ---------------------------------------------------------------------------
// Reactions, rule 5: the conversation
// ---------------------------------------------------------------------------

describe('reactions, rule 5: a conversation P serves now', () => {
  test.each<ReactionRow>([
    row("declarative: P's mentions channel, whatever its delivery", reactionIn(MENTIONS), accepted({ channel: MENTIONS })),
    row('declarative: a channel nobody lists', reactionIn(NOBODY), dropped('unserved-conversation')),
    row('declarative: a channel only Q lists', reactionIn(Q_ONLY), dropped('unserved-conversation')),
    // Whether a listed G… ID is a group DM is decided in preparation, not here.
    row('declarative: a G… ID P lists', reactionIn(GROUP_DM), accepted({ channel: GROUP_DM }), P_LISTS_G),
    row('declarative: a G… ID P does not list', reactionIn(GROUP_DM), dropped('unserved-conversation')),
    row(
      'declarative: a listed channel, flag true and a pattern nothing matches',
      reaction(),
      accepted(),
      RP,
      reactionInputs({ isExtSharedChannel: true, channelIdPattern: /(?!)/ }),
    ),
    row('declarative: a channel nobody lists, flag false', reactionIn(NOBODY), dropped('unserved-conversation'), RP, reactionInputs({ isExtSharedChannel: false })),
    row('declarative: a DM, DMs on', reactionIn(DM), accepted({ channel: DM })),
    row('declarative: a DM, DMs on, P listing no channel', reactionIn(DM), accepted({ channel: DM }), P_NO_CHANNELS),
    row('declarative: a DM, DMs off', reactionIn(DM), dropped('dm-disabled'), P_DM_OFF),
    row('fungible: a G… channel nobody lists, flag false', reactionIn(GROUP_DM), accepted({ channel: GROUP_DM, mode: 'fungible' }), FP, fungibleInputs()),
    ...FLAG_FORMS.map((form) => row(`fungible: a malformed ID, flag ${form}`, reactionIn(MALFORMED), refused('channel-id-malformed'), FP, fungibleInputs(form))),
    row('fungible: a DM, DMs on, flag true', reactionIn(DM), accepted({ channel: DM, mode: 'fungible' }), FP, fungibleInputs('true')),
    row('fungible: a DM, DMs on, flag absent', reactionIn(DM), accepted({ channel: DM, mode: 'fungible' }), FP, fungibleInputs('absent')),
    row('fungible: a DM, DMs off, flag false', reactionIn(DM), dropped('dm-disabled'), FP_DM_OFF, fungibleInputs()),
  ])('%s', expectRow)

  const FLAG_OUTCOMES: Record<EnvelopeFlagForm, ReactionDecision> = {
    false: accepted({ channel: NOBODY, mode: 'fungible' }),
    true: refused('externally-shared'),
    absent: refused('flag-missing'),
    'non-boolean': refused('flag-not-boolean'),
  }

  test.each(FLAG_FORMS)('fungible: a channel nobody lists, envelope flag form %s', (form) => {
    expect(react(reactionIn(NOBODY), FP, fungibleInputs(form))).toStrictEqual(FLAG_OUTCOMES[form])
  })
})

// ---------------------------------------------------------------------------
// Reactions: channel delivery, stored choices and the loop guard (SR-3.2)
// ---------------------------------------------------------------------------

describe('reactions: channel delivery, stored choices and the loop guard play no part', () => {
  /** P's stored `mentions` channel, and Q's fungible destination, where P stored `all`. */
  const STORED_MENTIONS = 'C0STOREDM1'
  const LOOP_HELD = 'C0QDEST001'
  const P_STORED: Readonly<Record<string, DeliveryMode>> = { [STORED_MENTIONS]: 'mentions', [LOOP_HELD]: 'all' }
  const messageInputs: FungibleDecisionInputs = {
    mode: 'fungible',
    isExtSharedChannel: false,
    channelIdPattern: CHANNEL_ID_RE,
    fungibleDestinations: [{ key: Q.key, destination: LOOP_HELD }],
    storedChoices: { readable: true, storedChoice: (key, channel) => (key === P.key ? P_STORED[channel] : undefined) },
  }
  const heardAtMentions: DeliveryDecision = {
    action: 'drop',
    reason: 'not-mentioned',
    fungible: { channelType: 'public', channelDelivery: 'mentions' },
  }

  test.each<[string, string, FungibleDecisionInputs | undefined, DeliveryDecision, ReactionDecisionInputs, ReactionDecision]>([
    ["declarative: P's mentions channel", MENTIONS, undefined, drop('not-mentioned'), reactionInputs(), accepted({ channel: MENTIONS })],
    ["fungible: P's stored mentions", STORED_MENTIONS, messageInputs, heardAtMentions, fungibleInputs(), accepted({ channel: STORED_MENTIONS, mode: 'fungible' })],
    [
      "fungible: Q's destination, the loop guard holding P's stored all",
      LOOP_HELD,
      messageInputs,
      heardAtMentions,
      fungibleInputs(),
      accepted({ channel: LOOP_HELD, mode: 'fungible' }),
    ],
  ])('%s: a plain message is not delivered, a reaction is accepted', (_label, channel, messageWith, messageOutcome, reactionWith, reactionOutcome) => {
    const message = decideDelivery(makeChannelMessage({ channel, text: 'plain words' }), P, [view(P), view(Q)], messageWith)
    expect([message, react(reactionIn(channel), RP, reactionWith)]).toStrictEqual([messageOutcome, reactionOutcome])
  })
})

// ---------------------------------------------------------------------------
// Reactions: the configuration in effect at each call (SR-3.3)
// ---------------------------------------------------------------------------

describe('reactions: each call reads the configuration it is given', () => {
  test('the same frozen events, decided after each change to the channels, the mode, the DMs switch and the reaction notices switch', () => {
    const inAll = frozen(reaction())
    const inDm = frozen(reactionIn(DM))
    const listing = frozen(RP)
    const notListing = frozen(P_NO_CHANNELS)
    const dmOff = frozen(P_DM_OFF)
    const noticesOff = frozen(P_NOTICES_OFF)
    const declarative = frozen(reactionInputs())
    const fungible = frozen(fungibleInputs())
    const calls: [unknown, ReactionDecisionPersona, ReactionDecisionInputs][] = [
      [inAll, listing, declarative],
      [inAll, notListing, declarative],
      [inAll, notListing, fungible],
      [inAll, listing, declarative],
      [inDm, listing, declarative],
      [inDm, dmOff, declarative],
      [inDm, dmOff, fungible],
      [inDm, listing, fungible],
      [inDm, noticesOff, fungible],
      [inAll, noticesOff, declarative],
      [inAll, listing, declarative],
    ]
    expect(calls.map(([event, receiver, inputs]) => decideReaction(event, receiver, inputs))).toStrictEqual([
      accepted(),
      dropped('unserved-conversation'),
      accepted({ mode: 'fungible' }),
      accepted(),
      accepted({ channel: DM }),
      dropped('dm-disabled'),
      dropped('dm-disabled'),
      accepted({ channel: DM, mode: 'fungible' }),
      dropped('notices-off'),
      dropped('notices-off'),
      accepted(),
    ])
  })
})

// ---------------------------------------------------------------------------
// Reactions from a Bot's react tool (origin bot-tool, SR-6.3)
// ---------------------------------------------------------------------------

describe("reactions from another persona's react tool (origin bot-tool): only the Run Bot and envelope-flag rules are skipped", () => {
  /** Every ID a `bot-tool` decision asked the Run Bot predicate about; it must ask about none. */
  const queried: string[] = []
  beforeEach(() => {
    queried.length = 0
  })

  /** `bot-tool` inputs whose Run Bot predicate records the ID and throws, so a decision that asks fails either way. */
  function botToolInputs(overrides: Partial<ReactionDecisionInputs> = {}): ReactionDecisionInputs {
    return reactionInputs({
      origin: 'bot-tool',
      isRunBotIdentity: (id) => {
        queried.push(id)
        throw new Error(`decideReaction asked whether ${id} is a Run Bot Identity for a bot-tool reaction`)
      },
      ...overrides,
    })
  }

  /** Fungible-mode `bot-tool` inputs carrying the Slack stub's envelope flag form `form`. */
  function botToolFungibleInputs(form: EnvelopeFlagForm): ReactionDecisionInputs {
    return botToolInputs({ mode: 'fungible', isExtSharedChannel: envelopeFlagOf(ENVELOPE_FLAG_FORMS[form]) })
  }

  /** A `bot-tool` accept outcome: `facts` over the defaults, origin `bot-tool`, Q's bot user the reactor unless given. */
  function botToolAccepted(facts: AcceptedFacts = {}, reactor: ReactionReactor = { user: Q_USER }): ReactionDecision {
    return accepted({ ...facts, origin: 'bot-tool' }, reactor)
  }

  /** The bot-tool row's outcome and the Run Bot queries it made. */
  function expectBotToolRow(_label: string, event: unknown, expected: ReactionDecision, receiver: ReactionDecisionPersona, inputs: ReactionDecisionInputs): void {
    expect({ outcome: react(event, receiver, inputs), queried }).toStrictEqual({ outcome: expected, queried: [] })
  }

  test.each<[label: string, event: unknown, receiver: ReactionDecisionPersona, slackEvent: ReactionDecisionInputs, botTool: ReactionDecisionInputs, expected: ReactionDecision]>([
    ["Q's reaction on P's message in P's all channel", reaction({ user: Q_USER }), RP, reactionInputs(), botToolInputs(), botToolAccepted()],
    [
      "a removed persona's reaction, a Run Bot Identity no persona has now",
      reaction({ user: RETIRED_USER }),
      RP,
      reactionInputs(),
      botToolInputs(),
      botToolAccepted({}, { user: RETIRED_USER }),
    ],
    ["Q's bot user as the bot ID of a reaction with no user", reaction({ user: undefined, bot_id: Q_USER }), RP, reactionInputs(), botToolInputs(), botToolAccepted({}, { bot_id: Q_USER })],
    ["Q's reaction in a DM, DMs on", reactionIn(DM, { user: Q_USER }), RP, reactionInputs(), botToolInputs(), botToolAccepted({ channel: DM })],
    [
      "fungible: Q's reaction in a channel nobody lists, flag false",
      reactionIn(NOBODY, { user: Q_USER }),
      FP,
      fungibleInputs(),
      botToolFungibleInputs('false'),
      botToolAccepted({ channel: NOBODY, mode: 'fungible' }),
    ],
    [
      "Q's reaction with colons, a skin tone and padding in the emoji and both timestamps, kept exactly",
      reaction({ user: Q_USER, reaction: ' :+1::skin-tone-2: ', event_ts: ` ${EVENT_TS}` }, { ts: `${MESSAGE_TS} ` }),
      RP,
      reactionInputs(),
      botToolInputs(),
      botToolAccepted({ emoji: ' :+1::skin-tone-2: ', ts: ` ${EVENT_TS}`, message_ts: `${MESSAGE_TS} ` }),
    ],
  ])('%s: bot-reaction from a Slack event, accepted with origin bot-tool and no Run Bot query', (_label, event, receiver, slackEvent, botTool, expected) => {
    const fromSlack = react(event, receiver, slackEvent)
    const fromTool = react(event, receiver, botTool)
    expect({ fromSlack, fromTool, queried }).toStrictEqual({ fromSlack: dropped('bot-reaction'), fromTool: expected, queried: [] })
  })

  test.each<ReactionRow>([
    row("declarative: Q's reaction in a channel nobody lists", reactionIn(NOBODY, { user: Q_USER }), dropped('unserved-conversation'), RP, botToolInputs()),
    row("declarative: Q's reaction in a DM, DMs off", reactionIn(DM, { user: Q_USER }), dropped('dm-disabled'), P_DM_OFF, botToolInputs()),
    row(
      "every rule failing: a file reaction with no reactor on Q's message in a DM, DMs and reaction notices off",
      reaction({ user: undefined, item_user: Q_USER }, { type: 'file', channel: DM }),
      dropped('not-a-message-reaction'),
      P_NOTICES_DM_OFF,
      botToolInputs(),
    ),
    // Neither skipped rule skips rule 4: Q is a Run Bot Identity and the event has no envelope flag.
    row(
      "reaction notices off, fungible: Q's reaction in a channel nobody lists, flag absent",
      reactionIn(NOBODY, { user: Q_USER }),
      dropped('notices-off'),
      FP_NOTICES_OFF,
      botToolFungibleInputs('absent'),
    ),
    row("ownership before the reactor: no reactor on Q's message", reaction({ user: undefined, item_user: Q_USER }), dropped('not-own-message'), RP, botToolInputs()),
    row("the reactor before the conversation: P's own reaction in a channel nobody lists", reactionIn(NOBODY, { user: P_USER }), dropped('own-reaction'), RP, botToolInputs()),
    row(
      "the reactor before the conversation, fungible: no reactor on a malformed ID, flag true",
      reactionIn(MALFORMED, { user: undefined }),
      dropped('no-reactor'),
      FP,
      botToolFungibleInputs('true'),
    ),
  ])('every other rule still applies, in order: %s', expectBotToolRow)

  test.each(FLAG_FORMS)("fungible: Q's reaction in a channel nobody lists is accepted whatever the envelope flag (form %s)", (form) => {
    expectBotToolRow('', reactionIn(NOBODY, { user: Q_USER }), botToolAccepted({ channel: NOBODY, mode: 'fungible' }), FP, botToolFungibleInputs(form))
  })

  test.each(FLAG_FORMS)("fungible: a malformed ID is still channel-id-malformed, the channel ID checked before the flag (form %s)", (form) => {
    expectBotToolRow('', reactionIn(MALFORMED, { user: Q_USER }), refused('channel-id-malformed'), FP, botToolFungibleInputs(form))
  })
})
