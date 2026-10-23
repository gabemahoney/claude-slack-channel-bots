/** Pure selection over the applied shared choices and current
 * authenticated membership. An unresolved decision withholds acknowledgement;
 * it is distinct from an established exclusion. DMs and message/author filters
 * precede channel authority. Participation is an explicitly supplied fact.
 * SPDX-License-Identifier: MIT
 */
import type { ChannelEntry, ChannelMode, DeliveryMode, DM_DESTINATION } from './config.ts'
import type { MembershipReading } from './channel-membership.ts'
import type { ThreadParticipationReading } from './thread-participation.ts'

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
const FUNGIBLE_MODE: ChannelMode = 'open'

/** The channel delivery that hears every message. */
const DELIVERY_ALL: DeliveryMode = 'all'

/** The channel delivery that hears mentions and broadcasts only. */
const DELIVERY_MENTIONS: DeliveryMode = 'mentions'

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
export type Via = 'dm' | 'mention' | 'broadcast' | 'receive_all_shared' | 'receive_all' | 'thread'

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
  | 'channel-off'
  | 'channel-ineligible'

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
export type DeliveryDecision = DeliverDecision | DropDecision | {
  action: 'unresolved'
  reason: 'state-unavailable' | 'membership-unresolved' | 'choice-missing' | 'participation-unresolved'
}

/**
 * The stored choices as the decision reads them:
 * whether the store was readable at start, and P's stored choice for a
 * channel. The stored-choice store (`src/channel-delivery.ts`) satisfies it.
 */
export interface StoredChoices {
  /** A still-trustworthy projection while another channel's write is unresolved. */
  readableFor?(key: string, channel?: string): boolean
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
  /** The shared choice projection. Absence leaves selection unresolved. */
  storedChoices?: StoredChoices
}

/**
 * Applied inputs of `decideDelivery`, read in both modes at each call.
 * The historical type name is retained for existing callers. Missing inputs
 * cannot authorize channel selection.
 */
export interface FungibleDecisionInputs extends ChannelDeliveryInputs {
  /** Only the identified reply thread, scoped to its receiving persona/channel. */
  participation?: ReadonlyMap<string, ThreadParticipationReading>
  /** Current, synchronous observations for this event's channel, by persona.
   * Missing evidence is unresolved; configured entries are never membership. */
  memberships?: ReadonlyMap<string, MembershipReading>
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
  /** Absent when no trustworthy saved choice exists; never a default off. */
  delivery: DeliveryMode | undefined
  /**
   * True when the loop guard applies: the channel is another applied
   * persona's fungible destination, so a non-off choice becomes `mentions`.
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
  /** Retained caller shape; entries alone supply neither choice nor membership. */
  channels: readonly ChannelEntry[]
  /** P's DMs switch (`dm.enabled`). */
  dmEnabled: boolean
}

/** One applied persona (P included). Selection reads the shared projection. */
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
      if (fungible?.storedChoices && !(fungible.storedChoices.readableFor?.(persona.key, channel) ?? fungible.storedChoices.readable)) {
        return { action: 'unresolved', reason: 'state-unavailable' }
      }
      return persona.dmEnabled ? { action: 'deliver', via: 'dm' } : { action: 'drop', reason: 'dm-disabled' }
    case 'group-dm':
      return { action: 'drop', reason: 'group-dm' }
    case 'channel':
      break
  }

  if (fungible?.mode === FUNGIBLE_MODE) return decideFungibleChannel(ev, channel, persona, fungible)
  const availability = channelAvailability(persona.key, channel, fungible)
  if (availability) return availability
  const saved = fungible?.storedChoices?.storedChoice(persona.key, channel)
  if (saved === undefined) return { action: 'unresolved', reason: 'choice-missing' }
  if (saved === 'off') return { action: 'drop', reason: 'channel-off' }
  const text = ev['text']
  if (mentionsPersona(text, persona.botUserId)) return { action: 'deliver', via: 'mention' }
  if (hasBroadcast(text)) return { action: 'deliver', via: 'broadcast' }
  if (saved === 'thread_hybrid') return decideThread(ev, channel, persona.key, fungible)
  if (saved !== 'all') return { action: 'drop', reason: 'not-mentioned' }
  const shared = applied.some((p) =>
    p.key !== persona.key && !channelAvailability(p.key, channel, fungible) &&
      fungible?.storedChoices?.storedChoice(p.key, channel) === 'all')
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

  const availability = channelAvailability(persona.key, channel, inputs)
  if (availability) return availability
  const effective = channelDeliveryFor(persona.key, channel, inputs)
  if (effective.delivery === undefined) return { action: 'unresolved', reason: 'choice-missing' }
  const path: FungiblePath = {
    channelType: channelType === PUBLIC_CHANNEL_TYPE ? 'public' : 'private',
    channelDelivery: effective.delivery,
  }
  if (path.channelDelivery === 'off') return { action: 'drop', reason: 'channel-off', fungible: path }
  const text = ev['text']
  if (mentionsPersona(text, persona.botUserId)) return { action: 'deliver', via: 'mention', fungible: path }
  if (hasBroadcast(text)) return { action: 'deliver', via: 'broadcast', fungible: path }
  if (path.channelDelivery === 'thread_hybrid') return decideThread(ev, channel, persona.key, inputs, path)
  if (path.channelDelivery !== DELIVERY_ALL) return { action: 'drop', reason: 'not-mentioned', fungible: path }
  const shared = inputs.fungibleDestinations.some((other) =>
    other.key !== persona.key && !channelAvailability(other.key, channel, inputs) &&
      channelDeliveryFor(other.key, channel, inputs).delivery === DELIVERY_ALL)
  return { action: 'deliver', via: shared ? 'receive_all_shared' : 'receive_all', fungible: path }
}

/** Whether a persona's configured channel entries name `channel`. Pure. */
export function personaListsChannel(persona: { channels: readonly ChannelEntry[] } | undefined, channel: string): boolean {
  return persona?.channels.some(entry => entry.id === channel) === true
}

/** No malformed thread identifier can be replaced with an invented root. */
export function isThreadTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d{6}$/.test(value)
}
export function replyThreadRoot(event: Record<string, unknown>): string | undefined {
  return isThreadTimestamp(event['thread_ts']) && event['thread_ts'] !== event['ts'] ? event['thread_ts'] : undefined
}
/** Uses the selector's direct-mention result, including all eligibility and
 * author filters. Broadcasts, DMs and unaccepted/off events have no enrollment. */
export function incomingEnrollmentRoot(event: Record<string, unknown>, decision: DeliveryDecision): string | undefined {
  if (decision.action !== 'deliver' || decision.via !== 'mention') return undefined
  if (event['thread_ts'] !== undefined) return isThreadTimestamp(event['thread_ts']) ? event['thread_ts'] : undefined
  return isThreadTimestamp(event['ts']) ? event['ts'] : undefined
}
function decideThread(event: Record<string, unknown>, channel: string, key: string,
  inputs?: FungibleDecisionInputs, fungible?: FungiblePath): DeliveryDecision {
  const root = replyThreadRoot(event)
  const drop: DeliveryDecision = { action: 'drop', reason: 'not-mentioned', ...(fungible ? { fungible } : {}) }
  if (!root) return drop
  const reading = inputs?.participation?.get(key)
  if (!reading || reading.key !== key || reading.channel !== channel || reading.root !== root || reading.kind === 'unresolved') {
    return { action: 'unresolved', reason: 'participation-unresolved' }
  }
  return reading.kind === 'followed' ? { action: 'deliver', via: 'thread', ...(fungible ? { fungible } : {}) } : drop
}

/** Only dependent channel selection consults shared health and membership.
 * Shape, own-author and DM exclusions above remain independent. */
function channelAvailability(key: string, channel: string, inputs?: FungibleDecisionInputs): DeliveryDecision | undefined {
  const store = inputs?.storedChoices
  if (!(store?.readableFor?.(key, channel) ?? store?.readable)) return { action: 'unresolved', reason: 'state-unavailable' }
  const membership = inputs?.memberships?.get(key)
  if (!membership || membership.kind === 'unresolved') return { action: 'unresolved', reason: 'membership-unresolved' }
  if (membership.kind === 'ineligible') return { action: 'drop', reason: 'channel-ineligible' }
  return undefined
}

/**
 * The first fungible-path condition the event fails, in
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
 * Persona `key`'s channel delivery for `channel` in fungible mode, and whether the loop guard held it:
 *
 * - `off` remains off, before any destination guard;
 * - a non-off choice becomes `mentions`, held, when `channel` is the destination of any
 *   applied persona other than `key` (the loop guard). The persona's own
 *   destination is never held, since its own posts are dropped before the
 *   channel steps, and a `dm` destination holds nothing;
 * - otherwise the persona's stored choice for `channel`, when the store is
 *   readable;
 * - otherwise unresolved (`delivery` is undefined).
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
  const store = inputs.storedChoices
  const stored = store !== undefined && (store.readableFor?.(key, channel) ?? store.readable) ? store.storedChoice(key, channel) : undefined
  if (stored === undefined) return { delivery: undefined, heldByLoopGuard: false }
  if (stored === 'off') return { delivery: 'off', heldByLoopGuard: false }
  if (held) return { delivery: DELIVERY_MENTIONS, heldByLoopGuard: true }
  return { delivery: stored, heldByLoopGuard: false }
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
