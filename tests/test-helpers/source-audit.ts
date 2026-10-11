/**
 * test-helpers/source-audit.ts — Helpers for static audits of source text
 * (tests that cannot import a module, e.g. src/server.ts, whose module-scope
 * startup code must never run in a unit test; b.av2 SR-13.2).
 *
 * Pass every helper comment-stripped code (`stripComments`). The bracket
 * scanners skip string and template literals (templates nested inside
 * `${…}` included), so a bracket or comma inside a string never shifts a
 * match; they do not understand regex literals or type arguments
 * (`<a, b>`), so audit code without them.
 *
 * SPDX-License-Identifier: MIT
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// The lexer behind stripComments, maskLiterals and the bracket scanners
// ---------------------------------------------------------------------------

/** One piece of source text: code, a comment, or the text of a string, template or regex literal. */
interface Segment {
  readonly kind: 'code' | 'comment' | 'literal'
  readonly text: string
}

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_PUNCTUATOR = new Set('(,=:[!&|?{};+-*%<>~^}'.split(''))

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof'])

/** Whether a `/` that follows the code `before` (comments already dropped) starts a regex literal. */
function regexMayStart(before: string): boolean {
  let k = before.length - 1
  while (k >= 0 && /\s/.test(before[k]!)) k--
  if (k < 0) return true
  if (REGEX_AFTER_PUNCTUATOR.has(before[k]!)) return true
  const word = /[\w$]+$/.exec(before.slice(Math.max(0, k - 11), k + 1))?.[0]
  return word !== undefined && REGEX_AFTER_KEYWORD.has(word)
}

/** The offset just past the `'` or `"` string starting at `at`, or undefined when it is not closed on its line. */
function stringEnd(src: string, at: number): number | undefined {
  const quote = src[at]
  for (let i = at + 1; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') i++
    else if (ch === quote) return i + 1
    else if (ch === '\n') return undefined
  }
  return undefined
}

/** The offset just past the regex literal (flags included) starting at `at`, or undefined when none closes on its line. */
function regexEnd(src: string, at: number): number | undefined {
  let inClass = false
  for (let i = at + 1; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') i++
    else if (ch === '\n') return undefined
    else if (inClass) inClass = ch !== ']'
    else if (ch === '[') inClass = true
    else if (ch === '/') {
      let end = i + 1
      while (end < src.length && /[A-Za-z]/.test(src[end]!)) end++
      return end
    }
  }
  return undefined
}

/** How many characters of the code before a `/` `regexMayStart` needs (the longest keyword, with room for spaces). */
const REGEX_LOOKBEHIND = 32

/**
 * Lexes `src` from `at` as code, appending to `out`, until its end or, when
 * `inSubstitution`, until the `}` that closes a template's `${`. Returns the
 * offset where it stopped (that `}` itself is not consumed).
 */
function lexCode(src: string, at: number, inSubstitution: boolean, out: Segment[]): number {
  let code = ''
  let depth = 0
  let before = '' // the tail of the code and literal text lexed at this level before `code`, to decide a `/`
  const push = (kind: Segment['kind'], text: string): void => {
    if (code !== '') out.push({ kind: 'code', text: code })
    if (kind !== 'comment') before = (before + code + text).slice(-REGEX_LOOKBEHIND)
    else before = (before + code).slice(-REGEX_LOOKBEHIND)
    code = ''
    if (text !== '') out.push({ kind, text })
  }
  let i = at
  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]
    let end: number | undefined
    if (ch === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2)
      end = close < 0 ? src.length : next === '/' ? close : close + 2
      push('comment', src.slice(i, end))
    } else if ((ch === '\'' || ch === '"') && (end = stringEnd(src, i)) !== undefined) {
      push('literal', src.slice(i, end))
    } else if (ch === '`') {
      push('literal', '')
      end = lexTemplate(src, i, out).end
      before = (before + '`').slice(-REGEX_LOOKBEHIND)
    } else if (ch === '/' && regexMayStart(before + code.slice(-REGEX_LOOKBEHIND)) && (end = regexEnd(src, i)) !== undefined) {
      push('literal', src.slice(i, end))
    } else {
      if (inSubstitution && ch === '{') depth++
      else if (inSubstitution && ch === '}' && depth-- === 0) break
      code += ch
      end = i + 1
    }
    i = end
  }
  push('code', '')
  return i
}

/**
 * Lexes the template literal starting at `at` (a backtick), appending its
 * text as literal segments and each `${…}` as code, nested templates
 * included. Answers the offset just past its closing backtick (the end of
 * `src` when it never closes) and whether it closed.
 */
function lexTemplate(src: string, at: number, out: Segment[]): { end: number; closed: boolean } {
  let text = '`'
  let i = at + 1
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '\\') {
      text += src.slice(i, i + 2)
      i += 2
    } else if (ch === '`') {
      out.push({ kind: 'literal', text: text + '`' })
      return { end: i + 1, closed: true }
    } else if (ch === '$' && src[i + 1] === '{') {
      out.push({ kind: 'literal', text }, { kind: 'code', text: '${' })
      text = ''
      i = lexCode(src, i + 2, true, out)
      if (i < src.length) {
        out.push({ kind: 'code', text: '}' })
        i++
      }
    } else {
      text += ch
      i++
    }
  }
  out.push({ kind: 'literal', text })
  return { end: src.length, closed: false }
}

/** `src` as segments: code, comments, and string, template and regex literal text. */
function lex(src: string): Segment[] {
  const out: Segment[] = []
  lexCode(src, 0, false, out)
  return out
}

/**
 * `source` with every comment removed: block comments (JSDoc included) and
 * line comments, whole-line or trailing. String, template and regex literals
 * are lexed and kept, templates nested inside `${…}` and quotes or backticks
 * inside a regex literal included, so a `//` or `/*` inside a literal is not
 * taken for a comment and a quote inside one never shifts what follows.
 * Prose or commented-out code that names a function (e.g. "BEFORE
 * startupSessionManager", `// await reconcileOrphans(personaConfig)`) can then
 * never satisfy or skew a code-position assertion.
 */
export function stripComments(source: string): string {
  return lex(source)
    .filter((s) => s.kind !== 'comment')
    .map((s) => s.text)
    .join('')
}

/**
 * `code` (comment-stripped, see `stripComments`) with the text of every
 * string, template and regex literal, quotes included, replaced by spaces
 * (newlines kept), so offsets match `code`. Code inside a template's `${…}`
 * stays. Search it for code positions (a call, an identifier) that text in a
 * literal must never satisfy, then read the call from `code` at that offset.
 */
export function maskLiterals(code: string): string {
  return lex(code)
    .map((s) => (s.kind === 'code' ? s.text : s.text.replace(/[^\n]/g, ' ')))
    .join('')
}

/** Start offsets of every match of the global regex `re` in `text`. */
export function indicesOf(re: RegExp, text: string): number[] {
  return [...text.matchAll(re)].map((m) => m.index ?? -1)
}

/**
 * The offset just past the string or template literal starting at `at`
 * (templates nested inside `${…}` included), or `at` when none starts there
 * or it never closes.
 */
function skipLiteral(text: string, at: number): number {
  const ch = text[at]
  if (ch === '\'' || ch === '"') return stringEnd(text, at) ?? at
  if (ch !== '`') return at
  const { end, closed } = lexTemplate(text, at, [])
  return closed ? end : at
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
 * `clientFor` maps to `clientFor`. Throws on a duplicate name.
 *
 * A spread of a bare name (`...gate`) is resolved through `spread`, which
 * answers the text of the object literal that name holds (its first `{`
 * starts it); its properties are read the same way (spreads in it included)
 * and merged in, and a name given both by a spread and by the literal itself
 * (an override) is a duplicate, so it throws. Without `spread`, any spread
 * throws, as does a spread of anything other than a bare name.
 */
export function objectProperties(text: string, spread?: (name: string) => string): Map<string, string> {
  const props = new Map<string, string>()
  const add = (name: string, value: string): void => {
    if (props.has(name)) throw new Error(`source-audit: duplicate property ${name}`)
    props.set(name, value)
  }
  for (const part of splitTopLevel(text.slice(...balancedAfter(text, 0, '{', '}')))) {
    const spreadOf = part.match(/^\.\.\.\s*([A-Za-z_$][\w$]*)$/)
    if (spreadOf && spread) {
      for (const [name, value] of objectProperties(spread(spreadOf[1]!), spread)) add(name, value)
      continue
    }
    const m = part.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/)
    if (!m) throw new Error(`source-audit: not a plain property: ${part.slice(0, 40)}`)
    add(m[1]!, m[2] ?? m[1]!)
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

/**
 * [start, end) of the body of `async function shutdown(…)` in `code`, both
 * braces excluded. Throws when there is no such declaration.
 */
export function shutdownBody(code: string): [number, number] {
  const decl = code.search(/\basync\s+function\s+shutdown\s*\(/)
  if (decl < 0) throw new Error('source-audit: no `async function shutdown(`')
  return balancedAfter(code, code.indexOf(')', decl), '{', '}')
}

/** Whether `offset` lies inside main()'s body in `code` (see `mainBody`). */
export function insideMain(code: string, offset: number): boolean {
  const [start, end] = mainBody(code)
  return offset > start && offset < end
}

/**
 * Whether a statement starting at `offset` sits in main()'s own statement
 * list in `code`: inside main(), inside no nested block, call, array or
 * literal, and not the brace-less body of an `if`, `else`, `while` or `for`
 * (so it runs on every pass through main(), not behind a branch).
 */
export function atMainTopLevel(code: string, offset: number): boolean {
  const [start, end] = mainBody(code)
  if (offset <= start || offset >= end) return false
  let depth = 0
  let last = -1 // offset of the last code (non-space, non-literal) character before `offset`
  for (let i = start; i < offset; i++) {
    const past = skipLiteral(code, i)
    if (past !== i) {
      if (past > offset) return false // `offset` lies inside a literal
      last = past - 1
      i = past - 1
      continue
    }
    const ch = code[i]!
    if (ch in OPENERS) depth++
    else if (CLOSERS.has(ch)) depth--
    if (!/\s/.test(ch)) last = i
  }
  if (depth !== 0) return false
  const before = code.slice(start, last + 1)
  if (/\belse$/.test(before)) return false
  if (code[last] !== ')') return true
  // The statement follows a `)`: refuse it when that closes a branch or loop header.
  for (const header of indicesOf(/\b(?:if|while|for)\s*\(/g, code.slice(0, last))) {
    if (header < start) continue
    if (balancedAfter(code, header, '(', ')')[1] === last) return false
  }
  return true
}

/**
 * The module `name` is imported from in `code` (a named import, `name` or
 * `x as name`, type-only imports excluded), or undefined when no import
 * binds it. Throws when more than one import binds it.
 */
export function importSource(code: string, name: string): string | undefined {
  const sources: string[] = []
  for (const m of code.matchAll(/\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\3/g)) {
    if (m[1]) continue
    for (const spec of splitTopLevel(m[2]!)) {
      if (/^type\s/.test(spec)) continue
      const bound = spec.match(/^(?:[\w$]+\s+as\s+)?([\w$]+)$/)
      if (bound?.[1] === name) sources.push(m[4]!)
    }
  }
  if (sources.length > 1) throw new Error(`source-audit: ${name} is imported ${sources.length} times`)
  return sources[0]
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

// ---------------------------------------------------------------------------
// Runtime import walk over src/ (what a module loads, directly or transitively)
// ---------------------------------------------------------------------------

/** The repository's `src/` directory. */
const SRC_DIR = join(import.meta.dir, '..', '..', 'src')

/** Every `src/` module's comment-stripped code, by file name. */
export function srcModules(): Map<string, string> {
  const modules = new Map<string, string>()
  for (const name of readdirSync(SRC_DIR).filter((n) => n.endsWith('.ts')).sort()) {
    modules.set(name, stripComments(readFileSync(join(SRC_DIR, name), 'utf-8')))
  }
  return modules
}

/** The module specifiers `code` imports or re-exports, static or dynamic. */
export function importedSpecifiers(code: string): string[] {
  const patterns = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]/g, /\brequire\s*\(\s*['"]([^'"]+)['"]/g]
  return patterns.flatMap((re) => [...code.matchAll(re)].map((m) => m[1]!))
}

/** A type-only import or re-export (`import type …`, `export type …`): erased at build, it loads nothing. */
const TYPE_ONLY_FROM = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s*from\s*['"]([^'"]+)['"]/g

/**
 * The specifiers `code` loads at run time: every one `importedSpecifiers`
 * finds, less one per type-only import or re-export. An import whose names
 * are each marked `type` (`import { type A } from …`) still counts: only the
 * whole-statement forms are excluded.
 */
export function runtimeSpecifiers(code: string): string[] {
  const specifiers = importedSpecifiers(code)
  for (const m of code.matchAll(TYPE_ONLY_FROM)) {
    const at = specifiers.indexOf(m[1]!)
    if (at < 0) throw new Error(`type-only import of ${m[1]} not among the specifiers`)
    specifiers.splice(at, 1)
  }
  return specifiers
}

/** What a module loads at run time: each module reached with the import chain that reaches it, and each package or builtin imported on the way. */
export interface RuntimeLoads {
  readonly modules: Map<string, string[]>
  readonly packages: { readonly chain: string[]; readonly specifier: string }[]
}

/**
 * Follows `entry`'s runtime imports through `modules` (file name → code),
 * transitively. Throws on a relative specifier that names no module in
 * `modules`, so an import the walk cannot follow fails the audit instead of
 * being skipped.
 */
export function runtimeLoads(modules: Map<string, string>, entry: string): RuntimeLoads {
  const reached = new Map<string, string[]>([[entry, [entry]]])
  const packages: { chain: string[]; specifier: string }[] = []
  const queue = [entry]
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const chain = reached.get(name)!
    for (const specifier of runtimeSpecifiers(modules.get(name)!)) {
      if (!specifier.startsWith('.')) {
        packages.push({ chain, specifier })
        continue
      }
      const target = specifier.replace(/^\.\//, '')
      if (!modules.has(target)) throw new Error(`${name} imports ${specifier}, which is no src/ module`)
      if (reached.has(target)) continue
      reached.set(target, [...chain, target])
      queue.push(target)
    }
  }
  return { modules: reached, packages }
}

/**
 * Server-only `src/` modules: the notifier, outage state, the latch, the
 * episodes, the server, the session manager and restart. A module the CLI
 * reuses (`checked-kill.ts`, `kill-retry.ts`, `kill-failure-alert.ts`) loads
 * none of them.
 */
export const SERVER_ONLY_MODULES = /^(?:outage-state|conflict-latch|persona-episodes|server|session-manager|restart)\.ts$|notifier/

/**
 * What `entry` (a `src/` file name) loads at run time, and each forbidden
 * load among it as its import chain (`a.ts -> b.ts`): a server-only module
 * (`SERVER_ONLY_MODULES`), a Slack module (one whose name has `slack` and
 * that imports anything) or an `@slack/` package. A case asserts `forbidden`
 * is empty and, so the walk is not vacuous, that `loads` reaches a module it
 * names.
 */
export function forbiddenServerLoads(entry: string): { loads: RuntimeLoads; forbidden: string[] } {
  const modules = srcModules()
  const loads = runtimeLoads(modules, entry)
  const forbidden = [
    ...[...loads.modules]
      .filter(([name]) => SERVER_ONLY_MODULES.test(name) || (/slack/i.test(name) && importedSpecifiers(modules.get(name)!).length > 0))
      .map(([, chain]) => chain.join(' -> ')),
    ...loads.packages.filter(({ specifier }) => specifier.startsWith('@slack/')).map(({ chain, specifier }) => `${chain.join(' -> ')} -> ${specifier}`),
  ]
  return { loads, forbidden }
}

// ---------------------------------------------------------------------------
// The word rules of the one source audit (tests/fmk-source-audit.test.ts)
// ---------------------------------------------------------------------------

/** The row-delete helpers (b.jg5 SRJ-716) and the `src/cli.ts` audit's delete verbs (`directorDelete`, `deleteSpawn`). */
export const DELETE_HELPERS: readonly string[] = ['deleteInstance', 'deleteInstanceRow', 'deletePersonaInstance', 'tryDelete', 'killAndDeleteSweptRow', 'directorDelete', 'deleteSpawn']

/** b.jg5 SRJ-601's removed identifiers, E17 T1's focused approver-seam names and E22 T4's ladder kill clock seam. */
export const REMOVED_IDENTIFIERS: readonly string[] = [
  // The raw runner.
  'defaultRunTmux', '_runTmux', '_setTmuxCommandRunner', '_resetTmuxCommandRunner', 'TmuxCommandRunner', 'TmuxRunResult',
  // The tmux server start.
  'defaultEnsureTmuxServer', '_ensureTmuxServer', '_setTmuxServerEnsurer', '_resetTmuxServerEnsurer',
  // The liveness probe.
  'defaultHasTmuxSession', '_hasTmuxSession', '_setTmuxSessionProber', '_resetTmuxSessionProber', 'hasPersonaTmuxSession', 'tmuxFallbackVerdict',
  // The approver's raw path.
  'defaultTmuxCapturePane', 'defaultTmuxSendEnter', '_setTmuxCapturePane', '_setTmuxSendEnter', '_resetTmuxDialogHelpers', 'tmuxExactPaneTarget',
  // E17 T1: the pane reader and Enter sender types, the dead-state streak and its seams, the poll-interval seams and the state sets.
  'TmuxPaneReader', 'TmuxEnterSender', 'DIALOG_DEAD_GRACE_POLLS', '_setDialogDeadGracePolls', '_resetDialogDeadGracePolls',
  '_setDialogPollIntervalMs', '_resetDialogPollIntervalMs', 'DIALOG_READY_STATES', 'DIALOG_DEAD_STATES',
  // The b.vub self-heal.
  'defaultKillTmuxSession', '_setTmuxSessionKiller', '_resetTmuxSessionKiller', 'selfHealTmuxCollisionAndRespawn',
  // E22 T4: the ladder's kill clock seam.
  '_ladderKillClock', '_setLadderKillClock', '_resetLadderKillClock',
]

/** A whole identifier from `names`, as a global RegExp. */
export function wholeWord(names: readonly string[]): RegExp {
  return new RegExp(`(?<![\\w$])(?:${names.join('|')})(?![\\w$])`, 'g')
}

/** The source audit's rules that match a word in code or in a string. */
export type SourceWordRule = 'delete-helper' | 'finished-row-option' | 'ad-label' | 'raw-tmux-subcommand' | 'removed-identifier'

/**
 * The source audit's word rules, each a global RegExp: the row-delete helpers,
 * agent-director's finished-row option in both spellings (b.jg5 SRJ-106), its
 * labels (SRJ-612), the raw tmux kill, probe and server start (SRJ-1101) and
 * the removed identifiers (SRJ-601). tests/fmk-source-audit.test.ts runs them
 * over every `src/` file; tests/shipped-docs.test.ts reads some of them over
 * the architecture doc and the engineering guide (SRJ-1105, SRJ-1106).
 */
export const SOURCE_WORD_RULES: ReadonlyArray<readonly [SourceWordRule, RegExp]> = [
  ['delete-helper', wholeWord(DELETE_HELPERS)],
  ['finished-row-option', /include_finished|include-finished/g],
  ['ad-label', /ad_owner|ad_pane/g],
  ['raw-tmux-subcommand', /kill-session|has-session|start-server/g],
  ['removed-identifier', wholeWord(REMOVED_IDENTIFIERS)],
]
