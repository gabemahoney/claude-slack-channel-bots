/**
 * ad-description-phrases.ts — agent-director's description words that CSCB
 * matches.
 *
 * These are agent-director's own words (ADSRD SR-1.4; HO section 2), copied
 * here so CSCB matches exactly what agent-director writes in an error's
 * description. CSCB only looks for them in a description it has received;
 * none is ever used to build a command. The stub's error builders
 * (`tests/test-helpers/agent-director-stub.ts`) take the words from here
 * (SRJ-1303), and the error classifier (`src/ad-error-class.ts`; b.jg5
 * SRJ-104) matches `UNUSABLE_RECORDED_NAME_PHRASE` and
 * `DIFFERENT_TMUX_SERVER_PHRASE` from here, and its launch-timeout predicate
 * (`isLaunchTimeoutError`; b.jg5 SRJ-407) matches `LAUNCH_TIMEOUT_PHRASE`;
 * the conflict latch
 * (`src/conflict-latch.ts`; b.jg5 SRJ-507) matches the nine CONFLICT case
 * words from here, in the order it defines; and the bounded kill retry
 * (`src/kill-retry.ts`; b.jg5 SRJ-702) and the kill-failure alert
 * (`src/kill-failure-alert.ts`; SRJ-1007) match the survivor-naming form
 * through `survivorPids` from here, in the `ErrTmuxKillFailed` description
 * that `killFailedDescriptionOf` (`src/ad-error-class.ts`) reads. No `src/`
 * module matches the other words yet.
 *
 * The CONFLICT case words number nine (b.jg5 SRJ-507), "another
 * agent-director store" among them. The other description words below (the
 * plain spawn's label wordings, "the new row was ended", "nothing was written
 * and no row was created", "the agent's pane was not adopted", "retry kill
 * later", "never delete this row", "no kill was sent") are not case phrases:
 * each rides beside a case phrase, on a kill failure, or on an UNAVAILABLE
 * (`ErrTmuxUnresponsive`) or ENVIRONMENT (`ErrTmuxNotAvailable`) error: "the
 * new row was ended" also rides on a plain spawn's `ErrTmuxUnresponsive` or
 * `ErrTmuxNotAvailable` after "duplicate session" whose re-lookup could not
 * answer, beside a retry with `reuse_finished` (HO rev 26; b.jg5 SRJ-111).
 * CSCB keys no behaviour on those words there: the error's class decides,
 * and the row the `get` after it reads.
 *
 * Besides words, this module holds one pattern and its one helper: the
 * survivor-naming form of a kill failure (`SURVIVOR_PID_PATTERN`, b.jg5
 * SRJ-702, SRJ-1303), built from the survivor clause's words, and
 * `survivorPids`, which lists the pids a description's survivor clause names.
 * No other module defines the form.
 *
 * It defines no order in which the CONFLICT case words are checked; that
 * order (b.jg5 SRJ-507) belongs to the code that resolves a CONFLICT case, and
 * the order of the declarations below means nothing.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Unusable recorded session name (b.jg5 SRJ-104, SRJ-512)
// ---------------------------------------------------------------------------

/** Carried by an `ErrInternal` whose row's recorded tmux session name cannot be used. */
export const UNUSABLE_RECORDED_NAME_PHRASE = 'the recorded tmux session name'

// ---------------------------------------------------------------------------
// CONFLICT case words (b.jg5 SRJ-507)
// ---------------------------------------------------------------------------

/** CONFLICT case "conflicting labels". */
export const CONFLICT_CONFLICTING_LABELS_PHRASE = 'conflicting labels'

/** CONFLICT case "the agent's pane was not found". */
export const CONFLICT_PANE_NOT_FOUND_PHRASE = "the agent's pane was not found"

/** CONFLICT case "not this launch's session". */
export const CONFLICT_NOT_THIS_LAUNCH_PHRASE = "not this launch's session"

/** CONFLICT case "left over from an earlier life". */
export const CONFLICT_LEFTOVER_PHRASE = 'left over from an earlier life'

/** CONFLICT case "never reported in". */
export const CONFLICT_NEVER_REPORTED_IN_PHRASE = 'never reported in'

/** CONFLICT case "this row's own id". */
export const CONFLICT_OWN_ID_PHRASE = "this row's own id"

/** CONFLICT case "no valid instance id". */
export const CONFLICT_NO_VALID_ID_PHRASE = 'no valid instance id'

/** CONFLICT case "a different instance id". */
export const CONFLICT_DIFFERENT_ID_PHRASE = 'a different instance id'

/** CONFLICT case "another agent-director store": the session's label was written by another store. */
export const CONFLICT_ANOTHER_STORE_PHRASE = 'another agent-director store'

// ---------------------------------------------------------------------------
// Words beside a CONFLICT case phrase, or on an UNAVAILABLE or ENVIRONMENT
// error (b.jg5 SRJ-507, SRJ-111, SRJ-1303; not case phrases)
// ---------------------------------------------------------------------------

/**
 * Written by a plain spawn beside "left over from an earlier life" for the
 * leftover it meets at "duplicate session". Not a case phrase: that
 * description's case is "left over from an earlier life".
 */
export const PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE = 'its label names this instance id'

/** Written by a plain spawn beside "a different instance id" or "another agent-director store" for the holder it meets at "duplicate session". */
export const PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE = 'its label does not name this instance id'

/**
 * Written by a plain spawn that ended its new row after its session-creating
 * call met "duplicate session" (b.jg5 SRJ-111, SRJ-713): beside the case
 * phrase of its `ErrTmuxSessionConflict`, or, when its re-lookup of the
 * holder could not answer, in its `ErrTmuxUnresponsive` (UNAVAILABLE) or
 * `ErrTmuxNotAvailable` (ENVIRONMENT) description, which also names a retry
 * with `reuse_finished` once the name is free (HO rev 26).
 */
export const NEW_ROW_ENDED_PHRASE = 'the new row was ended'

/** Written by the pre-spawn scan's refusal, which leaves no row behind. */
export const NOTHING_WRITTEN_PHRASE = 'nothing was written and no row was created'

/** Written by the pane verbs beside "the agent's pane was not found" when a lost create reply's pane was not adopted. */
export const PANE_NOT_ADOPTED_PHRASE = "the agent's pane was not adopted"

/** Written by `kill` beside "not this launch's session" and "never reported in", and by a kill failure that sent none. */
export const NO_KILL_SENT_PHRASE = 'no kill was sent'

// ---------------------------------------------------------------------------
// Kill failure (b.jg5 SRJ-702, SRJ-1303)
// ---------------------------------------------------------------------------

/** Written by `kill` in every `ErrTmuxKillFailed` description. */
export const RETRY_KILL_LATER_PHRASE = 'retry kill later'

/** Written by `kill` in every `ErrTmuxKillFailed` description. */
export const NEVER_DELETE_ROW_PHRASE = 'never delete this row'

/**
 * The survivor clause's words for one survivor (b.jg5 SRJ-702, SRJ-1303),
 * written by `kill` before "(pid S)".
 */
export const SURVIVOR_CLAUSE_ONE_PHRASE = 'another process of a pane of the labelled session'

/**
 * The survivor clause's words for two or more survivors (b.jg5 SRJ-702,
 * SRJ-1303), written by `kill` before "(pids S1, S2)".
 */
export const SURVIVOR_CLAUSE_MANY_PHRASE = 'other processes of panes of the labelled session'

/**
 * The survivor-naming form (b.jg5 SRJ-702, SRJ-1303, SRJ-1007): the survivor
 * clause of an `ErrTmuxKillFailed` description, which names the processes of
 * the labelled session's panes that outlived the kill exit wait. Checked
 * against agent-director 0.11.0 (tag `v0.11.0`,
 * `pkg/api/kill_errors.go`, `waitExpiredError` and `noPaneError`; pinned by
 * `pkg/api/apitest/descriptions_kill.go`):
 *   - one survivor: "another process of a pane of the labelled session
 *     (pid S)" ({@link SURVIVOR_CLAUSE_ONE_PHRASE});
 *   - several: "other processes of panes of the labelled session
 *     (pids S1, S2)" ({@link SURVIVOR_CLAUSE_MANY_PHRASE}), the pids joined
 *     with ", ".
 * The worker's own pid is written as "the agent process (pid N)" after the
 * kill exit wait (joined with " and " to the survivor clause when both
 * outlived it) and as "while its agent process still runs (pid N)" when no
 * session or pane of the launch was found. Neither carries the clause's
 * words, so the pattern never matches the worker's pid. Group 1 holds the
 * one survivor's pid, group 2 the several survivors' list.
 *
 * Reading the pids from the description is interim: a description is text
 * for humans, agent-director's structured `survivor_pids` is on the
 * `ad.kill.called` trail, and CSCB has asked agent-director for the survivor
 * pids on the error itself (SRJ-702).
 *
 * It has no `g` flag, so `.test()` keeps no state between calls.
 */
export const SURVIVOR_PID_PATTERN = new RegExp(
  `\\b${SURVIVOR_CLAUSE_ONE_PHRASE} \\(pid (\\d+)\\)|\\b${SURVIVOR_CLAUSE_MANY_PHRASE} \\(pids (\\d+(?:, \\d+)*)\\)`,
)

/**
 * Every pid `description`'s survivor clause names, in the order it names
 * them; empty when it carries no survivor clause. Never the worker's pid.
 */
export function survivorPids(description: string): number[] {
  const everyMatch = new RegExp(SURVIVOR_PID_PATTERN.source, 'g')
  return Array.from(description.matchAll(everyMatch)).flatMap((match) => {
    const named = match[1] ?? match[2]
    return named === undefined ? [] : named.split(', ').map(Number)
  })
}

// ---------------------------------------------------------------------------
// Different tmux server (b.jg5 SRJ-311, SRJ-1021)
// ---------------------------------------------------------------------------

/** Carried when the tmux server on the row's recorded socket is not the one the agent was launched on. */
export const DIFFERENT_TMUX_SERVER_PHRASE = 'not the tmux server the agent was launched on'

// ---------------------------------------------------------------------------
// Launch timeout (b.jg5 SRJ-407)
// ---------------------------------------------------------------------------

/** Carried by an `ErrTmuxUnresponsive` that ends a launch call as a launch timeout. */
export const LAUNCH_TIMEOUT_PHRASE = 'the session may have been created'

// ---------------------------------------------------------------------------
// Still stopping, still starting (b.jg5 SRJ-104, SRJ-1303)
// ---------------------------------------------------------------------------

/** Carried by an `ErrTmuxUnresponsive` for a row that appears to still be stopping. */
export const STILL_STOPPING_PHRASE = 'appears to still be stopping'

/** Carried by an `ErrTmuxUnresponsive` for a row that appears to still be starting. */
export const STILL_STARTING_PHRASE = 'appears to still be starting'
