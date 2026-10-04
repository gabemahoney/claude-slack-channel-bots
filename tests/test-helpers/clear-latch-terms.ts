/**
 * test-helpers/clear-latch-terms.ts — The `clear-latch` wording nothing
 * offered to a bot may carry (b.jg5 SRJ-511, AC 47): the MCP tool list and
 * every tool definition (registry.test.ts), `MCP_INSTRUCTIONS` and the Slack
 * Reply Guard's reminder text (shipped-docs.test.ts) and every SRJ-10xx
 * notice builder's output (notice-texts.test.ts). The README, the skills, the
 * Slack app manifest, the crontable header and the CLI usage text are for the
 * operator and are not checked.
 *
 * The command name and the route are imported from `src/clear-latch.ts`; the
 * underscore and camel-case spellings are derived from the command name, so
 * no spelling is typed here.
 *
 * SPDX-License-Identifier: MIT
 */

import { CLEAR_LATCH_COMMAND, CLEAR_LATCH_ROUTE } from '../../src/clear-latch.ts'

/** `clear-latch` with each `-` as `_`: `clear_latch`. */
const CLEAR_LATCH_SNAKE = CLEAR_LATCH_COMMAND.replaceAll('-', '_')

/** `clear-latch` in camel case: `clearLatch`. */
const CLEAR_LATCH_CAMEL = CLEAR_LATCH_COMMAND.replace(/-([a-z])/g, (_dash, letter: string) => letter.toUpperCase())

/**
 * SRJ-511's spellings (hatch A3): the command, the route, the underscore and
 * the camel-case forms. Each is matched case-insensitively anywhere in a text.
 */
export const CLEAR_LATCH_TERMS: readonly string[] = Object.freeze([
  CLEAR_LATCH_COMMAND,
  CLEAR_LATCH_ROUTE,
  CLEAR_LATCH_SNAKE,
  CLEAR_LATCH_CAMEL,
])

/**
 * The terms of {@link CLEAR_LATCH_TERMS} found in `text`, matched
 * case-insensitively, each as written in the list and in its order; empty
 * when none is found. A route found reports the command too, since the route
 * holds it.
 */
export function clearLatchTermsIn(text: string): string[] {
  const folded = text.toLowerCase()
  return CLEAR_LATCH_TERMS.filter((term) => folded.includes(term.toLowerCase()))
}
