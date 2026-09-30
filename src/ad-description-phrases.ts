/**
 * ad-description-phrases.ts — agent-director's description words that CSCB
 * matches.
 *
 * These are agent-director's own words (ADSRD SR-1.4; HO section 2), copied
 * here so CSCB matches exactly what agent-director writes in an error's
 * description. CSCB only looks for them in a description it has received;
 * none is ever used to build a command. The stub's error builders
 * (`tests/test-helpers/agent-director-stub.ts`) take the words from here now
 * (SRJ-1303); the error classifier (`src/ad-error-class.ts`, E4 T3; b.jg5
 * SRJ-104) and later Epics (E11, E13, E28) will match them from here too.
 *
 * This module holds words only. It defines no order in which the CONFLICT
 * case words are checked; that order (b.jg5 SRJ-507) belongs to the code that
 * resolves a CONFLICT case, and the order of the declarations below means
 * nothing.
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

/** CONFLICT case "no pane 0.0". */
export const CONFLICT_NO_PANE_PHRASE = 'no pane 0.0'

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

/**
 * The plain spawn's extra wording beside "left over from an earlier life".
 * Not a case phrase: that description's case is "left over from an earlier
 * life".
 */
export const PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE = 'its label names this instance id'

// ---------------------------------------------------------------------------
// Different tmux server (b.jg5 E11)
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
