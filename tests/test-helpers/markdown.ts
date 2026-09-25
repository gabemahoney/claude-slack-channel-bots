/**
 * markdown.ts — fence-aware Markdown reading for the tests that audit shipped
 * docs and skills (shipped-docs, setup-wizard-skill, install-cscb-skill,
 * access-file-retired).
 *
 * A heading is a line of `#`–`######`, whitespace and its title, at the start
 * of the line and outside any fenced code block. A fence opens at a line whose
 * first non-blank characters are three or more backticks (with no backtick
 * after them on the line) or tildes, and closes
 * at a line holding only a run of the same character at least as long. So a
 * `# comment` in a shell block is never a heading, and a ``` line inside a ~~~
 * block does not end it. A fence left open runs to the end of the text.
 *
 * A heading is named as written, `'## Title'` (exact match), or by a RegExp
 * tested against that same `'## Title'` form, so the level is part of the
 * match (`/^### .*\bAdd a persona$/`). Don't pass a `g` or `y` RegExp: `test`
 * would carry `lastIndex` from one heading to the next. A section runs from
 * its heading to the next heading of the same or a higher level (fewer `#`).
 *
 * Pure: reads nothing, writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

/** A heading outside fenced code: its 0-based line index, level, title and `'## Title'` form. */
export interface Heading {
  line: number
  level: number
  title: string
  text: string
}

/** A heading named as written (`'## Title'`) or by a RegExp over that form. */
export type HeadingMatch = string | RegExp

/** One line of Markdown, classified: prose, or a fence's opening line, body line or closing line. */
type ScannedLine =
  | { kind: 'prose'; line: string }
  | { kind: 'open'; line: string; info: string }
  | { kind: 'body'; line: string }
  | { kind: 'close'; line: string }

/** Classify each line of `text` (see the header for the fence rules). */
function scanLines(text: string): ScannedLine[] {
  const out: ScannedLine[] = []
  let marker: string | null = null
  for (const line of text.split('\n')) {
    if (marker !== null) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1]
      if (close !== undefined && close[0] === marker[0] && close.length >= marker.length) {
        marker = null
        out.push({ kind: 'close', line })
      } else {
        out.push({ kind: 'body', line })
      }
      continue
    }
    // A backtick fence's info string holds no backtick (CommonMark), so ```x``` is inline code, not a fence.
    const open = /^[ \t]*(`{3,}(?=[^`]*$)|~{3,})[ \t]*([^\s`]*)/.exec(line)
    if (open) {
      marker = open[1]
      out.push({ kind: 'open', line, info: open[2] })
    } else {
      out.push({ kind: 'prose', line })
    }
  }
  return out
}

/** Every heading outside fenced code, in order. */
export function headings(text: string): Heading[] {
  return scanLines(text).flatMap((scanned, i) => {
    if (scanned.kind !== 'prose') return []
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(scanned.line)
    return m ? [{ line: i, level: m[1].length, title: m[2], text: `${m[1]} ${m[2]}` }] : []
  })
}

function matches(heading: Heading, match: HeadingMatch): boolean {
  return typeof match === 'string' ? heading.text === match : match.test(heading.text)
}

/**
 * The 0-based line range `[start, end)` of the first section whose heading
 * matches `match`: `start` is the heading line, `end` the line of the next
 * heading of the same or a higher level, or the line count. Undefined when no
 * heading matches.
 */
export function sectionRange(text: string, match: HeadingMatch): { start: number; end: number } | undefined {
  const hs = headings(text)
  const i = hs.findIndex((h) => matches(h, match))
  if (i < 0) return undefined
  const next = hs.slice(i + 1).find((h) => h.level <= hs[i].level)
  return { start: hs[i].line, end: next === undefined ? text.split('\n').length : next.line }
}

/** The body of the first section whose heading matches `match`, heading line excluded; undefined when none does. */
export function findSection(text: string, match: HeadingMatch): string | undefined {
  const range = sectionRange(text, match)
  return range === undefined ? undefined : text.split('\n').slice(range.start + 1, range.end).join('\n')
}

/**
 * `findSection`, throwing `<file> has no heading "<heading>"` (or `… matching
 * /re/`) when no heading matches, so a check on a moved or renamed section
 * fails naming it rather than running on an empty string. `file` says where
 * the text came from; for a nested section, name the parent too
 * (`README.md, under "### Personas (config.json)",`).
 */
export function requiredSection(text: string, match: HeadingMatch, file: string): string {
  const section = findSection(text, match)
  if (section === undefined) {
    throw new Error(`${file} has no heading ${typeof match === 'string' ? `"${match}"` : `matching ${String(match)}`}`)
  }
  return section
}

/**
 * `text` split into its prose (every line outside a fenced code block, joined
 * by newlines) and its fenced blocks in order, each with its info string's
 * first word (`json`; '' when untagged) and its body lines exactly as written.
 * A block left open runs to the end of the text.
 */
export function splitFences(text: string): { prose: string; blocks: { info: string; body: string }[] } {
  const prose: string[] = []
  const blocks: { info: string; body: string }[] = []
  let open: { info: string; body: string[] } | null = null
  for (const scanned of scanLines(text)) {
    if (scanned.kind === 'prose') prose.push(scanned.line)
    else if (scanned.kind === 'open') open = { info: scanned.info, body: [] }
    else if (scanned.kind === 'body') open?.body.push(scanned.line)
    else if (open !== null) {
      blocks.push({ info: open.info, body: open.body.join('\n') })
      open = null
    }
  }
  if (open !== null) blocks.push({ info: open.info, body: open.body.join('\n') })
  return { prose: prose.join('\n'), blocks }
}

/**
 * A heading title's GitHub anchor: lower-cased, every character but letters,
 * digits, spaces, `_` and `-` dropped, each space a hyphen
 * (`Rotate a persona's tokens` → `rotate-a-personas-tokens`).
 */
export function headingSlug(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

/**
 * The anchor of every heading in `text`, in order, as GitHub assigns them: a
 * repeated slug gets `-1`, `-2`, … on its second, third, … occurrence.
 */
export function headingAnchors(text: string): string[] {
  const seen = new Map<string, number>()
  return headings(text).map((h) => {
    const slug = headingSlug(h.title)
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    return count === 0 ? slug : `${slug}-${count}`
  })
}

/** `text` with every run of whitespace collapsed to one space, so a phrase matches across a line wrap. */
export function flat(text: string): string {
  return text.replace(/\s+/g, ' ')
}
