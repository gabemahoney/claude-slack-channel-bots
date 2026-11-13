/**
 * Content-free server-log lines for reaction intake (SR-10.1).
 *
 * `reaction-received` reports a newly stored Reaction Item: the receiving
 * persona, the conversation, the reacted message's ts, the change, the emoji,
 * the reactor's ID and the item's sequence. `reaction-dropped` reports a drop
 * for one of the logged reasons only; the other drop reasons log nothing, and
 * the input types cannot name them. The intake failure lines
 * name the receiving persona and carry the caller's safe description of the
 * thrown value (`describeSlackCallFailure`), never the value itself. No line
 * carries message text, a display name other than the receiving persona's
 * configured name, the raw event, a Slack response or an error. Pure builders:
 * no I/O.
 */
import type { ReactionFungibleRefusal } from './delivery-decision.ts'
import type { ReactionAcceptedRecord } from './delivery-queue.ts'
import { escapeCause } from './persona-diagnostics.ts'
import { quoteReactionLogField as quote, reactionLogWord as word, renderReactionPersonaRef } from './reaction-log-fields.ts'

export const REACTION_RECEIVED = 'reaction-received'
export const REACTION_DROPPED = 'reaction-dropped'

/** The receiving persona: its key, and its configured name when known. */
export interface ReactionIntakePersona {
  key: string
  name?: string
}

/** The drop reasons that log a `reaction-dropped` line, in decision order. */
export const REACTION_LOGGED_DROP_REASONS = ['no-reactor', 'notices-off', 'dm-disabled', 'unserved-conversation', 'fungible-refused'] as const
export type ReactionLoggedDropReason = typeof REACTION_LOGGED_DROP_REASONS[number]

/** A logged drop: the conversation and reacted message when known, and the refusal only for `fungible-refused`. */
export type ReactionDroppedInput =
  | { reason: Exclude<ReactionLoggedDropReason, 'fungible-refused'>; chat_id?: string; message_ts?: string; refusal?: never }
  | { reason: 'fungible-refused'; chat_id?: string; message_ts?: string; refusal: ReactionFungibleRefusal }

/** `[slack] reaction-received: persona=<ref> chat_id="…" message_ts="…" change=<added|removed> emoji="…" <user|bot_id>="…" seq=<n>` */
export function buildReactionReceivedLine(p: ReactionIntakePersona, record: ReactionAcceptedRecord): string {
  const reactor = record.user !== undefined && record.user !== '' ? `user=${quote(record.user)}` : `bot_id=${quote(record.bot_id ?? '')}`
  return `[slack] ${REACTION_RECEIVED}: persona=${renderReactionPersonaRef(p)} chat_id=${quote(record.channel)} message_ts=${quote(record.message_ts)} change=${word(record.change)} emoji=${quote(record.emoji)} ${reactor} seq=${word(String(record.seq))}`
}

/** `[slack] reaction-dropped: persona=<ref>[ chat_id="…"][ message_ts="…"] reason=<reason>[ refusal=<refusal>]` */
export function buildReactionDroppedLine(p: ReactionIntakePersona, drop: ReactionDroppedInput): string {
  const chat = drop.chat_id !== undefined ? ` chat_id=${quote(drop.chat_id)}` : ''
  const message = drop.message_ts !== undefined ? ` message_ts=${quote(drop.message_ts)}` : ''
  const refusal = drop.reason === 'fungible-refused' ? ` refusal=${word(drop.refusal)}` : ''
  return `[slack] ${REACTION_DROPPED}: persona=${renderReactionPersonaRef(p)}${chat}${message} reason=${word(drop.reason)}${refusal}`
}

/** A routing/decision throw is acked. `described` is describeSlackCallFailure's safe tail. */
export function buildReactionEventErrorLine(p: ReactionIntakePersona, described: string): string {
  return `[slack] persona-routing: error handling reaction event for persona=${renderReactionPersonaRef(p)}${escapeCause(described)}`
}

/** The stored item waits for redelivery/recovery after a failed ack. */
export function buildReactionAckFailedLine(p: ReactionIntakePersona, described: string): string {
  return `[slack] persona-routing: failed to ack reaction event for persona=${renderReactionPersonaRef(p)}${escapeCause(described)}`
}

/** Shared by Slack-event and bot-tool post-accept preparation failures. */
export function buildReactionPreparationFailedLine(p: ReactionIntakePersona, described: string): string {
  return `[slack] persona-routing: post-accept reaction preparation failed for persona=${renderReactionPersonaRef(p)}${escapeCause(described)}`
}

/** A thrown store leaves the Slack event unacked. */
export function buildReactionStoreFailedLine(p: ReactionIntakePersona, described: string): string {
  return `[slack] persona-routing: reaction store failed for persona=${renderReactionPersonaRef(p)} — not acked, so Slack sends it again${escapeCause(described)}`
}

/**
 * A `bot-tool` reaction's `queue.accept` threw. `ref` is the routing's
 * persona reference and `described` is `describeSlackCallFailure`'s output
 * for the thrown value, never the error:
 * `[slack] persona-routing: bot-tool reaction store failed for persona <ref>[ (reason=<code>)]: <description>`
 */
export function buildBotToolReactionStoreFailedLine(ref: string, described: string): string {
  return `[slack] persona-routing: bot-tool reaction store failed for persona ${escapeCause(ref)}${escapeCause(described)}`
}

/**
 * Any other throw while taking a `bot-tool` reaction, before its
 * preparation; `ref` and `described` as for
 * {@link buildBotToolReactionStoreFailedLine}:
 * `[slack] persona-routing: error handling bot-tool reaction for persona <ref>[ (reason=<code>)]: <description>`
 */
export function buildBotToolReactionErrorLine(ref: string, described: string): string {
  return `[slack] persona-routing: error handling bot-tool reaction for persona ${escapeCause(ref)}${escapeCause(described)}`
}
