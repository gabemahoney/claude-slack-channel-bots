/**
 * fmk-texts-entries.test.ts — Every `src/` export the fmk scenarios' value
 * printer (`tests/integration/fixtures/fmk-texts.ts`, b.jg5 SRJ-1401) names
 * exists in `src/` with the kind the printer reads it as, so a renamed,
 * removed or retyped export fails on the host, before `/ci` runs a scenario.
 *
 * The printer refuses to run without the cscb-ci image marker, so it is never
 * imported or run here: `printerRefs` reads its text with the TypeScript
 * parser and lists each export it names, as (file under `src/`, export, kind):
 *
 * - each `constantEntry('<file>', '<NAME>')`: a constant (a string, or a
 *   finite number);
 * - each `constantEntries('<file>', <LIST>)`: a constant for every name of
 *   the top-level string list `<LIST>` (`LATCH_CONSTANT_NAMES` and
 *   `CASE_PHRASE_NAMES` among them);
 * - each `packageFunction(context, '<file>', <name>)`: a function (a builder,
 *   or a class the printer constructs); `packageString(…)`: a string;
 *   `packageExport(…)`: any defined value;
 * - each `latchStrings(context, <name>)`: an array of strings in
 *   `conflict-latch.ts`; each `adSettingsDefaultMs(<name>)`: a function in
 *   `ad-settings.ts`; each `builderEntry('<file>', '<name>', …)`: a function.
 *
 * A `<name>` is a string literal, or an identifier bound to one by a `const`
 * in an enclosing scope (an entry's `const entry = '<export>'`, a top-level
 * constant). Some names are chosen at run time from a top-level collection
 * (`CHOSEN_FROM`), and stand for every value of it; a few are a script's
 * argument the printer checks only for a prefix (`CHOSEN_BY_PREFIX`), and the
 * module must export at least one name with that prefix, of the kind read. A call inside a helper's
 * own body that passes that helper's parameter on is the helper forwarding
 * its caller's name, and its callers are read instead. Any other name the
 * reader cannot resolve is a finding, so a new form of reference in the
 * printer fails here until this file learns it. Only the printer's shared
 * table's forms are read: the fixed-argument and one-function tables
 * (`ARGS_ENTRIES`, `FN_ENTRIES`) load their exports through their own helpers,
 * which this reader does not follow.
 *
 * The reader is pinned with synthetic sources, then run over the printer;
 * each export it lists is looked up in the `src/` modules this file imports
 * (`MODULES`), so a file the printer names that is not imported here fails
 * too. It imports `src/` modules the secrecy audit counts as secret-bearing,
 * so what it reads and reports (the reading, the text exports it looks up,
 * every kind mismatch) is passed through `assertNoLeak`. This file starts no
 * process and writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import * as adDescriptionPhrases from '../src/ad-description-phrases.ts'
import * as adErrorClass from '../src/ad-error-class.ts'
import * as adSettings from '../src/ad-settings.ts'
import * as adVersionGate from '../src/ad-version-gate.ts'
import * as backoff from '../src/backoff.ts'
import * as config from '../src/config.ts'
import * as conflictLatch from '../src/conflict-latch.ts'
import * as installCheckLabels from '../src/install-check-labels.ts'
import * as invalidFlagsHold from '../src/invalid-flags-hold.ts'
import * as livenessReading from '../src/liveness-reading.ts'
import * as outageState from '../src/outage-state.ts'
import * as paneRead from '../src/pane-read.ts'
import * as personaEpisodes from '../src/persona-episodes.ts'
import * as personaIdentity from '../src/persona-identity.ts'
import * as personaNotifier from '../src/persona-notifier.ts'
import * as restart from '../src/restart.ts'
import * as rowReadRules from '../src/row-read-rules.ts'
import * as sessionManager from '../src/session-manager.ts'
import * as unavailableRetry from '../src/unavailable-retry.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

const REPO_ROOT = join(import.meta.dir, '..')
const SRC_DIR = join(REPO_ROOT, 'src')
const PRINTER_PATH = join(REPO_ROOT, 'tests', 'integration', 'fixtures', 'fmk-texts.ts')

/** The `src/` modules the printer reads, by the file name it passes. */
const MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'ad-description-phrases.ts': adDescriptionPhrases,
  'ad-error-class.ts': adErrorClass,
  'ad-settings.ts': adSettings,
  'ad-version-gate.ts': adVersionGate,
  'backoff.ts': backoff,
  'config.ts': config,
  'conflict-latch.ts': conflictLatch,
  'install-check-labels.ts': installCheckLabels,
  'invalid-flags-hold.ts': invalidFlagsHold,
  'liveness-reading.ts': livenessReading,
  'outage-state.ts': outageState,
  'pane-read.ts': paneRead,
  'persona-episodes.ts': personaEpisodes,
  'persona-identity.ts': personaIdentity,
  'persona-notifier.ts': personaNotifier,
  'restart.ts': restart,
  'row-read-rules.ts': rowReadRules,
  'session-manager.ts': sessionManager,
  'unavailable-retry.ts': unavailableRetry,
}

/** What the printer requires an export to be. */
type ExportKind = 'constant' | 'string' | 'function' | 'defined' | 'string-array'

/** One export the printer names. */
interface PrinterRef {
  readonly file: string
  readonly name: string
  readonly kind: ExportKind
  /** The printer's line the reference is read from (1-based). */
  readonly line: number
}

/** How a printer helper names an export: the argument that holds the file (or a fixed file), the one that holds the name, and the kind. */
interface Helper {
  readonly fileArg?: number
  readonly fixedFile?: string
  readonly nameArg: number
  readonly kind: ExportKind
}

/** The printer's helpers that name an export, by function name. */
const HELPERS: Readonly<Record<string, Helper>> = {
  constantEntry: { fileArg: 0, nameArg: 1, kind: 'constant' },
  packageFunction: { fileArg: 1, nameArg: 2, kind: 'function' },
  packageString: { fileArg: 1, nameArg: 2, kind: 'string' },
  packageExport: { fileArg: 1, nameArg: 2, kind: 'defined' },
  latchStrings: { fixedFile: 'conflict-latch.ts', nameArg: 1, kind: 'string-array' },
  adSettingsDefaultMs: { fixedFile: 'ad-settings.ts', nameArg: 0, kind: 'function' },
  builderEntry: { fileArg: 0, nameArg: 1, kind: 'function' },
}

/** The helper naming a constant for every name of a top-level list: `constantEntries('<file>', <LIST>)`. */
const LIST_HELPER = 'constantEntries'

/**
 * The names the printer chooses at run time, by `<owner>:<identifier>` (the
 * owner the top-level function or constant the reference is in), each
 * standing for every value of the top-level collection given.
 */
const CHOSEN_FROM: Readonly<Record<string, string>> = {
  'recoveryReasonArgument:name': 'RECOVERY_REASON_EXPORTS',
  'belowPhase1FloorMessage:foundByExport': 'FOUND_BY_EXPORTS',
  'conflictLatchSetHead:outcomeExport': 'LATCH_SET_OUTCOME_EXPORTS',
}

/**
 * The names the printer takes from a script's argument, checked only for a
 * prefix, by `<owner>:<identifier>`: the module, the prefix the printer
 * requires and the kind it reads. Each must match at least one export of
 * that module of that kind.
 */
const CHOSEN_BY_PREFIX: Readonly<Record<string, { readonly file: string; readonly prefix: string; readonly kind: ExportKind }>> = {
  'relaunchWithoutKill:reasonExport': { file: 'restart.ts', prefix: 'RELAUNCH_NO_KILL_', kind: 'string' },
  'relaunchWithoutKill:readingExport': { file: 'liveness-reading.ts', prefix: 'LIVENESS_READING_DEAD', kind: 'defined' },
}

/** What `printerRefs` reads from a source. */
interface PrinterReading {
  readonly refs: readonly PrinterRef[]
  /** One line per reference it could not resolve: `<line>: <call text>`. */
  readonly unresolved: readonly string[]
  /** The `CHOSEN_FROM` and `CHOSEN_BY_PREFIX` keys it used. */
  readonly chosenUsed: readonly string[]
  /** The top-level string lists and string-valued objects, by name. */
  readonly collections: Readonly<Record<string, readonly string[]>>
}

/** A string literal's text (`'x'` or a template with no substitution); undefined otherwise. */
function literalText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text
  return undefined
}

/** The string values of a top-level `const` initializer: an array of literals, or an object whose values are literals. */
function collectionValues(init: ts.Expression): string[] | undefined {
  if (ts.isArrayLiteralExpression(init)) {
    const values = init.elements.map((e) => literalText(e))
    return values.every((v) => v !== undefined) ? (values as string[]) : undefined
  }
  if (ts.isObjectLiteralExpression(init)) {
    const values = init.properties.map((p) => (ts.isPropertyAssignment(p) ? literalText(p.initializer) : undefined))
    return values.every((v) => v !== undefined) ? (values as string[]) : undefined
  }
  return undefined
}

/** True for a node that declares parameters. */
function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)
}

/** The value of `const <name> = '<literal>'` in the nearest scope around `from` that declares one. */
function constLiteral(from: ts.Node, name: string): string | undefined {
  for (let node: ts.Node | undefined = from; node !== undefined; node = node.parent) {
    if (!ts.isBlock(node) && !ts.isSourceFile(node)) continue
    for (const statement of node.statements) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return literalText(decl.initializer)
      }
    }
  }
  return undefined
}

/** The top-level function declaration around `node`, when there is one. */
function topLevelFunction(node: ts.Node): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && ts.isSourceFile(n.parent)) found = n
  }
  return found
}

/** The name of the top-level function or `const` around `node` (its owner); '' at top level. */
function ownerName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && ts.isSourceFile(n.parent)) return n.name?.text ?? ''
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isSourceFile(n.parent.parent.parent)) return n.name.text
  }
  return ''
}

/** True when `id` is a parameter of a function around it that lies inside a helper's own declaration (the helper passing its caller's name on). */
function isForwardedParameter(id: ts.Identifier): boolean {
  const helper = topLevelFunction(id)
  if (helper === undefined || helper.name === undefined) return false
  if (!Object.hasOwn(HELPERS, helper.name.text) && helper.name.text !== LIST_HELPER) return false
  for (let n: ts.Node | undefined = id.parent; n !== undefined && n !== helper.parent; n = n.parent) {
    if (isFunctionLike(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id.text)) return true
  }
  return false
}

/** Reads the exports a printer source names (see the file header). Pure. */
function printerRefs(source: string): PrinterReading {
  const sf = ts.createSourceFile('fmk-texts.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const collections: Record<string, readonly string[]> = {}
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue
      const values = collectionValues(decl.initializer)
      if (values !== undefined) collections[decl.name.text] = values
    }
  }
  const refs: PrinterRef[] = []
  const unresolved: string[] = []
  const chosenUsed = new Set<string>()
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const miss = (call: ts.CallExpression): void => {
    unresolved.push(`${lineOf(call)}: ${call.getText(sf).replace(/\s+/g, ' ')}`)
  }

  /** The names an argument stands for: [] when it is a forwarded parameter; undefined when it cannot be resolved. */
  const namesOf = (arg: ts.Expression | undefined, call: ts.CallExpression): readonly string[] | undefined => {
    const text = literalText(arg)
    if (text !== undefined) return [text]
    if (arg === undefined || !ts.isIdentifier(arg)) return undefined
    if (isForwardedParameter(arg)) return []
    const bound = constLiteral(call, arg.text)
    if (bound !== undefined) return [bound]
    const key = `${ownerName(call)}:${arg.text}`
    if (Object.hasOwn(CHOSEN_FROM, key) && Object.hasOwn(collections, CHOSEN_FROM[key])) {
      chosenUsed.add(key)
      return collections[CHOSEN_FROM[key]]
    }
    if (Object.hasOwn(CHOSEN_BY_PREFIX, key)) {
      chosenUsed.add(key)
      return []
    }
    return undefined
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      if (callee === LIST_HELPER) {
        const files = namesOf(node.arguments[0], node)
        const list = node.arguments[1]
        const names = list !== undefined && ts.isIdentifier(list) && Object.hasOwn(collections, list.text) ? collections[list.text] : undefined
        if (files === undefined || files.length !== 1 || names === undefined) miss(node)
        else for (const name of names) refs.push({ file: files[0], name, kind: 'constant', line: lineOf(node) })
      } else if (Object.hasOwn(HELPERS, callee)) {
        const helper = HELPERS[callee]
        const files = helper.fixedFile !== undefined ? [helper.fixedFile] : namesOf(node.arguments[helper.fileArg ?? -1], node)
        const names = namesOf(node.arguments[helper.nameArg], node)
        if (files === undefined || names === undefined) miss(node)
        else if (files.length > 0) for (const file of files) for (const name of names) refs.push({ file, name, kind: helper.kind, line: lineOf(node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { refs, unresolved, chosenUsed: [...chosenUsed].sort(), collections }
}

/** Why `value` is not of `kind`; undefined when it is. */
function kindMismatch(value: unknown, kind: ExportKind): string | undefined {
  const found = value === undefined ? 'not exported' : `a ${typeof value}`
  switch (kind) {
    case 'constant':
      return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? undefined : `${found}, not a string or a finite number`
    case 'string':
      return typeof value === 'string' ? undefined : `${found}, not a string`
    case 'function':
      return typeof value === 'function' ? undefined : `${found}, not a function`
    case 'defined':
      return value !== undefined ? undefined : found
    case 'string-array':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? undefined : `${found}, not an array of strings`
  }
}

/** Synthetic printer text: the helpers' declarations (bodies forwarding their parameters, as the printer's do), then `body`. */
function synthetic(...body: string[]): string {
  return [
    'async function packageExport(context, relPath, name) { return (await context.importPackageModule(relPath))[name] }',
    'async function packageFunction(context, relPath, name) { return await packageExport(context, relPath, name) }',
    'function constantEntry(relPath, name) { return { async print(args, context) { return await packageExport(context, relPath, name) } } }',
    'function constantEntries(relPath, names) { return Object.fromEntries(names.map((name) => [name, constantEntry(relPath, name)])) }',
    ...body,
  ].join('\n')
}

describe('printerRefs (synthetic sources)', () => {
  test('reads a constantEntry with literal arguments as a constant, and the helpers forwarding their parameters as nothing', () => {
    const reading = printerRefs(synthetic("const ENTRIES = { A: constantEntry('a.ts', 'A_NAME') }"))
    expect(reading.unresolved).toEqual([])
    expect(reading.refs.map(({ file, name, kind }) => ({ file, name, kind }))).toEqual([{ file: 'a.ts', name: 'A_NAME', kind: 'constant' }])
  })

  test('reads a constantEntries call as a constant for every name of its top-level list', () => {
    const reading = printerRefs(synthetic("const NAMES: readonly string[] = ['X', 'Y']", "const ENTRIES = { ...constantEntries('b.ts', NAMES) }"))
    expect(reading.unresolved).toEqual([])
    expect(reading.refs.map((r) => `${r.file}:${r.name}:${r.kind}`)).toEqual(['b.ts:X:constant', 'b.ts:Y:constant'])
  })

  test("resolves an entry's `const entry = '<export>'` and a top-level constant naming the export", () => {
    const reading = printerRefs(
      synthetic(
        "const TOP = 'topBuilder'",
        "const e: Entry = { async print(args, context) { const entry = 'myBuilder'; return (await packageFunction(context, 'c.ts', entry))(args[0]) } }",
        "async function g(context) { return await packageFunction(context, 'c.ts', TOP) }",
      ),
    )
    expect(reading.unresolved).toEqual([])
    expect(reading.refs.map((r) => `${r.file}:${r.name}:${r.kind}`)).toEqual(['c.ts:myBuilder:function', 'c.ts:topBuilder:function'])
  })

  test('reports a name it cannot resolve, naming its line and call', () => {
    const reading = printerRefs(synthetic('async function h(context, which) { return await packageFunction(context, \'d.ts\', which) }'))
    expect(reading.refs).toEqual([])
    expect(reading.unresolved).toEqual(["5: packageFunction(context, 'd.ts', which)"])
  })

  test("expands a CHOSEN_FROM name to every value of its collection, an object's values included", () => {
    const reading = printerRefs(
      synthetic(
        "const RECOVERY_REASON_EXPORTS: readonly string[] = ['R1', 'R2']",
        "const FOUND_BY_EXPORTS = { startup: 'F1', runtime: 'F2' }",
        "async function recoveryReasonArgument(context, words) { const [name] = words; return await packageExport(context, 'e.ts', name) }",
        "const belowPhase1FloorMessage = { async print(args, context) { const foundByExport = FOUND_BY_EXPORTS[args[0]]; return await packageExport(context, 'e.ts', foundByExport) } }",
      ),
    )
    expect(reading.unresolved).toEqual([])
    expect(reading.chosenUsed).toEqual(['belowPhase1FloorMessage:foundByExport', 'recoveryReasonArgument:name'])
    expect(reading.refs.map((r) => r.name)).toEqual(['R1', 'R2', 'F1', 'F2'])
  })
})

describe("the printer's references (tests/integration/fixtures/fmk-texts.ts)", () => {
  const reading = printerRefs(readFileSync(PRINTER_PATH, 'utf-8'))
  const refs = reading.refs.map((r): [string, string, ExportKind, number] => [r.file, r.name, r.kind, r.line])

  test('every name the printer passes is resolved, and every CHOSEN_FROM row is used', () => {
    expect(reading.unresolved).toEqual([])
    expect(reading.chosenUsed).toEqual([...Object.keys(CHOSEN_FROM), ...Object.keys(CHOSEN_BY_PREFIX)].sort())
  })

  test.each(Object.entries(CHOSEN_BY_PREFIX))('%s: src/ exports at least one name with its prefix, of its kind', (_key, { file, prefix, kind }) => {
    const mod = MODULES[file] ?? {}
    expect(Object.keys(mod).filter((name) => name.startsWith(prefix) && kindMismatch(mod[name], kind) === undefined).length).toBeGreaterThan(0)
  })

  test('the latch scenarios’ lists are read whole: every name of LATCH_CONSTANT_NAMES and CASE_PHRASE_NAMES is a constant reference', () => {
    for (const [list, file] of [
      ['LATCH_CONSTANT_NAMES', 'conflict-latch.ts'],
      ['CASE_PHRASE_NAMES', 'ad-description-phrases.ts'],
    ] as const) {
      const names = reading.collections[list] ?? []
      expect(names.length).toBeGreaterThan(0)
      const read = new Set(reading.refs.filter((r) => r.file === file && r.kind === 'constant').map((r) => r.name))
      expect(names.filter((n) => !read.has(n))).toEqual([])
    }
  })

  // Scenario 20's references (test-23), each `<file>:<export>:<kind>`, with
  // what the scenario reads of the value beyond its kind, when it reads more.
  const named = new Set(reading.refs.map((r) => `${r.file}:${r.name}:${r.kind}`))
  const scenario20Values: Readonly<Record<string, () => void>> = {
    // test-23 prints `DEFAULT_AD_SETTINGS tmux starting_session_seconds`, the
    // starting-session bound it waits past: a positive number.
    'ad-settings.ts:DEFAULT_AD_SETTINGS:defined': () => {
      const tables: unknown = MODULES['ad-settings.ts']?.DEFAULT_AD_SETTINGS
      const tmux: unknown = typeof tables === 'object' && tables !== null && Object.hasOwn(tables, 'tmux') ? (tables as Record<string, unknown>).tmux : undefined
      const bound: unknown =
        typeof tmux === 'object' && tmux !== null && Object.hasOwn(tmux, 'starting_session_seconds')
          ? (tmux as Record<string, unknown>).starting_session_seconds
          : undefined
      expect(typeof bound === 'bigint' || (typeof bound === 'number' && Number.isFinite(bound))).toBe(true)
      expect(Number(bound)).toBeGreaterThan(0)
    },
    // The note a harness `get` shows on Part 1's note persona's row.
    'row-read-rules.ts:LATCHING_LIVENESS_NOTE:constant': () => {
      expect(rowReadRules.isLatchingLivenessNote(rowReadRules.LATCHING_LIVENESS_NOTE)).toBe(true)
    },
  }

  test.each([
    'pane-read.ts:PANE_READ_PANE:constant',
    'pane-read.ts:PANE_READ_CONFLICT:constant',
    'pane-read.ts:PANE_READ_GONE:constant',
    'conflict-latch.ts:RECHECK_VERDICT_STILL_LATCHED:constant',
    'ad-settings.ts:DEFAULT_AD_SETTINGS:defined',
    'session-manager.ts:latchClearRetryAtOnceLineHead:function',
    'row-read-rules.ts:LATCHING_LIVENESS_NOTE:constant',
  ])("scenario 20's printer reads %s", (ref) => {
    expect(named.has(ref)).toBe(true)
    scenario20Values[ref]?.()
  })

  test('every file the printer names is a src/ module this file imports', () => {
    const files = [...new Set(reading.refs.map((r) => r.file))].sort()
    expect(files.filter((f) => !existsSync(join(SRC_DIR, f)))).toEqual([])
    expect(files.filter((f) => !Object.hasOwn(MODULES, f))).toEqual([])
  })

  test.each(refs)('src/%s exports %s as a %s (printer line %d)', (file, name, kind) => {
    const mod = MODULES[file]
    expect(mod).toBeDefined()
    expect(kindMismatch(mod?.[name], kind)).toBeUndefined()
  })

  test('nothing this file reads or reports holds a token-like value: the reading, the text exports it looks up and every mismatch', () => {
    const texts = reading.refs.flatMap((r) => {
      const value = MODULES[r.file]?.[r.name]
      if (typeof value === 'string') return [value]
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
    })
    expect(texts.length).toBeGreaterThan(0)
    const mismatches = reading.refs.flatMap((r) => kindMismatch(MODULES[r.file]?.[r.name], r.kind) ?? [])
    assertNoLeak({ reading, texts, mismatches }, 'fmk-texts entries')
  })
})
