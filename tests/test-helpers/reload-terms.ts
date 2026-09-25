/**
 * test-helpers/reload-terms.ts — The reload wording no advertised surface may
 * carry (b.av2 SR-8.8, AC 74): the CLI usage text (cli.test.ts), the MCP tool
 * list (registry.test.ts) and the MCP instructions (shipped-docs.test.ts).
 * The README and the skills may describe the gesture and are not checked.
 *
 * SPDX-License-Identifier: MIT
 */

/** `reload` in any case, the two gesture files and their suffixes. */
export const RELOAD_TERMS: readonly (string | RegExp)[] = [/reload/i, 'config.json.apply', 'config.json.pending', '.apply', '.pending']

/** The listed reload terms found in `text`, as written in `RELOAD_TERMS`. */
export function reloadTermsIn(text: string): string[] {
  return RELOAD_TERMS.filter((t) => (typeof t === 'string' ? text.includes(t) : t.test(text))).map(String)
}
