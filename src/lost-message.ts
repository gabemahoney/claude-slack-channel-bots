/**
 * lost-message.ts — The lost-message recovery state and notice text (b.av2
 * SR-4.6, SR-7.3; b.jg5 SRJ-1011, SRJ-1509).
 *
 * A Slack message that finds no live, stream-bearing session for persona P is
 * lost: it is not delivered to P's instance and not saved. P's destination is
 * told once, through the persona notifier, with the text built here. Nothing
 * is posted in the conversation the message came from. The inbound pipeline
 * (`src/persona-routing.ts`) reads the real state of P, fires the
 * human-triggered restart and raises the notice; this module only decides the
 * state and builds the text.
 *
 * The state is the first that applies, in the order of `LOST_MESSAGE_STATES`
 * (b.jg5 SRJ-1011): not up; held for a human; cannot launch; kill failed; not
 * answering; session starting; restarting; auto-restart disabled; restart
 * limit reached; starting now. One input is asked out of that order: a
 * live-row sequence or old-life wait step running for P answers `restarting`
 * after states 1 to 5 and before `session-starting`, so such a step reports
 * `restarting` even while P's row reads `pending` (b.jg5 SRJ-706, SRJ-410,
 * SRJ-812). Only `starting-now` fires the human-triggered restart
 * (`firesHumanTriggeredRestart`); in the five states from `held-for-human` to
 * `session-starting` none fires (b.jg5 SRJ-1501).
 *
 * Pure module (b.av2 SR-13.1): no state, no I/O, no timers and no logging;
 * nothing runs at import. The state queries are injected.
 *
 * SPDX-License-Identifier: MIT
 */

import { escapeSlackControlCharacters } from './slack-text-escape.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Every recovery state a lost message reports, once, in SRJ-1011's order (the
 * order `decideLostMessageState` asks them, but for the sequence/wait input,
 * which answers `restarting` before `session-starting`). Read-only; tests and
 * the routing harness import it and keep no copy.
 *
 * - `not-up`: P is not up (b.av2 SR-6.4: its bring-up is retrying or broken,
 *   or unknown to the bring-up controller), so no restart is started and its
 *   instance is launched once it recovers. A retrying or broken persona
 *   forwards no Slack event, so this is reached only by a message P's
 *   connection received while P was up, when P stopped being up before the
 *   message found no session (for example a Web API call refused for its bot
 *   token during its handling), or by one received by the old half of a
 *   destructive modify, whose bring-up state is cancelled before its
 *   connection is stopped.
 * - `held-for-human`: P is latched (a CONFLICT, an unusable recorded name or
 *   a launch with no recorded start).
 * - `cannot-launch`: P is held on `ErrInvalidFlags`.
 * - `kill-failed`: P's kill-failure episode is open, or P waits on an
 *   old-life hold whose old key's kill failed.
 * - `not-answering`: P's `tmux-unresponsive` condition holds, or its
 *   `tmux-unavailable` or `ad-config-malformed` outage is raised, P is below
 *   the restart cap and P's retry timer is armed (b.jg5 SRJ-1011 as amended:
 *   "state 5 applies only while P's retry timer is armed"; the caller's
 *   `isNotAnswering` asks it). A P at the restart cap is never in this state.
 * - `session-starting`: P's row reads `pending` (a launch or dialog approver
 *   for P is running, or the caller's one `status` read returned `pending`).
 * - `restarting`: a restart of P is already pending or running, or a
 *   live-row sequence or old-life wait step is running for P.
 * - `auto-restart-disabled`: `session_restart_delay` is 0.
 * - `restart-limit-reached`: P is at the restart-failure cap.
 * - `starting-now`: a human-triggered restart of P is started for this
 *   message.
 */
export const LOST_MESSAGE_STATES = Object.freeze([
  'not-up',
  'held-for-human',
  'cannot-launch',
  'kill-failed',
  'not-answering',
  'session-starting',
  'restarting',
  'auto-restart-disabled',
  'restart-limit-reached',
  'starting-now',
] as const)

/** A recovery state a lost message reports (see `LOST_MESSAGE_STATES`). */
export type LostMessageState = (typeof LOST_MESSAGE_STATES)[number]

/** States 1 to 5 of SRJ-1011: the states asked before anything that can be in flight for P. */
export type EarlyLostMessageState = Extract<
  LostMessageState,
  'not-up' | 'held-for-human' | 'cannot-launch' | 'kill-failed' | 'not-answering'
>

/**
 * The inputs of states 1 to 5 for the receiving persona, asked in order and
 * only as far as needed. Each is optional; an absent query answers false.
 */
export interface EarlyLostMessageQueries {
  /**
   * True when the persona is not up (the one up predicate, `isPersonaUp`,
   * answers false). Absent: the persona counts as up.
   */
  isNotUp?(): boolean
  /** True when the persona is latched (state 2, `held-for-human`). */
  isLatched?(): boolean
  /** True when the persona is held on `ErrInvalidFlags` (state 3, `cannot-launch`). */
  isHeldOnInvalidFlags?(): boolean
  /**
   * True when the persona's kill-failure episode is open, or it waits on an
   * old-life hold whose old key's kill failed (state 4, `kill-failed`).
   */
  isKillFailed?(): boolean
  /**
   * True when the persona's `tmux-unresponsive` condition holds, or its
   * `tmux-unavailable` or `ad-config-malformed` outage is raised, it is
   * below the restart cap and its retry timer is armed (state 5,
   * `not-answering`; state 5 applies only while the persona's retry timer is
   * armed, and never at the cap). No unclassified-error episode feeds it.
   */
  isNotAnswering?(): boolean
}

/** The state queries for the receiving persona, asked in order and only as far as needed. */
export interface LostMessageRecoveryQueries extends EarlyLostMessageQueries {
  /**
   * True when a live-row sequence or old-life wait step is running for the
   * persona: answers `restarting`, after states 1 to 5 and before state 6.
   * Absent: answers false.
   */
  isSequenceOrWaitRunning?(): boolean
  /**
   * True when the persona's row reads `pending` (state 6,
   * `session-starting`): a launch or dialog approver for the persona is
   * running, or the caller's one `status` read returned `pending`. Absent:
   * answers false.
   */
  isRowPending?(): boolean
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
 * The first of states 1 to 5 (b.jg5 SRJ-1011) that applies: `not-up`,
 * `held-for-human`, `cannot-launch`, `kill-failed`, `not-answering`; else
 * undefined. Stops at the first query that answers true; an absent query
 * answers false. Changes nothing. `decideLostMessageState` asks it first, so
 * a caller that must know whether states 1 to 5 apply asks the same code.
 */
export function decideEarlyLostMessageState(queries: EarlyLostMessageQueries): EarlyLostMessageState | undefined {
  if (queries.isNotUp?.() === true) return 'not-up'
  if (queries.isLatched?.() === true) return 'held-for-human'
  if (queries.isHeldOnInvalidFlags?.() === true) return 'cannot-launch'
  if (queries.isKillFailed?.() === true) return 'kill-failed'
  if (queries.isNotAnswering?.() === true) return 'not-answering'
  return undefined
}

/**
 * The recovery state for a lost message (b.jg5 SRJ-1011): states 1 to 5
 * (`decideEarlyLostMessageState`); then a live-row sequence or old-life wait
 * step running (`restarting`); then the row reading `pending`
 * (`session-starting`); then, in the human-trigger order (b.kvq / b.9cj),
 * restart pending (`restarting`), auto-restart disabled, at the cap;
 * otherwise `starting-now`, and the caller fires the human-triggered restart.
 * Stops at the first query that answers true; an absent optional query
 * answers false, so with none given the decision is the four-query one.
 * Changes nothing.
 */
export function decideLostMessageState(queries: LostMessageRecoveryQueries): LostMessageState {
  const early = decideEarlyLostMessageState(queries)
  if (early !== undefined) return early
  if (queries.isSequenceOrWaitRunning?.() === true) return 'restarting'
  if (queries.isRowPending?.() === true) return 'session-starting'
  if (queries.isRestartPending()) return 'restarting'
  if (queries.isAutoRestartDisabled()) return 'auto-restart-disabled'
  if (queries.isAtRestartLimit()) return 'restart-limit-reached'
  return 'starting-now'
}

/**
 * Whether a lost message in `state` fires the human-triggered restart: only
 * `starting-now` does (b.jg5 SRJ-1011, SRJ-1501).
 */
export function firesHumanTriggeredRestart(state: LostMessageState): boolean {
  return state === 'starting-now'
}

// ---------------------------------------------------------------------------
// Notice text
// ---------------------------------------------------------------------------

/**
 * The recovery wording each state adds to the notice, one line each. The five
 * from `held-for-human` to `session-starting` are SRJ-1011's table; the
 * `auto-restart-disabled` wording names the retry that brings back a persona
 * CSCB is already retrying (b.jg5 SRJ-1011, hatch A3). Read-only; tests
 * import it and keep no copy.
 */
export const STATE_WORDING: Readonly<Record<LostMessageState, string>> = Object.freeze({
  'not-up':
    'Recovery: not up — this persona is not up, so no restart was started; its instance will be launched once it recovers.',
  'held-for-human':
    'Recovery: held for a human — this persona is held until a human resolves a problem with its tmux session or agent-director row; no restart was started.',
  'cannot-launch':
    'Recovery: cannot launch — the host\'s agent-director rejected this persona\'s launch; no restart was started.',
  'kill-failed':
    'Recovery: kill failed — a kill of a worker this persona depends on failed, and that worker may still be running; no restart was started.',
  'not-answering':
    'Recovery: not answering — agent-director or tmux is not answering for this persona, tmux is not available, or agent-director refuses its config file; CSCB is retrying, and no restart was started.',
  'session-starting':
    'Recovery: starting — this persona\'s session is starting but has not come up yet; CSCB is checking with agent-director, and no restart was started.',
  'restarting': 'Recovery: restarting — a restart of this persona\'s instance was already under way.',
  'auto-restart-disabled':
    'Recovery: auto-restart disabled — no restart was started because session_restart_delay is 0; if CSCB is already retrying this persona, it comes back when a retry succeeds; otherwise a server restart recovers it.',
  'restart-limit-reached':
    'Recovery: restart limit reached — automatic restarts are suspended for this persona; restart the server to recover.',
  'starting-now': 'Recovery: starting now — a restart of this persona\'s instance has just been started.',
})

/**
 * The sender label as notice text: Slack's control characters `&`, `<` and
 * `>` escaped, so a label such as `<!channel>` or `<@U…>` (a webhook
 * `username` is set by the sender) renders as text and notifies no one, and
 * line breaks folded to spaces, so the label stays on the notice's first line.
 */
function escapeSenderLabel(label: string): string {
  return escapeSlackControlCharacters(label).replace(/\s*[\r\n]+\s*/g, ' ')
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
