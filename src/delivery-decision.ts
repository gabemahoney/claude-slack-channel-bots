/**
 * delivery-decision.ts — The one place inbound delivery is decided, in both
 * channel modes (b.av2 SR-4.2 channel rules with b.deo SRI-303 to SRI-308,
 * SR-4.3 direct messages, SR-4.4 `via` with b.deo SRI-306).
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
 * no outcome carries a key beyond declarative mode's (b.deo SRI-308).
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
 * 3. Conversation kind (SR-4.3). A DM (`channel_type` `im`, or, as a
 *    defensive fallback for an event with no `channel_type`, a conversation ID
 *    starting with `D`) depends only on P's DMs switch: on,
 *    it delivers with `via` `dm`, whatever the text mentions; off, it is
 *    `dm-disabled`. A group DM (`channel_type` `mpim`) is `group-dm`, never
 *    delivered. Neither reaches the channel steps below.
 *
 * Declarative mode (b.av2 SR-4.2; b.deo SRI-308):
 *
 * 4. A channel P is not configured into is `channel-not-configured`, with
 *    `unclaimed` set when no applied persona lists it.
 * 5. `delivery: all` delivers.
 * 6. `delivery: mentions` delivers when the text holds P's user mention
 *    (`<@P>` or `<@P|label>`) or a broadcast (`<!here>` / `<!channel>`, with or
 *    without a label); otherwise `not-mentioned`. `<!everyone>` and user-group
 *    mentions (`<!subteam^…>`) are not mentions.
 *
 * Fungible mode (b.av2 SR-4.2 with b.deo SRI-303 to SRI-306). No persona's
 * channel entries are read, P's or any other's.
 *
 * 4. The fungible path (SRI-303): the event takes it only when all of these
 *    hold, checked in this order, `FUNGIBLE_REFUSALS`' order: its
 *    `channel_type` is `channel` or `group`; its channel ID matches the
 *    channel-ID pattern; the envelope flag is present; it is a boolean; it is
 *    `false`. The first that fails is a `fungible-refused` drop carrying that
 *    refusal. The flag alone decides whether a channel is externally shared.
 * 5. P's channel delivery for the channel (SRI-305, `channelDeliveryFor`):
 *    `mentions` when the channel is another applied persona's fungible
 *    destination (the loop guard), else P's stored choice when the store is
 *    readable, else `mentions`.
 * 6. `via` in the shipped order (SRI-306): P's mention is `mention`; else a
 *    broadcast is `broadcast`; else a channel delivery of `all` delivers, as
 *    `receive_all_shared` when at least one other applied persona's channel
 *    delivery for the channel is `all` and as `receive_all` otherwise; else
 *    `not-mentioned`. Mention and broadcast recognition are declarative
 *    mode's.
 *
 * Every outcome of an event that took the fungible path, deliver or drop,
 * carries `fungible`: the channel type (`public` for `channel`, `private` for
 * `group`) and P's channel delivery, so the routing logs its audit line and
 * its drop lines without deciding anything (b.deo SRI-309).
 *
 * An empty or unknown bot user ID or bot ID never matches an author or a
 * mention (b.av2 SR-3.1).
 *
 * Pure and stateless (b.av2 SR-13.1, b.deo SRI-309): imports types only,
 * creates no client, reads no file or environment variable, logs nothing, and
 * keeps no counter, rate limit, per-sender memory or cross-persona
 * arbitration. The mode, the stored choices and the destinations arrive as
 * inputs at each call.
 *
 * SPDX-License-Identifier: MIT
 */

import type { ChannelEntry, ChannelMode, DeliveryMode, DM_DESTINATION } from './config.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subtypes delivered like a plain message (SR-4.2 step 1). */
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

/** The channel mode in which the fungible path applies (b.deo SRI-101). */
const FUNGIBLE_MODE: ChannelMode = 'fungible'

/** The channel delivery that hears every message. */
const DELIVERY_ALL: DeliveryMode = 'all'

/** The channel delivery that hears mentions and broadcasts only, and the default. */
const DELIVERY_MENTIONS: DeliveryMode = 'mentions'

/**
 * The destination value that sends by DM (`DM_DESTINATION` in
 * `src/config.ts`, held to it by its type). A DM destination is no channel,
 * so the loop guard never holds anything for it.
 */
const DM_DESTINATION_VALUE: typeof DM_DESTINATION = 'dm'

/**
 * Why an event that passed steps 1 to 3 does not take the fungible path
 * (b.deo SRI-303), in the order the conditions are checked: its `channel_type`
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
 * How a delivered message reached the persona (b.av2 SR-4.4, b.deo SRI-306),
 * first match wins: `dm` (a direct message to P), `mention` (P's user
 * mention), `broadcast` (`<!here>` / `<!channel>`), `receive_all_shared`
 * (`all` for P and at least one other applied persona: their `delivery`
 * entries in declarative mode, their channel deliveries in fungible mode),
 * `receive_all`.
 */
export type Via = 'dm' | 'mention' | 'broadcast' | 'receive_all_shared' | 'receive_all'

/**
 * Why a persona does not get a message:
 * - `non-message`: not a deliverable message (a subtype outside SR-4.2 step 1,
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
 * path (b.deo SRI-303); the outcome carries which condition failed.
 */
export type FungibleDropReason = 'fungible-refused'

/** One of `FUNGIBLE_REFUSALS`: the first fungible-path condition an event failed (b.deo SRI-303). */
export type FungibleRefusal = (typeof FUNGIBLE_REFUSALS)[number]

/** A channel on the fungible path: `public` (`channel_type` `channel`) or `private` (`group`). */
export type FungibleChannelType = 'public' | 'private'

/**
 * What an outcome says about an event that took the fungible path (b.deo
 * SRI-309): the channel type and P's channel delivery after the loop guard.
 */
export interface FungiblePath {
  /** `public` for `channel_type` `channel`, `private` for `group`. */
  channelType: FungibleChannelType
  /** P's channel delivery for the channel (b.deo SRI-305). */
  channelDelivery: DeliveryMode
}

/** The deliver outcome. */
export interface DeliverDecision {
  action: 'deliver'
  /** How the message reached P. */
  via: Via
  /** Present only when the event took the fungible path (b.deo SRI-309). */
  fungible?: FungiblePath
}

/** A drop outcome. */
export type DropDecision =
  | {
      action: 'drop'
      reason: Exclude<DeliveryDropReason, 'channel-not-configured'>
      /** Present only when the event took the fungible path (a `not-mentioned` drop; b.deo SRI-309). */
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
      /** The first fungible-path condition the event failed (b.deo SRI-303). */
      refusal: FungibleRefusal
    }

/** Outcome of `decideDelivery` for one receiving persona. */
export type DeliveryDecision = DeliverDecision | DropDecision

/**
 * The stored choices as the decision reads them (b.deo SRI-305, SRI-403):
 * whether the store was readable at start, and P's stored choice for a
 * channel. The stored-choice store (`src/channel-delivery.ts`) satisfies it.
 */
export interface StoredChoices {
  /** Whether the store was readable at start; when false no stored choice applies. */
  readonly readable: boolean
  /** The stored choice of persona `key` for `channel`, or undefined when there is none. */
  storedChoice(key: string, channel: string): DeliveryMode | undefined
}

/** One applied persona's fungible destination (b.deo SRI-305): `dm` or a channel ID. */
export interface PersonaFungibleDestination {
  key: string
  /** The persona's destination in fungible mode, as the one destination rule resolves it. */
  destination: string
}

/** What a channel delivery is computed from (b.deo SRI-305), besides the persona and the channel. */
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
 * The fungible-mode inputs of `decideDelivery` (b.deo SRI-309), each read at
 * the call. Absent, or with `mode` `declarative`, the decision is declarative
 * mode's.
 */
export interface FungibleDecisionInputs extends ChannelDeliveryInputs {
  /** The channel mode of the configuration in effect. */
  mode: ChannelMode
  /**
   * The envelope flag (`is_ext_shared_channel`) exactly as received: `true`,
   * `false`, any other value, or undefined when absent (b.deo SRI-301).
   */
  isExtSharedChannel?: unknown
  /** The channel-ID pattern a fungible-path channel matches (`CHANNEL_ID_RE`). */
  channelIdPattern: RegExp
}

/** P's channel delivery for one channel (b.deo SRI-305), from `channelDeliveryFor`. */
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

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Decide whether the receiving persona P gets `event`, and how (see the
 * module comment for the step order). `applied` is every applied persona
 * (P's entry included), from the applied configuration, never live
 * connection state. `fungible` holds the fungible-mode inputs; absent, or
 * with its mode `declarative`, the decision is declarative mode's (b.deo
 * SRI-308, SRI-309).
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
 * Fungible mode's channel steps (b.deo SRI-303, SRI-305, SRI-306) for an
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
 * The first fungible-path condition (b.deo SRI-303) the event fails, in
 * `FUNGIBLE_REFUSALS`' order, or undefined when it takes the path: its
 * `channel_type` is `channel` or `group`; `channel` matches the channel-ID
 * pattern; the envelope flag is present, is a boolean, and is `false`.
 */
function fungibleRefusalOf(
  channelType: unknown,
  channel: string,
  inputs: FungibleDecisionInputs,
): FungibleRefusal | undefined {
  if (channelType !== PUBLIC_CHANNEL_TYPE && channelType !== PRIVATE_CHANNEL_TYPE) return 'not-a-channel'
  if (!inputs.channelIdPattern.test(channel)) return 'channel-id-malformed'
  const flag = inputs.isExtSharedChannel
  if (flag === undefined) return 'flag-missing'
  if (typeof flag !== 'boolean') return 'flag-not-boolean'
  if (flag) return 'externally-shared'
  return undefined
}

/**
 * Persona `key`'s channel delivery for `channel` in fungible mode (b.deo
 * SRI-305), and whether the loop guard held it:
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

/** SR-4.2 step 2: the author is P's bot user, or the event carries P's bot ID. */
function isOwn(user: string | undefined, botId: string | undefined, persona: DeliveryPersona): boolean {
  const ownUser = nonEmptyString(persona.botUserId)
  const ownBot = nonEmptyString(persona.botId)
  return (ownUser !== undefined && user === ownUser) || (ownBot !== undefined && botId === ownBot)
}

/**
 * SR-4.3: what kind of conversation `channel` is. `channel_type` decides when
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
// Mention and broadcast recognisers
// ---------------------------------------------------------------------------

/** P's user mention token (`<@P>` or `<@P|label>`); undefined for an empty or unknown ID. */
function personaMentionPattern(botUserId: string | undefined, flags?: string): RegExp | undefined {
  const id = nonEmptyString(botUserId)
  if (id === undefined) return undefined
  return new RegExp(`<@${escapeRegExp(id)}(?:\\|[^>]*)?>`, flags)
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

/**
 * Remove every P's own mention token (`<@P>` and `<@P|label>`) and the
 * whitespace after it from `text`, then trim. Other personas' mentions and
 * broadcasts stay. An empty or unknown ID leaves the text unchanged.
 */
export function stripPersonaMention(text: string, botUserId: string | undefined): string {
  const pattern = personaMentionPattern(botUserId, 'g')
  if (!pattern) return text
  return text.split(pattern).map((part, i) => (i === 0 ? part : part.trimStart())).join('').trim()
}

/** Escape `value` for literal use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
