/**
 * Reaction Item preparation: the three bounded lookups on the receiving
 * persona's own client and the fix-or-withdraw decision (SR-5.2 to SR-5.5).
 *
 * The decision reads the channel mode stored with the item, never the mode in
 * effect now (guide exception E1). Only normalized facts leave the lookups:
 * no message body, blocks, files, raw response or raw error. Nothing is
 * cached, so every decision makes its own fresh reads, and a late or failed
 * lookup leaves nothing behind.
 *
 * Import-safe: no I/O at load, no module state. No queue writes, rendering,
 * wake or logging; the caller owns those.
 */
import type { WebClient } from '@slack/web-api'
import type { ChannelMode } from './config.ts'
import type { ReactionAcceptedRecord, ReactionFungibleCondition, ReactionWithdrawalReason } from './delivery-queue.ts'
import { slackPlatformReason } from './persona-connection-errors.ts'
import { isServerPost } from './server-post.ts'

export type ReactionPreparationDecision =
  | { kind: 'fixed'; user: string; channel_name: string; thread_ts?: string; messageUnknown: boolean }
  | { kind: 'withdrawn'; reason: ReactionWithdrawalReason; failed_condition?: ReactionFungibleCondition }

/** The two Slack refusals of lookup 2 that can refuse a fungible item. */
export type ReactionMessageRefusal = 'not_in_channel' | 'channel_not_found'

/** Lookup 2: the returned message whose ts is the reacted ts, a membership refusal, or unknown (failed, timed out, or no such message). */
export type ReactionMessageFacts =
  | { state: 'found'; serverPost: boolean; thread_ts?: string }
  | { state: 'refused'; code: ReactionMessageRefusal }
  | { state: 'unknown' }

export type ReactionConversationKind = 'public-channel' | 'private-channel' | 'group-dm' | 'other'

/** Lookup 3: a DM (no call), the conversation's kind and sharing, or unknown (failed, timed out or malformed). `channel_name` is always the name to type. */
export type ReactionConversationFacts =
  | { state: 'dm'; channel_name: 'dm' }
  | { state: 'known'; channel_name: string; kind: ReactionConversationKind; externallyShared: boolean }
  | { state: 'unknown'; channel_name: string }

export interface ReactionPreparationFacts {
  /** Lookup 1: the reactor's name. */
  user: string
  message: ReactionMessageFacts
  conversation: ReactionConversationFacts
}

export interface ReactionLookupClock {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ReactionLookupDeps {
  /** The receiving persona's own client; undefined makes lookups 2 and 3 fail at once. */
  clientFor(key: string): WebClient | undefined
  resolveUserName(key: string, user: string): Promise<string>
  clock: ReactionLookupClock
  /** Each lookup's own bound; callers default it to NAME_LOOKUP_TIMEOUT_MS. */
  lookupTimeoutMs: number
}

/**
 * The pure decision (SR-5.4, SR-5.5). The first applying reason of
 * `server-post`, `conversation-unknown`, `group-dm` and `fungible-refused`
 * wins. Otherwise the notice is fixed; an unknown message (L1) fixes it
 * without `thread_ts`, and a declarative item whose conversation lookup
 * failed is kept (L7).
 */
export function decideReactionPreparation(mode: ChannelMode, facts: ReactionPreparationFacts): ReactionPreparationDecision {
  const { message, conversation } = facts
  if (message.state === 'found' && message.serverPost) return { kind: 'withdrawn', reason: 'server-post' }
  if (mode === 'fungible' && conversation.state === 'unknown') return { kind: 'withdrawn', reason: 'conversation-unknown' }
  if (conversation.state === 'known' && conversation.kind === 'group-dm') return { kind: 'withdrawn', reason: 'group-dm' }
  if (mode === 'fungible') {
    const failed: ReactionFungibleCondition | undefined =
      conversation.state === 'known' && conversation.kind === 'other' ? 'not-a-channel'
      : conversation.state === 'known' && conversation.externallyShared ? 'externally-shared'
      : message.state === 'refused' ? message.code
      : undefined
    if (failed) return { kind: 'withdrawn', reason: 'fungible-refused', failed_condition: failed }
  }
  if (message.state === 'found') {
    return message.thread_ts === undefined
      ? { kind: 'fixed', user: facts.user, channel_name: conversation.channel_name, messageUnknown: false }
      : { kind: 'fixed', user: facts.user, channel_name: conversation.channel_name, thread_ts: message.thread_ts, messageUnknown: false }
  }
  return { kind: 'fixed', user: facts.user, channel_name: conversation.channel_name, messageUnknown: true }
}

/** The fallback when `work` rejects or outlasts the bound; a late result is ignored. */
function bounded<T>(deps: ReactionLookupDeps, work: () => Promise<T>, fallback: () => T): Promise<T> {
  return new Promise<T>(resolve => {
    let done = false
    let timer: unknown
    const finish = (value: () => T) => {
      if (done) return
      done = true
      if (timer !== undefined) deps.clock.clearTimeout(timer)
      resolve(value())
    }
    timer = deps.clock.setTimeout(() => finish(fallback), deps.lookupTimeoutMs)
    Promise.resolve().then(work).then(value => finish(() => value), () => finish(fallback))
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Lookup 1 (SR-5.2): the reactor's name. A `bot-tool` item's is the persona
 * name stored with it at hand-off, with no lookup: neither the persona
 * configuration in effect nor Slack is read, so a later rename or removal
 * does not relabel it.
 */
export function resolveReactionReactorName(key: string, accepted: ReactionAcceptedRecord, deps: ReactionLookupDeps): Promise<string> {
  // The queue admits a `bot-tool` record only with a non-empty persona name.
  if (accepted.origin === 'bot-tool') return Promise.resolve(accepted.reactor_persona_name!)
  const user = accepted.user
  if (user) return bounded(deps, () => deps.resolveUserName(key, user).then(name => name || user), () => user)
  return Promise.resolve(accepted.bot_id || 'unknown')
}

/** Lookup 2 (SR-5.2): only the exact-ts message counts; `thread_ts` comes only from it. */
async function readReactedMessage(client: WebClient, accepted: ReactionAcceptedRecord): Promise<ReactionMessageFacts> {
  const ts = accepted.message_ts
  try {
    const response: unknown = await client.conversations.replies({ channel: accepted.channel, ts, oldest: ts, latest: ts, inclusive: true, include_all_metadata: true })
    const messages = isRecord(response) ? response.messages : undefined
    const message = Array.isArray(messages) ? messages.find(m => isRecord(m) && m.ts === ts) as Record<string, unknown> | undefined : undefined
    if (!message) return { state: 'unknown' }
    const thread = message.thread_ts
    return typeof thread === 'string' && thread !== ''
      ? { state: 'found', serverPost: isServerPost(message), thread_ts: thread }
      : { state: 'found', serverPost: isServerPost(message) }
  } catch (error) {
    const code = slackPlatformReason(error)
    return code === 'not_in_channel' || code === 'channel_not_found' ? { state: 'refused', code } : { state: 'unknown' }
  }
}

/** Lookup 3 (SR-5.2): one `conversations.info`; never `is_member` or any membership read. */
async function readConversation(client: WebClient, channel: string): Promise<ReactionConversationFacts> {
  const response: unknown = await client.conversations.info({ channel })
  const c = isRecord(response) ? response.channel : undefined
  if (!isRecord(c)) return { state: 'unknown', channel_name: channel }
  const name = typeof c.name === 'string' ? c.name.replace(/^#/, '') : ''
  // A group DM can also report is_group/is_private, so it is checked first.
  const kind: ReactionConversationKind = c.is_mpim === true ? 'group-dm'
    : c.is_channel === true || c.is_group === true ? (c.is_private === true || c.is_group === true ? 'private-channel' : 'public-channel')
    : 'other'
  return { state: 'known', channel_name: name || channel, kind, externallyShared: c.is_ext_shared === true }
}

/** A throwing client lookup is a failed lookup, like a missing client. */
function clientOf(key: string, deps: ReactionLookupDeps): WebClient | undefined {
  try { return deps.clientFor(key) } catch { return undefined }
}

/**
 * The three lookups of SR-5.2, started together and each bounded by
 * `lookupTimeoutMs`, then the decision. Never rejects.
 */
export async function lookupReactionPreparation(key: string, accepted: ReactionAcceptedRecord, deps: ReactionLookupDeps): Promise<ReactionPreparationDecision> {
  const client = clientOf(key, deps)
  const channel = accepted.channel
  const unknownMessage = (): ReactionMessageFacts => ({ state: 'unknown' })
  const unknownConversation = (): ReactionConversationFacts => ({ state: 'unknown', channel_name: channel })
  const [user, message, conversation] = await Promise.all([
    resolveReactionReactorName(key, accepted, deps),
    client ? bounded(deps, () => readReactedMessage(client, accepted), unknownMessage) : Promise.resolve(unknownMessage()),
    channel.startsWith('D') ? Promise.resolve<ReactionConversationFacts>({ state: 'dm', channel_name: 'dm' })
      : client ? bounded(deps, () => readConversation(client, channel), unknownConversation)
      : Promise.resolve(unknownConversation()),
  ])
  return decideReactionPreparation(accepted.mode, { user, message, conversation })
}
