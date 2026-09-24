/**
 * test-helpers/source-audit.ts — Helpers for static audits of source text
 * (tests that cannot import a module, e.g. src/server.ts, whose module-scope
 * startup code must never run in a unit test; b.av2 SR-13.2).
 *
 * Pass every helper comment-stripped code (`stripComments`). The bracket
 * scanners skip string and template literals, so a bracket or comma inside a
 * string never shifts a match; they do not understand regex literals or type
 * arguments (`<a, b>`), so audit code without them.
 *
 * SPDX-License-Identifier: MIT
 */

/** A string or template literal (the same shapes `stripComments` keeps). */
const LITERAL = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/y

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

/** The offset just past the string or template literal starting at `at`, or `at` when none starts there. */
function skipLiteral(text: string, at: number): number {
  LITERAL.lastIndex = at
  return LITERAL.test(text) ? LITERAL.lastIndex : at
}

const OPENERS: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
const CLOSERS = new Set(Object.values(OPENERS))

/**
 * In `text`, from the first `open` at or after `at` to its matching `close`,
 * as [start, end) with both brackets excluded. Throws when there is no `open`
 * or it is never closed.
 */
export function balancedAfter(text: string, at: number, open: string, close: string): [number, number] {
  const start = text.indexOf(open, at)
  if (start < 0) throw new Error(`source-audit: no ${open} after offset ${at}`)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const past = skipLiteral(text, i)
    if (past !== i) {
      i = past - 1
      continue
    }
    if (text[i] === open) depth++
    else if (text[i] === close && --depth === 0) return [start + 1, i]
  }
  throw new Error(`source-audit: unbalanced ${open}${close} after offset ${at}`)
}

/** The argument text of the call whose name starts at `at`: from its `(` to the matching `)`, both excluded. */
export function callArguments(code: string, at: number): string {
  return code.slice(...balancedAfter(code, at, '(', ')'))
}

/** Offsets of every call of the plain function `name` in `code` (`name(`, never a method call `x.name(`). */
export function callsOf(code: string, name: string): number[] {
  return indicesOf(new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g'), code)
}

/** The argument text of the only call of `name` in `code`; throws unless there is exactly one. */
export function onlyCallArguments(code: string, name: string): string {
  const calls = callsOf(code, name)
  if (calls.length !== 1) throw new Error(`source-audit: expected exactly one call of ${name}, found ${calls.length}`)
  return callArguments(code, calls[0]!)
}

/**
 * `list` split at its top-level commas (none inside brackets or literals),
 * each part trimmed with its whitespace collapsed to single spaces; empty
 * parts (a trailing comma) are dropped. Use it on call arguments or on an
 * object literal's body.
 */
export function splitTopLevel(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < list.length; i++) {
    const past = skipLiteral(list, i)
    if (past !== i) {
      i = past - 1
      continue
    }
    const ch = list[i]!
    if (ch in OPENERS) depth++
    else if (CLOSERS.has(ch)) depth--
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(from, i))
      from = i + 1
    }
  }
  parts.push(list.slice(from))
  return parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p !== '')
}

/**
 * The top-level properties of the object literal that starts at the first `{`
 * in `text`: name → value text (whitespace collapsed). A shorthand property
 * `clientFor` maps to `clientFor`. Throws on a spread or a duplicate name.
 */
export function objectProperties(text: string): Map<string, string> {
  const props = new Map<string, string>()
  for (const part of splitTopLevel(text.slice(...balancedAfter(text, 0, '{', '}')))) {
    const m = part.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/)
    if (!m) throw new Error(`source-audit: not a plain property: ${part.slice(0, 40)}`)
    if (props.has(m[1]!)) throw new Error(`source-audit: duplicate property ${m[1]}`)
    props.set(m[1]!, m[2] ?? m[1]!)
  }
  return props
}

/**
 * The variable the persona loader's result is assigned to in `code`
 * (`<name> = loadStartPersonaConfig(`); throws unless there is exactly one
 * such assignment.
 */
export function loadedConfigName(code: string): string {
  const loads = [...code.matchAll(/\b(\w+)\s*=\s*loadStartPersonaConfig\s*\(/g)]
  if (loads.length !== 1) throw new Error(`source-audit: expected one loadStartPersonaConfig assignment, found ${loads.length}`)
  return loads[0]![1]!
}
