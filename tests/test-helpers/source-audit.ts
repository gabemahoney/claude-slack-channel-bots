/**
 * test-helpers/source-audit.ts — Helpers for static audits of source text
 * (tests that cannot import a module, e.g. src/server.ts, whose module-scope
 * startup code must never run in a unit test; b.av2 SR-13.2).
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * `source` with every comment removed: block comments (JSDoc included) and
 * line comments, whole-line or trailing. String and template literals are
 * matched first and kept, so a `//` inside a string is not taken for a
 * comment. Prose or commented-out code that names a function (e.g. "BEFORE
 * startupSessionManager", `// await reconcileOrphans(personaConfig)`) can then
 * never satisfy or skew a code-position assertion.
 */
export function stripComments(source: string): string {
  return source.replace(
    /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_match, literal: string | undefined) => literal ?? '',
  )
}

/** Start offsets of every match of the global regex `re` in `text`. */
export function indicesOf(re: RegExp, text: string): number[] {
  return [...text.matchAll(re)].map((m) => m.index ?? -1)
}
