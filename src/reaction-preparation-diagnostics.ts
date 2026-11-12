/**
 * Content-free server-log lines for Reaction Item preparation (SR-10.1).
 *
 * Each line names the receiving persona, the conversation and the reacted
 * message's ts, and nothing else: no message text, reactor or channel display
 * name, emoji, raw Slack response or error. The receiving persona's
 * configured name is the only display name, written as configured. Pure
 * builders: no I/O.
 */
import type { ReactionFungibleCondition, ReactionWithdrawalReason } from './delivery-queue.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'

export const REACTION_WITHDRAWN = 'reaction-withdrawn'
export const REACTION_MESSAGE_UNKNOWN = 'reaction-message-unknown'

/** The receiving persona (its configured name when known) and the reacted message. */
export interface ReactionDiagnosticSubject {
  key: string
  name?: string
  chat_id: string
  message_ts: string
}

const safe = (text: string): string => redactSlackLogText(text).replace(/[\r\n]/g, ' ')

// The configured name is never redacted (renderPersonaRef's JSON quoting keeps it one line), and the key is a validated persona key.
function subject(s: ReactionDiagnosticSubject): string {
  const persona = `persona=${s.name !== undefined ? renderPersonaRef(s.name, s.key) : s.key}`
  return `${persona} chat_id=${JSON.stringify(safe(s.chat_id))} message_ts=${JSON.stringify(safe(s.message_ts))}`
}

/** `[slack] reaction-withdrawn: persona=<ref> chat_id="…" message_ts="…" reason=<reason>[ failed_condition=<condition>]` */
export function buildReactionWithdrawnLine(s: ReactionDiagnosticSubject, reason: ReactionWithdrawalReason, failedCondition?: ReactionFungibleCondition): string {
  const failed = failedCondition !== undefined ? ` failed_condition=${safe(failedCondition)}` : ''
  return `[slack] ${REACTION_WITHDRAWN}: ${subject(s)} reason=${safe(reason)}${failed}`
}

/** `[slack] reaction-message-unknown: persona=<ref> chat_id="…" message_ts="…"`: the notice was fixed without `thread_ts` (L1). */
export function buildReactionMessageUnknownLine(s: ReactionDiagnosticSubject): string {
  return `[slack] ${REACTION_MESSAGE_UNKNOWN}: ${subject(s)}`
}
