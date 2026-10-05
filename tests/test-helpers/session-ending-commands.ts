/**
 * test-helpers/session-ending-commands.ts — the session-ending command forms
 * of ADSRD SR-1.4, as b.jg5 SRJ-1001 lists them for every post CSCB writes
 * (the CONFLICT, unusable-name, launch-start and stuck-launch posts): `kill`
 * named as a command to run, `pause` in any form, `--include-finished`,
 * `tmux kill-session` and `tmux kill-server`.
 *
 * Defined once, here, and imports nothing: the `/ci` image copies `tests/`
 * to `/tests` with no `src/` beside it, so the scenario value printer
 * (`tests/integration/fixtures/fmk-texts.ts`) can load this file in the
 * image, where it cannot load `conflict-cases.ts`. `conflict-cases.ts`
 * re-exports both names, so the unit tests import them from there as before.
 *
 * Exports:
 *   - {@link SESSION_ENDING_COMMAND_FORMS}: the five forms, each a name and a
 *     pattern. None matches agent-director's own "no kill was sent", "retry
 *     kill later" or "never delete this row";
 *   - {@link sessionEndingCommandsIn}: the names of the forms a text matches,
 *     in table order.
 *
 * Pure: reads nothing, writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

/** One session-ending command form: what it names and the pattern that finds it. */
export interface SessionEndingCommandForm {
  readonly name: string
  /** Not global, so it keeps no `lastIndex` between tests. */
  readonly pattern: RegExp
}

/** Imperative verbs that put a command to run after them. */
const RUN_VERBS = String.raw`(?:run|use|type|execute|issue|invoke)`

/** `verb` named as a command: `agent-director <verb>`, a code span opening with it, `<verb>` with an option or a pid, or a run verb before it. */
function commandFormOf(verb: string): RegExp {
  return new RegExp(
    String.raw`\bagent-director\s+${verb}\b|\x60\s*${verb}\b|\b${verb}\s+(?:-|\d)|\b${RUN_VERBS}\s+(?:the\s+|a\s+)?\x60?\s*${verb}\b`,
    'i',
  )
}

/**
 * The commands that end a session as ADSRD SR-1.4 defines one, as SRJ-1001
 * lists them for the CONFLICT, unusable-name, launch-start and stuck-launch
 * posts: `kill` named as a command to run (so agent-director's "no kill was
 * sent" and "retry kill later" are no hit), `pause` in any form,
 * `--include-finished` (with or without its dashes), `tmux kill-session` and
 * `tmux kill-server`.
 */
export const SESSION_ENDING_COMMAND_FORMS: readonly SessionEndingCommandForm[] = Object.freeze([
  Object.freeze({ name: 'kill as a command', pattern: commandFormOf('kill') }),
  Object.freeze({ name: 'pause', pattern: /\bpause\b/i }),
  Object.freeze({ name: '--include-finished', pattern: /include-finished/i }),
  Object.freeze({ name: 'tmux kill-session', pattern: /\bkill-session\b/i }),
  Object.freeze({ name: 'tmux kill-server', pattern: /\bkill-server\b/i }),
])

/** The names of the session-ending command forms `text` matches, in table order; empty when none does. */
export function sessionEndingCommandsIn(text: string): string[] {
  return SESSION_ENDING_COMMAND_FORMS.filter((form) => form.pattern.test(text)).map((form) => form.name)
}
