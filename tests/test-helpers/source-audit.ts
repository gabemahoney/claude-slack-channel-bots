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
 * [start, end) of the body of `export async function main()` in `code`, both
 * braces excluded. Throws when there is no such declaration.
 */
export function mainBody(code: string): [number, number] {
  const decl = code.search(/\bexport\s+async\s+function\s+main\s*\(\s*\)/)
  if (decl < 0) throw new Error('source-audit: no `export async function main()`')
  return balancedAfter(code, code.indexOf(')', decl), '{', '}')
}

/** Whether `offset` lies inside main()'s body in `code` (see `mainBody`). */
export function insideMain(code: string, offset: number): boolean {
  const [start, end] = mainBody(code)
  return offset > start && offset < end
}

/** The only match of the global regex `re` in `code`; throws naming `what` unless there is exactly one. */
function onlyMatch(code: string, re: RegExp, what: string): RegExpMatchArray {
  const matches = [...code.matchAll(re)]
  if (matches.length !== 1) throw new Error(`source-audit: expected exactly one ${what}, found ${matches.length}`)
  return matches[0]!
}

/** How `main()` resolves the start through the reload controller (see `startResolution`). */
export interface StartResolution {
  /** The controller's `const` name. */
  controller: string
  /** The start outcome's `const` name. */
  outcome: string
  /** The variable the applied config is assigned to (the loaded config every start pass reads). */
  loaded: string
  /** Offset of the `createReloadController(` call. */
  createAt: number
  /** Offset of the `resolveStart(` call. */
  resolveAt: number
  /** Offset of the `<loaded> = <outcome>.config` assignment. */
  assignAt: number
  /** Offset of the start bring-up invocation `<controller>.runStartBringUp(`. */
  bringUpAt: number
}

/**
 * How `main()` resolves the start through the reload controller (b.av2
 * SR-8.7), as read from `code`:
 *
 *     const <controller> = createReloadController({ … })
 *     const <outcome> = <controller>.resolveStart()
 *     <loaded> = <outcome>.config
 *     …
 *     <controller>.runStartBringUp()
 *
 * It only locates these: it throws when one of them is missing or ambiguous
 * (one `createReloadController(` declaration, one `resolveStart(` call on that
 * controller bound to a `const`, one assignment from `<outcome>.config` after
 * it, one `runStartBringUp(` call on that controller). What else assigns
 * `<loaded>` (a later confirmed apply, E12/E13) is not its concern; the one
 * test that owns the start's assignment rule is in
 * tests/server-startup-wiring.test.ts.
 */
export function startResolution(code: string): StartResolution {
  const create = onlyMatch(code, /\bconst\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*(createReloadController)\s*\(/g, 'createReloadController declaration')
  const controller = create[1]!
  const createAt = create.index! + create[0].lastIndexOf(create[2]!)
  onlyMatch(code, /\bresolveStart\s*\(/g, 'resolveStart call')
  const resolve = onlyMatch(code, new RegExp(`\\bconst\\s+(\\w+)\\s*=\\s*${controller}\\s*\\.\\s*(resolveStart)\\s*\\(\\s*\\)`, 'g'), `const <outcome> = ${controller}.resolveStart()`)
  const outcome = resolve[1]!
  const resolveAt = resolve.index! + resolve[0].lastIndexOf(resolve[2]!)
  const assign = onlyMatch(code, new RegExp(`(?<![\\w.$])(\\w+)\\s*=\\s*${outcome}\\s*\\.\\s*config\\b`, 'g'), `assignment from ${outcome}.config`)
  const loaded = assign[1]!
  const assignAt = assign.index!
  if (assignAt < resolveAt) throw new Error(`source-audit: ${loaded} is assigned from ${outcome}.config before the start is resolved`)
  onlyMatch(code, /\brunStartBringUp\s*\(/g, 'runStartBringUp call')
  const bringUp = onlyMatch(code, new RegExp(`\\b${controller}\\s*\\.\\s*(runStartBringUp)\\s*\\(`, 'g'), `${controller}.runStartBringUp() call`)
  const bringUpAt = bringUp.index! + bringUp[0].lastIndexOf(bringUp[1]!)
  return { controller, outcome, loaded, createAt, resolveAt, assignAt, bringUpAt }
}

/**
 * The variable `main()` sets to the applied persona config: the one
 * `<name> = <outcome>.config` after `<outcome> = <controller>.resolveStart()`
 * (see `startResolution`).
 */
export function loadedConfigName(code: string): string {
  return startResolution(code).loaded
}
