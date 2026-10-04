/**
 * line-parts.ts — a line builder's own text around the parts a case cannot
 * rebuild (b.jg5 SRJ-1014: every line a test asserts comes from its exported
 * builder, never typed). A case hands the builder a marker (`LINE_HOLE`) for
 * each such part — a thrown value's description that carries its stack
 * frames, a label the module does not export, any value the case means to
 * leave open — and gets back:
 * - `lineParts(build)`: the builder's text split at each marker, in order
 *   (one more part than markers), so a case can match a line by its head,
 *   its tail or the words between;
 * - `builtAround(build)`: a pattern of the builder's text before and after
 *   its one marker, with anything in it.
 *
 * Pure: reads nothing, writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

/** The marker a case passes for an open part: a NUL, which no builder's own text holds. */
export const LINE_HOLE = '\u0000'

/** `build`'s text, given `LINE_HOLE` for each open part, split at each one: the builder's own words before, between and after them. */
export function lineParts(build: (hole: string) => string): string[] {
  return build(LINE_HOLE).split(LINE_HOLE)
}

/**
 * The lines `build` makes whatever it is given as its one open part: a
 * pattern of the builder's own text before and after that part.
 */
export function builtAround(build: (hole: string) => string): RegExp {
  const [head, tail] = lineParts(build) as [string, string]
  const quote = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${quote(head)}.*${quote(tail)}$`)
}
