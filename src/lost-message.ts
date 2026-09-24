/**
 * lost-message.ts — The lost-message recovery state and notice text (b.av2
 * SR-4.6, SR-7.3).
 *
 * A Slack message that finds no live, stream-bearing session for persona P is
 * lost: it is not delivered to P's instance and not saved. P's destination is
 * told once, through the persona notifier, with the text built here. Nothing
 * is posted in the conversation the message came from. The inbound pipeline
 * (`src/persona-routing.ts`) reads the real restart state, fires the
 * human-triggered restart and raises the notice; this module only decides the
 * state and builds the text.
 *
 * Pure module (b.av2 SR-13.1): no state, no I/O, no timers and no logging;
 * nothing runs at import. The restart-state queries are injected.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The recovery state a lost message reports: a restart of P already pending
 * or running; a human-triggered restart of P started for this message;
 * auto-restart disabled (`session_restart_delay` 0); or P at the
 * restart-failure cap.
 */
export type LostMessageState = 'restarting' | 'starting-now' | 'auto-restart-disabled' | 'restart-limit-reached'

/** The restart-state queries for the receiving persona, asked in order and only as far as needed. */
export interface LostMessageRecoveryQueries {
  /** True when a restart of the persona is already pending or running. */
  isRestartPending(): boolean
  /** True when auto-restart is disabled (`session_restart_delay` is 0). */
  isAutoRestartDisabled(): boolean
  /** True when the persona is at the restart-failure cap. */
  isAtRestartLimit(): boolean
}

// ---------------------------------------------------------------------------
// Recovery-state decision
// ---------------------------------------------------------------------------

/**
 * The recovery state for a lost message, in the human-trigger order (b.kvq /
 * b.9cj): restart pending, then auto-restart disabled, then at the cap;
 * otherwise `starting-now`, and the caller fires the human-triggered restart.
 * Stops at the first query that answers true. Changes nothing.
 */
export function decideLostMessageState(queries: LostMessageRecoveryQueries): LostMessageState {
  if (queries.isRestartPending()) return 'restarting'
  if (queries.isAutoRestartDisabled()) return 'auto-restart-disabled'
  if (queries.isAtRestartLimit()) return 'restart-limit-reached'
  return 'starting-now'
}

// ---------------------------------------------------------------------------
// Notice text
// ---------------------------------------------------------------------------

/** The recovery wording each state adds to the notice. */
const STATE_WORDING: Record<LostMessageState, string> = {
  'restarting': 'Recovery: restarting — a restart of this persona\'s instance was already under way.',
  'starting-now': 'Recovery: starting now — a restart of this persona\'s instance has just been started.',
  'auto-restart-disabled':
    'Recovery: auto-restart disabled — the instance will not restart on its own; restart the server to recover.',
  'restart-limit-reached':
    'Recovery: restart limit reached — automatic restarts are suspended for this persona; restart the server to recover.',
}

/**
 * The sender label as notice text: Slack's control characters `&`, `<` and
 * `>` escaped, so a label such as `<!channel>` or `<@U…>` (a webhook
 * `username` is set by the sender) renders as text and notifies no one, and
 * line breaks folded to spaces, so the label stays on the notice's first line.
 */
function escapeSenderLabel(label: string): string {
  return label
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s*[\r\n]+\s*/g, ' ')
}

/**
 * The lost-message notice body for the persona's destination: that a message
 * from `senderLabel` (a readable name, or the user or bot ID when there is
 * none) was lost, not delivered and not saved, and the recovery state. One
 * line, so a dry-run log line (which carries only the first line) keeps the
 * sender and the state. Carries no message text, no mention of the sender and
 * no persona name (the notifier adds the persona reference).
 */
export function buildLostMessageNotice(senderLabel: string, state: LostMessageState): string {
  return (
    `:warning: *Message lost* — a message from ${escapeSenderLabel(senderLabel)} was not delivered to ` +
    `this persona's instance and was not saved; it will not be delivered later. ${STATE_WORDING[state]}`
  )
}
