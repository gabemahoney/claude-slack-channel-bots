/**
 * test-helpers/dead-evidence.ts — The expected dead-evidence answer of every
 * dead-session cause and escalate-dead verdict (b.jg5 SRJ-611).
 *
 * `DEAD_EVIDENCE_OF` is keyed by `DeadEvidenceSource` (the union of
 * `DeadSessionCause` and `EscalateDeadVerdict`), so a new cause or verdict
 * fails the typecheck until it has an answer here. It is written out by hand,
 * never asked of the code under test: true exactly for the GONE-based ones.
 * `tests/session-manager.test.ts`'s SRJ-611 describe checks `isDeadEvidence`
 * against it over every value; other suites read it for what a cause or
 * verdict leads to (a restart path's checked kill only after a GONE-based
 * verdict) and do not check `isDeadEvidence` again.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  DEAD_SESSION_CAUSE_PROMPT_ROW_LADDER_GONE,
  DEAD_SESSION_CAUSE_ROW_ABSENT,
  DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE,
  DEAD_SESSION_CAUSE_ROW_READ_FINISHED,
  DEAD_SESSION_CAUSE_TMUX_GONE,
  ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ,
  ESCALATE_DEAD_WAITING_ROW_PANE_GONE,
  type DeadEvidenceSource,
} from '../../src/session-manager.ts'

/** The dead-evidence answer of every cause and verdict (b.jg5 SRJ-611): true exactly for the GONE-based ones. */
export const DEAD_EVIDENCE_OF: Readonly<Record<DeadEvidenceSource, boolean>> = {
  [DEAD_SESSION_CAUSE_TMUX_GONE]: true,
  [DEAD_SESSION_CAUSE_PROMPT_ROW_LADDER_GONE]: true,
  [DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE]: false,
  [DEAD_SESSION_CAUSE_ROW_ABSENT]: false,
  [DEAD_SESSION_CAUSE_ROW_READ_FINISHED]: false,
  'dead-session': true,
  'working-tmux-gone': true,
  [ESCALATE_DEAD_WAITING_ROW_PANE_GONE]: true,
  [ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ]: false,
  'prompt-row-tmux-gone': true,
}
