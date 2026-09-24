/**
 * delivery-decision.ts — The one place inbound delivery is decided (b.av2
 * SR-4.2 channel rules, SR-4.3 direct messages, SR-4.4 `via`).
 *
 * `decideDelivery` takes a raw Slack `message` / `app_mention` event, the
 * receiving persona P (key, bot user ID, bot ID, channel entries, DMs switch)
 * and a read-only view of every applied persona's key and channel entries,
 * and returns either deliver (with how the message reached P, `via`) or drop
 * (with a machine-readable reason). Steps, in order:
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
 * 4. A channel P is not configured into is `channel-not-configured`, with
 *    `unclaimed` set when no applied persona lists it.
 * 5. `delivery: all` delivers.
 * 6. `delivery: mentions` delivers when the text holds P's user mention
 *    (`<@P>` or `<@P|label>`) or a broadcast (`<!here>` / `<!channel>`, with or
 *    without a label); otherwise `not-mentioned`. `<!everyone>` and user-group
 *    mentions (`<!subteam^…>`) are not mentions.
 *
 * An empty or unknown bot user ID or bot ID never matches an author or a
 * mention (b.av2 SR-3.1).
 *
 * Pure and stateless (b.av2 SR-13.1): imports types only, creates no client,
 * reads no file or environment variable, logs nothing, and keeps no counter,
 * rate limit, per-sender memory or cross-persona arbitration.
 *
 * SPDX-License-Identifier: MIT
 */

import type { ChannelEntry } from './config.ts'

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How a delivered message reached the persona (b.av2 SR-4.4), first match
 * wins: `dm` (a direct message to P), `mention` (P's user mention),
 * `broadcast` (`<!here>` / `<!channel>`), `receive_all_shared` (`delivery:
 * all` for P and at least one other applied persona), `receive_all`.
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
 * - `channel-not-configured`: P does not list the channel.
 * - `not-mentioned`: a `delivery: mentions` channel without P's mention or a
 *   broadcast.
 */
export type DeliveryDropReason =
  | 'non-message'
  | 'no-author'
  | 'own'
  | 'dm-disabled'
  | 'group-dm'
  | 'channel-not-configured'
  | 'not-mentioned'

/** The deliver outcome. */
export interface DeliverDecision {
  action: 'deliver'
  /** How the message reached P. */
  via: Via
}

/** A drop outcome. */
export type DropDecision =
  | { action: 'drop'; reason: Exclude<DeliveryDropReason, 'channel-not-configured'> }
  | {
      action: 'drop'
      reason: 'channel-not-configured'
      /** True when no applied persona lists the channel (an `unclaimed-channel` line is due). */
      unclaimed: boolean
    }

/** Outcome of `decideDelivery` for one receiving persona. */
export type DeliveryDecision = DeliverDecision | DropDecision

/** The receiving persona P as `decideDelivery` sees it. */
export interface DeliveryPersona {
  /** P's persona key; excludes P itself from the `receive_all_shared` check. */
  key: string
  /** P's bot user ID. Empty or absent never matches an author or a mention. */
  botUserId: string | undefined
  /** P's bot ID. Empty or absent never matches an author. */
  botId: string | undefined
  /** P's channel entries. */
  channels: readonly ChannelEntry[]
  /** P's DMs switch (`dm.enabled`). */
  dmEnabled: boolean
}

/** One applied persona as `decideDelivery` sees it (P included). */
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
 * connection state.
 */
export function decideDelivery(
  event: unknown,
  persona: DeliveryPersona,
  applied: readonly AppliedPersonaView[],
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
