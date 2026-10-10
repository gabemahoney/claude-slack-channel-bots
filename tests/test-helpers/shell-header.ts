/**
 * shell-header.ts — a release script's exit-code header, read as text, for the
 * tests that check it against the script's code or a skill's exit table
 * (preflight-ad-check, publish-prepare-changelog, publish-promote-exit-table).
 *
 * The header is the script's leading run of comment lines (a `#` after any
 * indent), the shebang included. An exit-code entry is a header line
 * `#   <code>  SR-x.y …` whose code column is a number, or `--` for a step with
 * no exit code of its own (publish-prepare.sh's SR-3.2), with its continuation
 * lines: each following comment line whose first word is neither a number nor
 * `--`.
 *
 * Pure: reads nothing, writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

/** `text` without its comment lines (the shebang included). */
export function shellCode(text: string): string {
  return text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
}

/** The script's leading comment block, the shebang included. */
export function shellHeader(text: string): string {
  const lines = text.split('\n')
  return lines.slice(0, lines.findIndex((line) => !/^\s*#/.test(line))).join('\n')
}

/** The header's numbered exit codes, in order: each entry's code, `--` entries left out. */
export function headerExitCodes(header: string): number[] {
  return [...header.matchAll(/^#\s+(\d+)\s/gm)].map((m) => Number(m[1]))
}

/** One exit-code entry: its code (`null` for `--`) and its lines as written. */
export interface HeaderEntry {
  code: number | null
  text: string
}

/** `value` with every RegExp metacharacter escaped, so a pattern built around it matches it literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every entry of `header` for the SR id `sr` (`'SR-3.2'`), in order. The id
 * is matched as a whole word, so `'SR-2.4'` finds neither `SR-2.4a` nor
 * `SR-2.41`.
 */
export function headerEntries(header: string, sr: string): HeaderEntry[] {
  const entry = new RegExp(`^#\\s+(\\d+|--)\\s+${escapeRegExp(sr)}\\b.*(?:\\n#\\s+(?!\\d|--\\s)\\S.*)*`, 'gm')
  return [...header.matchAll(entry)].map((m) => ({ code: m[1] === '--' ? null : Number(m[1]), text: m[0] }))
}

/** An entry's lines joined into one: each line break, with the next line's `#` and indent, becomes one space. */
export function joinCommentLines(text: string): string {
  return text.replace(/\n#\s+/g, ' ')
}
