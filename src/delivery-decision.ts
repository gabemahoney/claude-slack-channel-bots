/**
 * delivery-decision.ts — The one place inbound delivery is decided, in both
 * channel modes: `decideDelivery` for messages and `decideReaction` for
 * reactions.
 *
 * `decideDelivery` takes a raw Slack `message` / `app_mention` event, the
 * receiving persona P (key, bot user ID, bot ID, channel entries, DMs switch),
 * a read-only view of every applied persona's key and channel entries, and,
 * optionally, the fungible-mode inputs (`FungibleDecisionInputs`: the channel
 * mode, the envelope flag, the channel-ID pattern, the stored choices with
 * their readability, and every applied persona's fungible destination). It
 * returns either deliver (with how the message reached P, `via`) or drop
 * (with a machine-readable reason). With no fungible-mode inputs, or with
 * their mode `declarative`, the decision is declarative mode's: the stored
 * choices, the envelope flag and the fungible destinations play no part, and
 * no outcome carries a key beyond declarative mode's.
 *
 * Steps 1 to 3 run first in both modes:
 *
 * 1. Message shape: no subtype, or one of `file_share`, `bot_message`,
 *    `thread_broadcast`, `me_message`; any other subtype, a non-object or an
 *    event with no channel is `non-message`.
 * 2. Author: an event with neither `user` nor `bot_id` cannot be attributed
 *    and is `no-author`. Self-exclusion is the only author filter: the author
 *    `user` equal to P's bot user ID, or the event's `bot_id` equal to P's bot
 *    ID, is `own`. An author without `user` (webhooks, integrations) is
 *    identified by its bot ID and carries on.
 * 3. Conversation kind. A DM (`channel_type` `im`, or, as a
 *    defensive fallback for an event with no `channel_type`, a conversation ID
 *    starting with `D`) depends only on P's DMs switch: on,
 *    it delivers with `via` `dm`, whatever the text mentions; off, it is
 *    `dm-disabled`. A group DM (`channel_type` `mpim`) is `group-dm`, never
 *    delivered. Neither reaches the channel steps below.
 *
 * Declarative mode:
 *
 * 4. A channel P is not configured into is `channel-not-configured`, with
 *    `unclaimed` set when no applied persona lists it.
 * 5. `delivery: all` delivers.
 * 6. `delivery: mentions` delivers when the text holds P's user mention
 *    (`<@P>` or `<@P|label>`) or a broadcast (`<!here>` / `<!channel>`, with or
 *    without a label); otherwise `not-mentioned`. `<!everyone>` and user-group
 *    mentions (`<!subteam^…>`) are not mentions.
 *
 * Fungible mode. No persona's channel entries are read, P's or any other's.
 *
 * 4. The fungible path: the event takes it only when all of these
 *    hold, checked in this order, `FUNGIBLE_REFUSALS`' order: its
 *    `channel_type` is `channel` or `group`; its channel ID matches the
 *    channel-ID pattern; the envelope flag is present; it is a boolean; it is
 *    `false`. The first that fails is a `fungible-refused` drop carrying that
 *    refusal. The flag alone decides whether a channel is externally shared.
 * 5. P's channel delivery for the channel (`channelDeliveryFor`):
 *    `mentions` when the channel is another applied persona's fungible
 *    destination (the loop guard), else P's stored choice when the store is
 *    readable, else `mentions`.
 * 6. `via` in the shipped order: P's mention is `mention`; else a
 *    broadcast is `broadcast`; else a channel delivery of `all` delivers, as
 *    `receive_all_shared` when at least one other applied persona's channel
 *    delivery for the channel is `all` and as `receive_all` otherwise; else
 *    `not-mentioned`. Mention and broadcast recognition are declarative
 *    mode's.
 *
 * Every outcome of an event that took the fungible path, deliver or drop,
 * carries `fungible`: the channel type (`public` for `channel`, `private` for
 * `group`) and P's channel delivery, so the routing logs its audit line and
 * its drop lines without deciding anything.
 *
 * An empty or unknown bot user ID or bot ID never matches an author or a
 * mention.
 *
 * `decideReaction` is a separate decision, made before any network call or
 * store, for one raw `reaction_added` / `reaction_removed` event. It takes
 * the receiving persona P (key, confirmed bot user ID, channel entries, DMs
 * switch) and `ReactionDecisionInputs` (the channel mode, the envelope flag,
 * the channel-ID pattern, where the event came from, and whether an ID is one
 * of the Run Bot Identities: the bot user IDs confirmed for any persona
 * during this server run). It returns accept (with the reaction's facts and
 * its reactor, a `user` or a `bot_id`) or drop (with a machine-readable
 * reason). The first rule the event fails drops it:
 *
 * 1. Reaction shape: the event is `reaction_added` (change `added`) or
 *    `reaction_removed` (change `removed`), its `item.type` is `message`,
 *    and `item.channel`, `item.ts`, `reaction` and `event_ts` are non-empty
 *    strings; otherwise `not-a-message-reaction`.
 * 2. Ownership: `item_user` is P's confirmed bot user ID; otherwise, or when
 *    P has none, `not-own-message`.
 * 3. Reactor: the event's `user`, or its `bot_id` when it has no `user`;
 *    with neither, `no-reactor`. A reactor that is P's bot user ID is
 *    `own-reaction`; one of the Run Bot Identities is `bot-reaction`.
 * 4. Conversation: one P serves now. A conversation ID starting with `D` is a
 *    DM, accepted when P's DMs switch is on and `dm-disabled` otherwise. In
 *    declarative mode any other conversation must be one of P's channel
 *    entries, whatever its `delivery`, else `unserved-conversation`; the
 *    envelope flag and the channel-ID pattern play no part. In fungible mode
 *    no persona's channel entries are read: the conversation ID must match
 *    the channel-ID pattern and the envelope flag must be present, a boolean
 *    and `false`, else `fungible-refused` with the refusal of the first
 *    that fails. Reaction events carry no `channel_type`, so the group-DM
 *    exclusion and the fungible path's channel-type condition are left to the
 *    reaction's preparation after acceptance.
 *
 * P's channel delivery (`mentions` or `all`), the stored choices and the
 * loop guard play no part in a reaction's decision. Both decisions check the
 * fungible path's channel-ID and envelope-flag conditions with the same
 * helpers, in `FUNGIBLE_REFUSALS`' order.
 *
 * Pure and stateless: imports types only,
 * creates no client, reads no file or environment variable, logs nothing, and
 * keeps no counter, rate limit, per-sender memory or cross-persona
 * arbitration. The mode, the stored choices, the destinations and the Run
 * Bot Identities arrive as inputs at each call.
 *
 * SPDX-License-Identifier: MIT
 */

import type { ChannelEntry, ChannelMode, DeliveryMode, DM_DESTINATION } from './config.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subtypes delivered like a plain message (step 1). */
const DELIVERABLE_SUBTYPES: ReadonlySet<string> = new Set([
  'file_share',
  'bot_message',
  'thread_broadcast',
  'me_message',
])

/** `channel_type` of a direct message. */
const DM_CHANNEL_TYPE = 'im'

/** `channel_type` of a group DM (multi-person direct message). */
const GROUP_DM_CHANNEL_TYPE = 'mpim'

/** First character of a direct-message conversation ID. */
const DM_CONVERSATION_PREFIX = 'D'

/** `<!here>` or `<!channel>`, each with or without a `|label`. */
const BROADCAST_PATTERN = /<!(?:here|channel)(?:\|[^>]*)?>/

/** `channel_type` of a public channel. */
const PUBLIC_CHANNEL_TYPE = 'channel'

/** `channel_type` of a private channel. */
const PRIVATE_CHANNEL_TYPE = 'group'

/** The channel mode in which the fungible path applies. */
const FUNGIBLE_MODE: ChannelMode = 'fungible'

/** The channel delivery that hears every message. */
const DELIVERY_ALL: DeliveryMode = 'all'

/** The channel delivery that hears mentions and broadcasts only, and the default. */
const DELIVERY_MENTIONS: DeliveryMode = 'mentions'

/** The event type of a reaction added to an item (change `added`). */
const REACTION_ADDED_EVENT = 'reaction_added'

/** The event type of a reaction removed from an item (change `removed`). */
const REACTION_REMOVED_EVENT = 'reaction_removed'

/** The `item.type` of a reaction on a message. */
const MESSAGE_ITEM_TYPE = 'message'

/**
 * The destination value that sends by DM (`DM_DESTINATION` in
 * `src/config.ts`, held to it by its type). A DM destination is no channel,
 * so the loop guard never holds anything for it.
 */
const DM_DESTINATION_VALUE: typeof DM_DESTINATION = 'dm'

/**
 * Why an event that passed steps 1 to 3 does not take the fungible path
 * in the order the conditions are checked: its `channel_type`
 * is not `channel` or `group`; its channel ID does not match the channel-ID
 * pattern; the envelope flag is missing; it is not a boolean; it is `true`
 * (externally shared).
 */
export const FUNGIBLE_REFUSALS = [
  'not-a-channel',
  'channel-id-malformed',
  'flag-missing',
  'flag-not-boolean',
  'externally-shared',
] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How a delivered message reached the persona,
 * first match wins: `dm` (a direct message to P), `mention` (P's user
 * mention), `broadcast` (`<!here>` / `<!channel>`), `receive_all_shared`
 * (`all` for P and at least one other applied persona: their `delivery`
 * entries in declarative mode, their channel deliveries in fungible mode),
 * `receive_all`.
 */
export type Via = 'dm' | 'mention' | 'broadcast' | 'receive_all_shared' | 'receive_all'

/**
 * Why a persona does not get a message:
 * - `non-message`: not a deliverable message (a subtype outside step 1,
 *   a non-object, or no channel).
 * - `no-author`: neither `user` nor `bot_id`, so self-exclusion cannot tell
 *   who wrote it.
 * - `own`: written by P (its bot user or its bot ID).
 * - `dm-disabled`: a direct message to P while P's DMs switch (`dm.enabled`)
 *   is off.
 * - `group-dm`: a group DM; never delivered to any persona.
 * - `channel-not-configured`: P does not list the channel (declarative mode).
 * - `not-mentioned`: a channel P hears at `mentions` (its `delivery` entry in
 *   declarative mode, its channel delivery in fungible mode) without P's
 *   mention or a broadcast.
 *
 * A fungible-mode event that does not take the fungible path is dropped with
 * `FungibleDropReason` instead.
 */
export type DeliveryDropReason =
  | 'non-message'
  | 'no-author'
  | 'own'
  | 'dm-disabled'
  | 'group-dm'
  | 'channel-not-configured'
  | 'not-mentioned'

/**
 * The drop reason of a fungible-mode event that did not take the fungible
 * path; the outcome carries which condition failed.
 */
export type FungibleDropReason = 'fungible-refused'

/** One of `FUNGIBLE_REFUSALS`: the first fungible-path condition an event failed. */
export type FungibleRefusal = (typeof FUNGIBLE_REFUSALS)[number]

/** A channel on the fungible path: `public` (`channel_type` `channel`) or `private` (`group`). */
export type FungibleChannelType = 'public' | 'private'

/**
 * What an outcome says about an event that took the fungible path: the channel type and P's channel delivery after the loop guard.
 */
export interface FungiblePath {
  /** `public` for `channel_type` `channel`, `private` for `group`. */
  channelType: FungibleChannelType
  /** P's channel delivery for the channel. */
  channelDelivery: DeliveryMode
}

/** The deliver outcome. */
export interface DeliverDecision {
  action: 'deliver'
  /** How the message reached P. */
  via: Via
  /** Present only when the event took the fungible path. */
  fungible?: FungiblePath
}

/** A drop outcome. */
export type DropDecision =
  | {
      action: 'drop'
      reason: Exclude<DeliveryDropReason, 'channel-not-configured'>
      /** Present only when the event took the fungible path (a `not-mentioned` drop). */
      fungible?: FungiblePath
    }
  | {
      action: 'drop'
      reason: 'channel-not-configured'
      /** True when no applied persona lists the channel (an `unclaimed-channel` line is due). */
      unclaimed: boolean
    }
  | {
      action: 'drop'
      reason: FungibleDropReason
      /** The first fungible-path condition the event failed. */
      refusal: FungibleRefusal
    }

/** Outcome of `decideDelivery` for one receiving persona. */
export type DeliveryDecision = DeliverDecision | DropDecision

/**
 * The stored choices as the decision reads them:
 * whether the store was readable at start, and P's stored choice for a
 * channel. The stored-choice store (`src/channel-delivery.ts`) satisfies it.
 */
export interface StoredChoices {
  /** Whether the store was readable at start; when false no stored choice applies. */
  readonly readable: boolean
  /** The stored choice of persona `key` for `channel`, or undefined when there is none. */
  storedChoice(key: string, channel: string): DeliveryMode | undefined
}

/** One applied persona's fungible destination: `dm` or a channel ID. */
export interface PersonaFungibleDestination {
  key: string
  /** The persona's destination in fungible mode, as the one destination rule resolves it. */
  destination: string
}

/** What a channel delivery is computed from, besides the persona and the channel. */
export interface ChannelDeliveryInputs {
  /**
   * Every applied persona's fungible destination, P's included, from the
   * configuration in effect. In fungible mode this is the list of applied
   * personas the decision reads.
   */
  fungibleDestinations: readonly PersonaFungibleDestination[]
  /** The stored choices. Absent: no stored choice applies. */
  storedChoices?: StoredChoices
}

/**
 * The fungible-mode inputs of `decideDelivery`, each read at
 * the call. Absent, or with `mode` `declarative`, the decision is declarative
 * mode's.
 */
export interface FungibleDecisionInputs extends ChannelDeliveryInputs {
  /** The channel mode of the configuration in effect. */
  mode: ChannelMode
  /**
   * The envelope flag (`is_ext_shared_channel`) exactly as received: `true`,
   * `false`, any other value, or undefined when absent.
   */
  isExtSharedChannel?: unknown
  /** The channel-ID pattern a fungible-path channel matches (`CHANNEL_ID_RE`). */
  channelIdPattern: RegExp
}

/** P's channel delivery for one channel, from `channelDeliveryFor`. */
export interface ChannelDeliveryResult {
  /** `mentions` or `all`. */
  delivery: DeliveryMode
  /**
   * True when the loop guard applies: the channel is another applied
   * persona's fungible destination, so the delivery is `mentions` whatever P
   * stored.
   */
  heldByLoopGuard: boolean
}

/** The receiving persona P as `decideDelivery` sees it. */
export interface DeliveryPersona {
  /** P's persona key; excludes P itself from the `receive_all_shared` check. */
  key: string
  /** P's bot user ID. Empty or absent never matches an author or a mention. */
  botUserId: string | undefined
  /** P's bot ID. Empty or absent never matches an author. */
  botId: string | undefined
  /** P's channel entries; read in declarative mode only. */
  channels: readonly ChannelEntry[]
  /** P's DMs switch (`dm.enabled`). */
  dmEnabled: boolean
}

/** One applied persona as `decideDelivery` sees it (P included); its channel entries are read in declarative mode only. */
export interface AppliedPersonaView {
  key: string
  channels: readonly ChannelEntry[]
}

/**
 * The receiving persona P as `decideReaction` sees it, from the
 * configuration in effect and P's confirmed identity at the event. Its
 * `botUserId` is P's confirmed bot user ID: empty or absent never matches a
 * reacted message's author, so no reaction is accepted. Its channel entries
 * are read in declarative mode only.
 */
export type ReactionDecisionPersona = Pick<DeliveryPersona, 'key' | 'botUserId' | 'channels' | 'dmEnabled'>

/** Where a reaction `decideReaction` decides came from: a Slack event on P's own connection. */
export type ReactionDecisionOrigin = 'slack-event'

/**
 * The inputs of `decideReaction` besides the event and P, each read at the
 * call. The envelope flag and the channel-ID pattern are read in fungible
 * mode only.
 */
export interface ReactionDecisionInputs extends Pick<FungibleDecisionInputs, 'mode' | 'isExtSharedChannel' | 'channelIdPattern'> {
  /** Where the event came from; carried into the accept outcome. */
  origin: ReactionDecisionOrigin
  /**
   * Whether `id` is one of the Run Bot Identities: the bot user IDs confirmed
   * for any persona during this server run, removed personas included.
   * Synchronous, with no side effect.
   */
  isRunBotIdentity(id: string): boolean
}

/** Who reacted: the event's `user` when it has one, else its `bot_id`; exactly one is present. */
export type ReactionReactor = { user: string; bot_id?: never } | { user?: never; bot_id: string }

/**
 * The accept outcome: the reaction's facts exactly as received. `channel` is
 * the conversation, `message_ts` the reacted message's ts (`item.ts`), `ts`
 * the event's `event_ts`, `emoji` the `reaction` name, `change` whether it
 * was added or removed, and `mode` and `origin` the inputs it was decided
 * under.
 */
export type ReactionAcceptDecision = {
  action: 'accept'
  channel: string
  message_ts: string
  ts: string
  change: 'added' | 'removed'
  emoji: string
  mode: ChannelMode
  origin: ReactionDecisionOrigin
} & ReactionReactor

/**
 * Why a reaction is not accepted for P:
 * - `not-a-message-reaction`: not a reaction added to or removed from a
 *   message, or a field the reaction needs is missing or empty.
 * - `not-own-message`: the reacted message is not P's, or P has no confirmed
 *   bot user ID.
 * - `no-reactor`: neither `user` nor `bot_id`.
 * - `own-reaction`: P's own reaction.
 * - `bot-reaction`: a reaction by one of the Run Bot Identities.
 * - `dm-disabled`: in a DM while P's DMs switch (`dm.enabled`) is off.
 * - `unserved-conversation`: in a conversation P does not list (declarative
 *   mode).
 * - `fungible-refused`: the conversation fails a fungible-path condition
 *   (fungible mode); the outcome carries which.
 */
export type ReactionDropReason =
  | 'not-a-message-reaction'
  | 'not-own-message'
  | 'no-reactor'
  | 'own-reaction'
  | 'bot-reaction'
  | 'dm-disabled'
  | 'unserved-conversation'
  | FungibleDropReason

/**
 * A fungible-path condition a reaction can fail at its decision. Reaction
 * events carry no `channel_type`, so `not-a-channel` is never one.
 */
export type ReactionFungibleRefusal = Exclude<FungibleRefusal, 'not-a-channel'>

/** A drop outcome of `decideReaction`; only `fungible-refused` carries a refusal. */
export type ReactionDropDecision =
  | {
      action: 'drop'
      reason: Exclude<ReactionDropReason, FungibleDropReason>
      refusal?: never
    }
  | {
      action: 'drop'
      reason: FungibleDropReason
      /** The first fungible-path condition the conversation failed. */
      refusal: ReactionFungibleRefusal
    }

/** Outcome of `decideReaction` for one receiving persona. */
export type ReactionDecision = ReactionAcceptDecision | ReactionDropDecision

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Decide whether the receiving persona P gets `event`, and how (see the
 * module comment for the step order). `applied` is every applied persona
 * (P's entry included), from the applied configuration, never live
 * connection state. `fungible` holds the fungible-mode inputs; absent, or
 * with its mode `declarative`, the decision is declarative mode's.
 */
export function decideDelivery(
  event: unknown,
  persona: DeliveryPersona,
  applied: readonly AppliedPersonaView[],
  fungible?: FungibleDecisionInputs,
): DeliveryDecision {
  if (typeof event !== 'object' || event === null) return { action: 'drop', reason: 'non-message' }
  const ev = event as Record<string, unknown>
  const subtype = ev['subtype']
  if (subtype && !(typeof subtype === 'string' && DELIVERABLE_SUBTYPES.has(subtype))) {
    return { action: 'drop', reason: 'non-message' }
  }
  const channel = ev['channel']
  if (typeof channel !== 'string' || channel === '') return { action: 'drop', reason: 'non-message' }

  const user = nonEmptyString(ev['user'])
  const botId = nonEmptyString(ev['bot_id'])
  if (user === undefined && botId === undefined) return { action: 'drop', reason: 'no-author' }
  if (isOwn(user, botId, persona)) return { action: 'drop', reason: 'own' }

  switch (conversationKind(ev['channel_type'], channel)) {
    case 'dm':
      return persona.dmEnabled ? { action: 'deliver', via: 'dm' } : { action: 'drop', reason: 'dm-disabled' }
    case 'group-dm':
      return { action: 'drop', reason: 'group-dm' }
    case 'channel':
      break
  }

  if (fungible !== undefined && fungible.mode === FUNGIBLE_MODE) {
    return decideFungibleChannel(ev, channel, persona, fungible)
  }

  const entry = persona.channels.find((c) => c.id === channel)
  if (!entry) {
    const claimed = applied.some((p) => p.channels.some((c) => c.id === channel))
    return { action: 'drop', reason: 'channel-not-configured', unclaimed: !claimed }
  }

  const text = ev['text']
  if (mentionsPersona(text, persona.botUserId)) return { action: 'deliver', via: 'mention' }
  if (hasBroadcast(text)) return { action: 'deliver', via: 'broadcast' }
  if (entry.delivery !== 'all') return { action: 'drop', reason: 'not-mentioned' }
  const shared = applied.some((p) =>
    p.key !== persona.key && p.channels.some((c) => c.id === channel && c.delivery === 'all'))
  return { action: 'deliver', via: shared ? 'receive_all_shared' : 'receive_all' }
}

/**
 * Fungible mode's channel steps for an
 * event that passed steps 1 to 3: the fungible path's conditions, then P's
 * channel delivery and `via`. No persona's channel entries are read.
 */
function decideFungibleChannel(
  ev: Record<string, unknown>,
  channel: string,
  persona: DeliveryPersona,
  inputs: FungibleDecisionInputs,
): DeliveryDecision {
  const channelType = ev['channel_type']
  const refusal = fungibleRefusalOf(channelType, channel, inputs)
  if (refusal !== undefined) return { action: 'drop', reason: 'fungible-refused', refusal }

  const path: FungiblePath = {
    channelType: channelType === PUBLIC_CHANNEL_TYPE ? 'public' : 'private',
    channelDelivery: channelDeliveryFor(persona.key, channel, inputs).delivery,
  }
  const text = ev['text']
  if (mentionsPersona(text, persona.botUserId)) return { action: 'deliver', via: 'mention', fungible: path }
  if (hasBroadcast(text)) return { action: 'deliver', via: 'broadcast', fungible: path }
  if (path.channelDelivery !== DELIVERY_ALL) return { action: 'drop', reason: 'not-mentioned', fungible: path }
  const shared = inputs.fungibleDestinations.some((other) =>
    other.key !== persona.key && channelDeliveryFor(other.key, channel, inputs).delivery === DELIVERY_ALL)
  return { action: 'deliver', via: shared ? 'receive_all_shared' : 'receive_all', fungible: path }
}

/**
 * The first fungible-path condition a message event fails, in
 * `FUNGIBLE_REFUSALS`' order, or undefined when it takes the path: its
 * `channel_type` is `channel` or `group`; then the channel-ID and
 * envelope-flag conditions `decideReaction` shares.
 */
function fungibleRefusalOf(
  channelType: unknown,
  channel: string,
  inputs: FungibleDecisionInputs,
): FungibleRefusal | undefined {
  if (channelType !== PUBLIC_CHANNEL_TYPE && channelType !== PRIVATE_CHANNEL_TYPE) return 'not-a-channel'
  return channelIdRefusalOf(channel, inputs.channelIdPattern) ?? envelopeFlagRefusalOf(inputs.isExtSharedChannel)
}

/** The fungible path's channel-ID condition: `channel` matches the channel-ID pattern. */
function channelIdRefusalOf(channel: string, channelIdPattern: RegExp): 'channel-id-malformed' | undefined {
  return channelIdPattern.test(channel) ? undefined : 'channel-id-malformed'
}

/**
 * The fungible path's envelope-flag conditions, in `FUNGIBLE_REFUSALS`'
 * order: the flag (`is_ext_shared_channel`, exactly as received) is
 * present, is a boolean, and is `false`. Kept apart from the channel-ID
 * condition because an event that has no envelope still needs that one.
 */
function envelopeFlagRefusalOf(flag: unknown): Exclude<ReactionFungibleRefusal, 'channel-id-malformed'> | undefined {
  if (flag === undefined) return 'flag-missing'
  if (typeof flag !== 'boolean') return 'flag-not-boolean'
  if (flag) return 'externally-shared'
  return undefined
}

/**
 * Persona `key`'s channel delivery for `channel` in fungible mode, and whether the loop guard held it:
 *
 * - `mentions`, held, when `channel` is the fungible destination of any
 *   applied persona other than `key` (the loop guard). The persona's own
 *   destination is never held, since its own posts are dropped before the
 *   channel steps, and a `dm` destination holds nothing;
 * - otherwise the persona's stored choice for `channel`, when the store is
 *   readable;
 * - otherwise `mentions`.
 *
 * Whether any persona lists `channel` in its channel entries plays no part.
 * The one copy of the rule: `decideDelivery` uses it for P and for every
 * other persona, and `set_channel_delivery` for its result. Pure.
 */
export function channelDeliveryFor(
  key: string,
  channel: string,
  inputs: ChannelDeliveryInputs,
): ChannelDeliveryResult {
  const held = inputs.fungibleDestinations.some((other) =>
    other.key !== key && other.destination !== DM_DESTINATION_VALUE && other.destination === channel)
  if (held) return { delivery: DELIVERY_MENTIONS, heldByLoopGuard: true }
  const store = inputs.storedChoices
  const stored = store !== undefined && store.readable ? store.storedChoice(key, channel) : undefined
  return { delivery: stored === DELIVERY_ALL ? DELIVERY_ALL : DELIVERY_MENTIONS, heldByLoopGuard: false }
}

/** step 2: the author is P's bot user, or the event carries P's bot ID. */
function isOwn(user: string | undefined, botId: string | undefined, persona: DeliveryPersona): boolean {
  const ownUser = nonEmptyString(persona.botUserId)
  const ownBot = nonEmptyString(persona.botId)
  return (ownUser !== undefined && user === ownUser) || (ownBot !== undefined && botId === ownBot)
}

/**
 * what kind of conversation `channel` is. `channel_type` decides when
 * the event has one. An event without it (such as an `app_mention`, which
 * Slack does not send for DMs) is treated, defensively, as a DM when its
 * conversation ID starts with `D`, and as a channel otherwise.
 */
function conversationKind(channelType: unknown, channel: string): 'dm' | 'group-dm' | 'channel' {
  if (channelType === DM_CHANNEL_TYPE) return 'dm'
  if (channelType === GROUP_DM_CHANNEL_TYPE) return 'group-dm'
  if (channelType === undefined && channel.startsWith(DM_CONVERSATION_PREFIX)) return 'dm'
  return 'channel'
}

/** The value when it is a non-empty string; otherwise undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

// ---------------------------------------------------------------------------
// Reaction decision
// ---------------------------------------------------------------------------

/** A reaction event that passed the shape rule: its record and the fields the accept outcome carries. */
interface MessageReaction {
  event: Record<string, unknown>
  change: ReactionAcceptDecision['change']
  channel: string
  messageTs: string
  emoji: string
  eventTs: string
}

/**
 * Decide whether the receiving persona P accepts the reaction `event` (see
 * the module comment for the rule order). `persona` and `inputs` come from
 * the configuration in effect and P's confirmed identity at this event;
 * nothing is kept between calls.
 */
export function decideReaction(
  event: unknown,
  persona: ReactionDecisionPersona,
  inputs: ReactionDecisionInputs,
): ReactionDecision {
  const reaction = messageReactionOf(event)
  if (reaction === undefined) return { action: 'drop', reason: 'not-a-message-reaction' }

  const ownUser = nonEmptyString(persona.botUserId)
  if (ownUser === undefined || reaction.event['item_user'] !== ownUser) return { action: 'drop', reason: 'not-own-message' }

  const reactor = reactorOf(reaction.event)
  if (reactor === undefined) return { action: 'drop', reason: 'no-reactor' }
  if (reactor.id === ownUser) return { action: 'drop', reason: 'own-reaction' }
  if (inputs.isRunBotIdentity(reactor.id)) return { action: 'drop', reason: 'bot-reaction' }

  // Every reactor rule comes before every conversation rule, so a Bot's
  // reaction is `bot-reaction` in any conversation, served or not.
  const conversationDrop = reactionConversationDropOf(reaction.channel, persona, inputs)
  if (conversationDrop !== undefined) return conversationDrop

  return {
    action: 'accept',
    channel: reaction.channel,
    message_ts: reaction.messageTs,
    ts: reaction.eventTs,
    change: reaction.change,
    emoji: reaction.emoji,
    mode: inputs.mode,
    origin: inputs.origin,
    ...reactor.fields,
  }
}

/**
 * The shape rule: `event` is a `reaction_added` or `reaction_removed` event
 * on a message, with non-empty string `item.channel`, `item.ts`, `reaction`
 * and `event_ts`, each kept exactly as received; otherwise undefined.
 */
function messageReactionOf(event: unknown): MessageReaction | undefined {
  if (!isRecord(event)) return undefined
  const change = reactionChangeOf(event['type'])
  const item = event['item']
  if (change === undefined || !isRecord(item) || item['type'] !== MESSAGE_ITEM_TYPE) return undefined
  const channel = nonEmptyString(item['channel'])
  const messageTs = nonEmptyString(item['ts'])
  const emoji = nonEmptyString(event['reaction'])
  const eventTs = nonEmptyString(event['event_ts'])
  if (channel === undefined || messageTs === undefined || emoji === undefined || eventTs === undefined) return undefined
  return { event, change, channel, messageTs, emoji, eventTs }
}

/** The change a reaction event type makes, or undefined for any other type. */
function reactionChangeOf(type: unknown): ReactionAcceptDecision['change'] | undefined {
  if (type === REACTION_ADDED_EVENT) return 'added'
  if (type === REACTION_REMOVED_EVENT) return 'removed'
  return undefined
}

/** The reactor's ID and its accept fields: a non-empty `user` first, else a non-empty `bot_id`; undefined with neither. */
function reactorOf(ev: Record<string, unknown>): { id: string; fields: ReactionReactor } | undefined {
  const user = nonEmptyString(ev['user'])
  if (user !== undefined) return { id: user, fields: { user } }
  const botId = nonEmptyString(ev['bot_id'])
  return botId === undefined ? undefined : { id: botId, fields: { bot_id: botId } }
}

/**
 * The conversation rule: undefined when P serves `channel` now, else its drop.
 * A DM depends on P's DMs switch alone in both modes; declarative mode reads
 * only P's channel entries, fungible mode only the channel-ID pattern and the
 * envelope flag.
 */
function reactionConversationDropOf(
  channel: string,
  persona: ReactionDecisionPersona,
  inputs: ReactionDecisionInputs,
): ReactionDropDecision | undefined {
  if (channel.startsWith(DM_CONVERSATION_PREFIX)) {
    return persona.dmEnabled ? undefined : { action: 'drop', reason: 'dm-disabled' }
  }
  if (inputs.mode === FUNGIBLE_MODE) {
    const refusal = channelIdRefusalOf(channel, inputs.channelIdPattern) ?? envelopeFlagRefusalOf(inputs.isExtSharedChannel)
    return refusal === undefined ? undefined : { action: 'drop', reason: 'fungible-refused', refusal }
  }
  return persona.channels.some((entry) => entry.id === channel) ? undefined : { action: 'drop', reason: 'unserved-conversation' }
}

/** True when `value` is a non-null object, so its fields can be read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// ---------------------------------------------------------------------------
// Mention and broadcast recognisers
// ---------------------------------------------------------------------------

/** P's user mention token (`<@P>` or `<@P|label>`); undefined for an empty or unknown ID. */
function personaMentionPattern(botUserId: string | undefined): RegExp | undefined {
  const id = nonEmptyString(botUserId)
  if (id === undefined) return undefined
  return new RegExp(`<@${escapeRegExp(id)}(?:\\|[^>]*)?>`)
}

/** True when `text` contains P's user mention; never for an empty or unknown ID. */
function mentionsPersona(text: unknown, botUserId: string | undefined): boolean {
  if (typeof text !== 'string') return false
  return personaMentionPattern(botUserId)?.test(text) ?? false
}

/** True when `text` contains `<!here>` or `<!channel>`, with or without a label. */
function hasBroadcast(text: unknown): boolean {
  return typeof text === 'string' && BROADCAST_PATTERN.test(text)
}

/** Escape `value` for literal use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
