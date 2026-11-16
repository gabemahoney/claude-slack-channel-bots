/** Pure selection over the applied shared choices, Thread Memory view, Pending
 * Own Posts and current authenticated membership. An unresolved decision
 * withholds acknowledgement; it is distinct from an established exclusion. DMs
 * and message/author filters precede channel authority. A `thread_hybrid`
 * channel selects @mentions, Broadcasts and replies in threads the persona is
 * in, from Thread Memory. A reply not known to be in one is held for the
 * persona's Pending Own Posts that could put it there (a Post Hold), else held
 * while Thread Memory is unknown (a Memory Hold).
 *
 * `decideReaction` is a separate decision, made before any network call or
 * store, for one raw `reaction_added` / `reaction_removed` event. It takes
 * the receiving persona P (key, confirmed bot user ID, channel entries, DMs
 * switch, `reaction_notices` switch) and `ReactionDecisionInputs` (the channel mode, the envelope flag,
 * the channel-ID pattern, where the event came from, and whether an ID is one
 * of the Run Bot Identities: the bot user IDs confirmed for any persona
 * during this server run). The event comes from `slack-event`, a Slack event
 * on P's own connection, or `bot-tool`, a reaction another persona's Bot made
 * with its `react` tool, which has no envelope. It returns accept (with the
 * reaction's facts and its reactor, a `user` or a `bot_id`) or drop (with a
 * machine-readable reason). The first rule the event fails drops it:
 *
 * 1. Reaction shape: the event is `reaction_added` (change `added`) or
 *    `reaction_removed` (change `removed`), its `item.type` is `message`,
 *    and `item.channel`, `item.ts`, `reaction` and `event_ts` are non-empty
 *    strings; otherwise `not-a-message-reaction`.
 * 2. Ownership: `item_user` is P's confirmed bot user ID; otherwise, or when
 *    P has none, `not-own-message`.
 * 3. Reactor: the event's `user`, or its `bot_id` when it has no `user`;
 *    with neither, `no-reactor`. A reactor that is P's bot user ID is
 *    `own-reaction`; one of the Run Bot Identities is `bot-reaction`, for a
 *    `slack-event` only, since a `bot-tool` reactor is one by design.
 * 4. Reaction notices: P's `reaction_notices` switch is on; otherwise
 *    `notices-off`, for either origin. Only this rule reads the switch, so an
 *    item accepted while it was on is prepared and delivered whatever it
 *    becomes later.
 * 5. Conversation: one P serves now. A conversation ID starting with `D` is a
 *    DM, accepted when P's DMs switch is on and `dm-disabled` otherwise. In
 *    strict mode any other conversation must be one of P's channel entries,
 *    else `unserved-conversation`; the envelope flag and the channel-ID
 *    pattern play no part. In open mode no persona's
 *    channel entries are read: the conversation ID must match the channel-ID
 *    pattern and, for a `slack-event`, the envelope flag must be present, a
 *    boolean and `false`, else `open-refused` with the refusal of the
 *    first that fails. In both modes P then serves the channel only with a
 *    readable stored choice other than `off` and verified (`eligible`)
 *    membership, else `unserved-conversation`; a real group DM never has
 *    verified membership, the channel inventory holding no group DM.
 *    Reaction events carry no `channel_type`, so the conversation kind and
 *    the open path's channel-type condition are checked again by the
 *    reaction's preparation after acceptance, and so is a `bot-tool`
 *    event's external sharing.
 *
 * Which choice other than `off` P stored and Thread Memory play no part in a
 * reaction's decision. Both decisions check the open path's
 * channel-ID and envelope-flag conditions with the same helpers, in
 * `FUNGIBLE_REFUSALS`' order. Both are pure: no I/O, logging or state kept
 * between calls.
 *
 * SPDX-License-Identifier: MIT
 */
import type { ChannelEntry, ChannelMode, DeliveryMode } from './config.ts'
import type { MembershipReading } from './channel-membership.ts'
import type { ReactionKey } from './delivery-queue.ts'
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

/** The channel mode in which the open path applies. */
const FUNGIBLE_MODE: ChannelMode = 'open'

/** The channel delivery that hears every message. */
const DELIVERY_ALL: DeliveryMode = 'all'

/** The event type of a reaction added to an item (change `added`). */
export const REACTION_ADDED_EVENT = 'reaction_added'

/** The event type of a reaction removed from an item (change `removed`). */
export const REACTION_REMOVED_EVENT = 'reaction_removed'

/** The `item.type` of a reaction on a message. */
const MESSAGE_ITEM_TYPE = 'message'

/** The origin of a reaction another persona's Bot made with its `react` tool. */
const BOT_TOOL_ORIGIN: ReactionDecisionOrigin = 'bot-tool'

/**
 * Why an event that passed steps 1 to 3 does not take the open path
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
 * - `channel-not-configured`: P does not list the channel (strict mode).
 * - `not-mentioned`: a channel P hears at `mentions` under its shared saved
 *   choice, in either mode, without P's mention or a broadcast.
 *
 * An open-mode event that does not take the open path is dropped with
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
 * The drop reason of an open-mode event that did not take the open
 * path; the outcome carries which condition failed.
 */
export type FungibleDropReason = 'open-refused'

/** One of `FUNGIBLE_REFUSALS`: the first open-path condition an event failed. */
export type FungibleRefusal = (typeof FUNGIBLE_REFUSALS)[number]

/** A channel on the open path: `public` (`channel_type` `channel`) or `private` (`group`). */
export type FungibleChannelType = 'public' | 'private'

/**
 * What an outcome says about an event that took the open path: the channel type and P's saved channel delivery, applied as written.
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
  /** Present only when the event took the open path. */
  fungible?: FungiblePath
}

/** A drop outcome. */
export type DropDecision =
  | {
      action: 'drop'
      reason: Exclude<DeliveryDropReason, 'channel-not-configured'>
      /** Present only when the event took the open path (a `not-mentioned` drop). */
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
      /** The first open-path condition the event failed. */
      refusal: FungibleRefusal
    }

/** A held reply: a Post Hold names every covering post, in the list's order;
 * `rootUnknown` is true when P's Thread Memory view of the root was unknown. */
export type HoldDecision = {
  action: 'hold'; hold: 'memory'; via: 'thread'; threadRoot: string; fungible?: FungiblePath
} | {
  action: 'hold'; hold: 'post'; via: 'thread'; threadRoot: string; operations: string[]; rootUnknown: boolean; fungible?: FungiblePath
}

/** One of P's Pending Own Posts as the decision reads it. `root` is the
 * requested parent's Thread Root, absent for a new channel message; `issuedAt`
 * is the wall-clock issue time in milliseconds. */
export interface PendingOwnPostView {
  operation: string
  root?: string
  issuedAt: number
}

/** P's Pending Own Posts and the clock skew their issue times are compared
 * with, supplied together so issue-time coverage can't be left out. */
export interface OwnPostsDecisionInput {
  /** Synchronous, read-only: P's posts in the channel under the current Channel Stamp. */
  pending(key: string, channel: string): readonly PendingOwnPostView[]
  /** `OWN_ROOT_CLOCK_SKEW_MS`. */
  clockSkewMs: number
}

/** Outcome of `decideDelivery` for one receiving persona. */
export type DeliveryDecision = DeliverDecision | DropDecision | HoldDecision | {
  action: 'unresolved'
  reason: 'state-unavailable' | 'membership-unresolved' | 'choice-missing' | 'thread-stamp-undecided'
}

/**
 * The shared authority's choices as the decision reads them in both modes:
 * current readability and P's saved choice for a channel. The adapter in
 * `src/channel-delivery.ts` supplies this projection, with no independent file
 * or fallback choices.
 */
export interface StoredChoices {
  /** A still-trustworthy projection while another channel's write is unresolved. */
  readableFor?(key: string, channel?: string): boolean
  /** Current shared-authority readability; when false selection is unresolved. */
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
  /** Read only for a reply not known to be joined. */
  ownPosts?: OwnPostsDecisionInput
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
  /** The channel-ID pattern an open-path channel matches (`CHANNEL_ID_RE`). */
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

/**
 * The receiving persona P as `decideReaction` sees it, from the
 * configuration in effect and P's confirmed identity at the event. Its
 * `botUserId` is P's confirmed bot user ID: empty or absent never matches a
 * reacted message's author, so no reaction is accepted. Its channel entries
 * are read in strict mode only. `reaction_notices` is P's resolved
 * `Persona.reaction_notices` in effect at the event; required, so no caller
 * can leave it to a default.
 */
export type ReactionDecisionPersona = Pick<DeliveryPersona, 'key' | 'botUserId' | 'channels' | 'dmEnabled'> & {
  /** P's `reaction_notices` switch; off drops every reaction with `notices-off` (rule 4). */
  reaction_notices: boolean
}

/**
 * Where a reaction `decideReaction` decides came from: `slack-event`, a
 * Slack event on P's own connection, or `bot-tool`, a reaction another
 * persona's Bot made with its `react` tool, handed to P's intake with no
 * envelope.
 */
export type ReactionDecisionOrigin = 'slack-event' | 'bot-tool'

/**
 * The inputs of `decideReaction` besides the event and P, each read at the
 * call. The channel-ID pattern is read in open mode only, and the
 * envelope flag only there for a `slack-event`. The stored choices and P's
 * membership are read for a channel in both modes; absent, P does not serve it.
 */
export interface ReactionDecisionInputs extends Pick<FungibleDecisionInputs, 'mode' | 'isExtSharedChannel' | 'channelIdPattern' | 'storedChoices' | 'memberships'> {
  /** Where the event came from; carried into the accept outcome. */
  origin: ReactionDecisionOrigin
  /**
   * Whether `id` is one of the Run Bot Identities: the bot user IDs confirmed
   * for any persona during this server run, removed personas included.
   * Synchronous, with no side effect. Not asked for a `bot-tool` event.
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
 * - `notices-off`: P's `reaction_notices` switch is off.
 * - `dm-disabled`: in a DM while P's DMs switch (`dm.enabled`) is off.
 * - `unserved-conversation`: in a channel P does not serve: not one of P's
 *   channel entries (strict mode), or stored `off`, with no readable stored
 *   choice or without verified membership (both modes).
 * - `open-refused`: the conversation fails an open-path condition
 *   (open mode); the outcome carries which.
 */
export type ReactionDropReason =
  | 'not-a-message-reaction'
  | 'not-own-message'
  | 'no-reactor'
  | 'own-reaction'
  | 'bot-reaction'
  | 'notices-off'
  | 'dm-disabled'
  | 'unserved-conversation'
  | FungibleDropReason

/**
 * An open-path condition a reaction can fail at its decision. Reaction
 * events carry no `channel_type`, so `not-a-channel` is never one.
 */
export type ReactionFungibleRefusal = Exclude<FungibleRefusal, 'not-a-channel'>

/** A drop outcome of `decideReaction`; only `open-refused` carries a refusal. */
export type ReactionDropDecision =
  | {
      action: 'drop'
      reason: Exclude<ReactionDropReason, FungibleDropReason>
      refusal?: never
    }
  | {
      action: 'drop'
      reason: FungibleDropReason
      /** The first open-path condition the conversation failed. */
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
 * connection state. `fungible` holds the shared choice and membership inputs
 * for both modes, with additional envelope checks in open mode. Absent inputs
 * cannot authorize channel delivery; only `mode: 'open'` selects the open path.
 */
export function decideDelivery(
  event: unknown,
  persona: DeliveryPersona,
  applied: readonly AppliedPersonaView[],
  fungible?: FungibleDecisionInputs,
): DeliveryDecision {
  if (!isRecord(event)) return { action: 'drop', reason: 'non-message' }
  const ev = event
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
  if (saved === 'thread_hybrid') return decideThreadReply(ev, persona, channel, fungible)
  if (saved !== 'all') return { action: 'drop', reason: 'not-mentioned' }
  const shared = applied.some((p) =>
    p.key !== persona.key && !channelAvailability(p.key, channel, fungible) &&
      fungible?.storedChoices?.storedChoice(p.key, channel) === 'all')
  return { action: 'deliver', via: shared ? 'receive_all_shared' : 'receive_all' }
}

/**
 * Open mode's channel steps for an event that passed steps 1 to 3: the
 * open-path conditions, then shared-authority readability, current membership,
 * P's saved delivery choice and `via`. No persona's configured entries are
 * used as membership evidence.
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
  if (refusal !== undefined) return { action: 'drop', reason: 'open-refused', refusal }

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
  if (path.channelDelivery === 'thread_hybrid') return decideThreadReply(ev, persona, channel, inputs, path)
  if (path.channelDelivery !== DELIVERY_ALL) return { action: 'drop', reason: 'not-mentioned', fungible: path }
  const shared = applied.some((other) =>
    other.key !== persona.key && !channelAvailability(other.key, channel, inputs) &&
      channelDeliveryFor(other.key, channel, inputs).delivery === DELIVERY_ALL)
  return { action: 'deliver', via: shared ? 'receive_all_shared' : 'receive_all', fungible: path }
}

/**
 * Only eligible thread_hybrid channels reach this branch, after mentions and
 * broadcasts. A joined thread's reply is delivered. Otherwise, after the view
 * lookup (which settles deferred own-post joins), a reply that a Pending Own
 * Post could put P in gets a Post Hold; an unknown root gets a Memory Hold.
 */
function decideThreadReply(
  ev: Record<string, unknown>, persona: Pick<DeliveryPersona, 'key' | 'botUserId'>, channel: string,
  inputs: FungibleDecisionInputs | undefined, path?: FungiblePath,
): DeliveryDecision {
  const key = persona.key
  const context = path ? { fungible: path } : {}
  const notMentioned: DropDecision = { action: 'drop', reason: 'not-mentioned', ...context }
  const root = replyThreadRoot(ev)
  if (root === undefined) return notMentioned
  if (inputs?.threadStampUndecided?.(key, channel) === true) return { action: 'unresolved', reason: 'thread-stamp-undecided' }
  if (!inputs?.threadMemory) return notMentioned
  const view = inputs.threadMemory(key, channel, root)
  if (view === 'joined') return { action: 'deliver', via: 'thread', ...context }
  if (inputs.ownPosts) {
    const operations = coveringPosts(inputs.ownPosts.pending(key, channel), root, ev['parent_user_id'], persona.botUserId, inputs.ownPosts.clockSkewMs)
    if (operations.length) {
      return { action: 'hold', hold: 'post', via: 'thread', threadRoot: root, operations, rootUnknown: view === 'unknown', ...context }
    }
  }
  if (view === 'unknown') return { action: 'hold', hold: 'memory', via: 'thread', threadRoot: root, ...context }
  return notMentioned
}

/**
 * The operation IDs, once each in list order, of the posts that could put P
 * in the reply's thread: one under the same Thread Root, or a pending new
 * channel message whose issue time less the clock skew is no later than the
 * Thread Root, when `parent_user_id` is P's bot user or absent (an empty or
 * non-string value counts as absent). Pure.
 */
function coveringPosts(
  posts: readonly PendingOwnPostView[], root: string, parentUserId: unknown, botUserId: string | undefined,
  skewMs: number,
): string[] {
  const parent = nonEmptyString(parentUserId)
  const ownThread = parent === undefined || parent === nonEmptyString(botUserId)
  const rootMicros = timestampMicros(root)
  const operations: string[] = []
  for (const post of posts) {
    const covers = post.root !== undefined
      ? post.root === root
      // Exact: a bigint compared with a number compares their values; a
      // non-finite issue time covers nothing.
      : ownThread && Number.isFinite(post.issuedAt) && rootMicros >= (post.issuedAt - skewMs) * 1000
    if (covers && !operations.includes(post.operation)) operations.push(post.operation)
  }
  return operations
}

/** A Slack timestamp as whole microseconds; `ts` is a valid thread timestamp. */
function timestampMicros(ts: string): bigint {
  const [seconds, fraction] = ts.split('.') as [string, string]
  return BigInt(seconds) * 1_000_000n + BigInt(fraction)
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
 * The first open-path condition a message event fails, in
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

/** The open path's channel-ID condition: `channel` matches the channel-ID pattern. */
function channelIdRefusalOf(channel: string, channelIdPattern: RegExp): 'channel-id-malformed' | undefined {
  return channelIdPattern.test(channel) ? undefined : 'channel-id-malformed'
}

/**
 * The open path's envelope-flag conditions, in `FUNGIBLE_REFUSALS`'
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
// Reaction decision
// ---------------------------------------------------------------------------

/**
 * Shape facts shared by decisions, retained-key lookup and storage. A missing
 * reactor leaves the shape valid: ownership must be checked before no-reactor.
 */
export interface ParsedReactionShape {
  change: ReactionAcceptDecision['change']
  channel: string
  messageTs: string
  emoji: string
  eventTs: string
  itemUser?: string
  reactor?: { id: string; fields: ReactionReactor }
  reactionKey?: ReactionKey
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
  const reaction = parseReactionShape(event)
  if (reaction === undefined) return { action: 'drop', reason: 'not-a-message-reaction' }

  const ownUser = nonEmptyString(persona.botUserId)
  if (ownUser === undefined || reaction.itemUser !== ownUser) return { action: 'drop', reason: 'not-own-message' }

  const reactor = reaction.reactor
  if (reactor === undefined) return { action: 'drop', reason: 'no-reactor' }
  if (reactor.id === ownUser) return { action: 'drop', reason: 'own-reaction' }
  if (inputs.origin !== BOT_TOOL_ORIGIN && inputs.isRunBotIdentity(reactor.id)) return { action: 'drop', reason: 'bot-reaction' }

  // Every reactor rule comes before the notices rule, and the notices rule
  // before every conversation rule, so a Bot's reaction is `bot-reaction`
  // whatever the switch, and with the switch off every other reaction is
  // `notices-off` in any conversation, served or not.
  if (!persona.reaction_notices) return { action: 'drop', reason: 'notices-off' }

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
export function parseReactionShape(event: unknown): ParsedReactionShape | undefined {
  if (!isRecord(event)) return undefined
  const change = reactionChangeOf(event['type'])
  const item = event['item']
  if (change === undefined || !isRecord(item) || item['type'] !== MESSAGE_ITEM_TYPE) return undefined
  const channel = nonEmptyString(item['channel'])
  const messageTs = nonEmptyString(item['ts'])
  const emoji = nonEmptyString(event['reaction'])
  const eventTs = nonEmptyString(event['event_ts'])
  if (channel === undefined || messageTs === undefined || emoji === undefined || eventTs === undefined) return undefined
  const reactor = reactorOf(event)
  return {
    change, channel, messageTs, emoji, eventTs,
    itemUser: nonEmptyString(event['item_user']),
    reactor,
    reactionKey: reactor === undefined ? undefined : { chat_id: channel, message_ts: messageTs, reactor: reactor.id, emoji, change, event_ts: eventTs },
  }
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
 * A DM depends on P's DMs switch alone in both modes; strict mode reads
 * P's channel entries, open mode the channel-ID pattern and, for a
 * `slack-event`, the envelope flag; then both read P's stored choice and
 * membership.
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
    const refusal = channelIdRefusalOf(channel, inputs.channelIdPattern)
      ?? (inputs.origin === BOT_TOOL_ORIGIN ? undefined : envelopeFlagRefusalOf(inputs.isExtSharedChannel))
    if (refusal !== undefined) return { action: 'drop', reason: 'open-refused', refusal }
  } else if (!persona.channels.some((entry) => entry.id === channel)) {
    return { action: 'drop', reason: 'unserved-conversation' }
  }
  return reactionChannelServed(persona.key, channel, inputs) ? undefined : { action: 'drop', reason: 'unserved-conversation' }
}

/** P serves `channel`: a readable stored choice other than `off` and verified membership. */
function reactionChannelServed(key: string, channel: string, inputs: ReactionDecisionInputs): boolean {
  const delivery = channelDeliveryFor(key, channel, inputs).delivery
  return delivery !== undefined && delivery !== 'off' && inputs.memberships?.get(key)?.kind === 'eligible'
}

// ---------------------------------------------------------------------------
// Shared record guard
// ---------------------------------------------------------------------------

/** Defined here to keep decisions runtime-import-free; record.ts re-exports it for other consumers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
