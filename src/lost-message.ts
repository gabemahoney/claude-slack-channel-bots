/** Existing pure message-triggered recovery decisions. */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Every recovery state a lost message reports, once, in the contract order (the
 * order `decideLostMessageState` asks them, but for the sequence/wait input,
 * which answers `restarting` before `session-starting`). Read-only; tests and
 * the routing harness import it and keep no copy.
 *
 * - `not-up`: P is not up (its bring-up is retrying or broken,
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
 * the restart cap and P's retry timer is armed ( * "state 5 applies only while P's retry timer is armed"; the caller's
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

/** States 1 to 5 of the states asked before anything that can be in flight for P. */
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
 * The first of states 1 to 5 that applies: `not-up`,
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
 * The recovery state for a lost message: states 1 to 5
 * (`decideEarlyLostMessageState`); then a live-row sequence or old-life wait
 * step running (`restarting`); then the row reading `pending`
 * (`session-starting`); then, in the human-trigger order,
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
 * `starting-now` does.
 */
export function firesHumanTriggeredRestart(state: LostMessageState): boolean {
  return state === 'starting-now'
}
