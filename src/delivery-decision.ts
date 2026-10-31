/** Pure selection over the applied shared choices, Thread Memory view and current
 * authenticated membership. An unresolved decision withholds acknowledgement;
 * it is distinct from an established exclusion. DMs and message/author filters
 * precede channel authority. A `thread_hybrid` channel selects @mentions,
 * Broadcasts and replies in threads the persona is in, from Thread Memory.
 * SPDX-License-Identifier: MIT
 */
import type { ChannelEntry, ChannelMode, DeliveryMode } from './config.ts'
import type { MembershipReading } from './channel-membership.ts'
import type { ThreadMemoryView } from './thread-memory.ts'

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
 * mention), `broadcast` (`<!here>` / `<!channel>`), `thread` (a reply in a
 * thread the persona is in, from its Thread Memory view), `receive_all_shared`
 * (`all` for P and at least one other applied, available persona: their saved
 * choices apply as written in both modes),
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
 * What an outcome says about an event that took the fungible path: the channel type and P's saved channel delivery, applied as written.
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
  action: 'hold'; hold: 'memory'; via: 'thread'; threadRoot: string; fungible?: FungiblePath
} | {
  action: 'unresolved'
  reason: 'state-unavailable' | 'membership-unresolved' | 'choice-missing' | 'thread-stamp-undecided'
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

/** What a channel delivery is computed from, besides the persona and the channel. */
export interface ChannelDeliveryInputs {
  /** The shared choice projection. Absence leaves selection unresolved. */
  storedChoices?: StoredChoices
}

/**
 * Applied inputs of `decideDelivery`, read in both modes at each call.
 * The historical type name is retained for existing callers. Missing inputs
 * cannot authorize channel selection.
 */
export interface FungibleDecisionInputs extends ChannelDeliveryInputs {
  /** Synchronous, read-only Thread Memory lookup, used only for dependent replies. */
  threadMemory?(key: string, channel: string, threadRoot: string): ThreadMemoryView
  /** Shared-state restoration may hold a stamp while choices remain readable. */
  threadStampUndecided?(key: string, channel: string): boolean
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

  if (fungible?.mode === FUNGIBLE_MODE) return decideFungibleChannel(ev, channel, persona, applied, fungible)
  const availability = channelAvailability(persona.key, channel, fungible)
  if (availability) return availability
  const saved = fungible?.storedChoices?.storedChoice(persona.key, channel)
  if (saved === undefined) return { action: 'unresolved', reason: 'choice-missing' }
  if (saved === 'off') return { action: 'drop', reason: 'channel-off' }
  const text = ev['text']
  if (mentionsPersona(text, persona.botUserId)) return { action: 'deliver', via: 'mention' }
  if (hasBroadcast(text)) return { action: 'deliver', via: 'broadcast' }
  if (saved === 'thread_hybrid') return decideThreadReply(ev, persona.key, channel, fungible)
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
  applied: readonly AppliedPersonaView[],
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
  if (path.channelDelivery === 'thread_hybrid') return decideThreadReply(ev, persona.key, channel, inputs, path)
  if (path.channelDelivery !== DELIVERY_ALL) return { action: 'drop', reason: 'not-mentioned', fungible: path }
  const shared = applied.some((other) =>
    other.key !== persona.key && !channelAvailability(other.key, channel, inputs) &&
      channelDeliveryFor(other.key, channel, inputs).delivery === DELIVERY_ALL)
  return { action: 'deliver', via: shared ? 'receive_all_shared' : 'receive_all', fungible: path }
}

/** Only eligible thread_hybrid channels reach this branch, after mentions and broadcasts. */
function decideThreadReply(
  ev: Record<string, unknown>, key: string, channel: string,
  inputs: FungibleDecisionInputs | undefined, path?: FungiblePath,
): DeliveryDecision {
  const context = path ? { fungible: path } : {}
  const notMentioned: DropDecision = { action: 'drop', reason: 'not-mentioned', ...context }
  const root = replyThreadRoot(ev)
  if (root === undefined) return notMentioned
  if (inputs?.threadStampUndecided?.(key, channel) === true) return { action: 'unresolved', reason: 'thread-stamp-undecided' }
  if (!inputs?.threadMemory) return notMentioned
  const view = inputs.threadMemory(key, channel, root)
  if (view === 'unknown') return { action: 'hold', hold: 'memory', via: 'thread', threadRoot: root, ...context }
  return view === 'joined' ? { action: 'deliver', via: 'thread', ...context } : notMentioned
}

/** A root message's own timestamp never makes that message a thread reply. */
function replyThreadRoot(ev: Record<string, unknown>): string | undefined {
  return isThreadTimestamp(ev['thread_ts']) && ev['thread_ts'] !== ev['ts'] ? ev['thread_ts'] : undefined
}

/** Whether a persona's configured channel entries name `channel`. Pure. */
export function personaListsChannel(persona: { channels: readonly ChannelEntry[] } | undefined, channel: string): boolean {
  return persona?.channels.some(entry => entry.id === channel) === true
}

/** No malformed thread identifier can be replaced with an invented root. */
export function isThreadTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d{6}$/.test(value)
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

/** The saved choice applies as written when the store is readable.
 * Missing or unreadable choices remain unresolved. Pure. */
export function channelDeliveryFor(
  key: string,
  channel: string,
  inputs: ChannelDeliveryInputs,
): ChannelDeliveryResult {
  const store = inputs.storedChoices
  const stored = store !== undefined && (store.readableFor?.(key, channel) ?? store.readable) ? store.storedChoice(key, channel) : undefined
  return { delivery: stored }
}

/** step 2: the author is P's bot user, or the event carries P's bot ID. */
export function isOwn(user: string | undefined, botId: string | undefined, persona: Pick<DeliveryPersona, 'botUserId' | 'botId'>): boolean {
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
