/**
 * test-helpers/cli-teardown.ts — Fixtures shared by the CLI teardown's two
 * suites (`tests/cli-teardown.test.ts`, the pure pieces, and
 * `tests/cli.test.ts`, the commands; b.jg5 SRJ-901, SRJ-904, SRJ-907,
 * SRJ-909, SRJ-1007).
 *
 *   - {@link UNKNOWN_STATE}: a row state CSCB does not know, which the
 *     precheck and the teardown take as live (SRJ-901 step 2, hatch A3);
 *   - {@link teardownKillFailedDescription}: the raw description of an
 *     `ErrTmuxKillFailed` as the teardown's kill-failure alert decision quotes
 *     it, read through the checked kill under `TEARDOWN_KILL_OPTIONS`, as the
 *     CLI's kill reads it;
 *   - {@link cliAlertLine}: the kill-failure alert line a CLI teardown gives a
 *     persona, built from `src/kill-failure-alert.ts`'s builders.
 *
 * Pure: no client, no process, no timer, no file.
 *
 * SPDX-License-Identifier: MIT
 */

import { AD_ERROR_CLASS_UNAVAILABLE } from '../../src/ad-error-class.ts'
import { KILL_OUTCOME_NOT_KILLED, killOutcomeOf } from '../../src/checked-kill.ts'
import { TEARDOWN_KILL_OPTIONS, type CliTeardownCommand, type CliTeardownPersona } from '../../src/cli-teardown.ts'
import {
  KILL_FAILURE_CLOSING_CLI_TEARDOWN,
  killFailureAlertEntryText,
  killFailureAlertText,
  killFailureCliTeardownEntryContext,
  type KillFailureAlertContent,
} from '../../src/kill-failure-alert.ts'
import { renderPersonaRef } from '../../src/persona-identity.ts'

/** A row state CSCB does not know: live (b.jg5 SRJ-901 step 2, hatch A3). */
export const UNKNOWN_STATE = 'a_state_cscb_does_not_know'

/**
 * The raw description of the `ErrTmuxKillFailed` `error`, as the teardown's
 * kill-failure alert decision quotes it: the UNAVAILABLE outcome the checked
 * kill under `TEARDOWN_KILL_OPTIONS` gives it keeps that description. Throws
 * when `error` gives no such outcome.
 */
export function teardownKillFailedDescription(error: unknown): string {
  const outcome = killOutcomeOf({ thrown: error }, TEARDOWN_KILL_OPTIONS)
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED || outcome.errorClass !== AD_ERROR_CLASS_UNAVAILABLE || outcome.killFailedDescription === undefined) {
    throw new Error('precondition: an ErrTmuxKillFailed keeps its description')
  }
  return outcome.killFailedDescription
}

/**
 * The kill-failure alert line a CLI teardown under `command` gives `persona`
 * for `content` (b.jg5 SRJ-704, SRJ-1007, SRJ-909): E20's log-line and entry
 * form, the CLI teardown's context naming the command, the text unescaped
 * with the CLI closing sentence.
 */
export function cliAlertLine(command: CliTeardownCommand, persona: CliTeardownPersona, content: KillFailureAlertContent): string {
  return killFailureAlertEntryText(
    `persona ${renderPersonaRef(persona.name, persona.key)}`,
    killFailureCliTeardownEntryContext(command),
    killFailureAlertText(content, KILL_FAILURE_CLOSING_CLI_TEARDOWN, false),
  )
}
