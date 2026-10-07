/**
 * invariants.test.ts — SR-0.3 / SR-8.6 grep-style + type-level tripwires.
 *
 *   - SR-0.3 no-shellout: no CSCB source file invokes `agent-director` as
 *     a subprocess. The only legal reference is `from 'agent-director'`
 *     (typed import).
 *   - SR-8.6 request_id is `number`: a compile-time tripwire that fails
 *     closed if the library widens the type.
 *   - b.av2 SR-1.2, b.deo SRI-202 the section not in force is never read:
 *     outside a fixed list of `src/` files, no file reads a persona's
 *     `channels`, `permission_prompts`, `invited`, `fungible_destination` or
 *     `sections`; inside it, `src/registry.ts` reads them only in the
 *     posting-scope check and its classifier, `src/persona-routing.ts` only
 *     in the decision's input, `src/persona-destination.ts` only in the one
 *     destination rule.
 *   - b.deo SRI-102 the readers of the resolved forms: `sections` is read
 *     only by the reload plan; `fungible_destination` only by the one
 *     destination rule, the delivery decision, the routing's input to it and
 *     the reload plan (`src/config.ts` reads it only where it builds it).
 *   - b.av2 SR-7.1, b.deo SRI-701 one destination rule: declared once, in
 *     `src/persona-destination.ts`; the destination hold, the permission
 *     poller, the persona notifier and the lost-message notice read none of
 *     the persona fields, and the hold's destination reads are calls of the
 *     rule.
 *
 *   The reader audit parses every `src/` module (comment-stripped, through
 *   `srcModules`) with the TypeScript parser, so a field name in a string, a
 *   template or a comment never counts. A read is a property access, an
 *   optional chain, a string-keyed access or a destructuring (a declaration,
 *   a parameter, an assignment or a `for … of` head); an object literal that
 *   builds the field, a type and a setting name held as a string are no
 *   read. A same-named field of a non-persona object is admitted only by an
 *   exact `ADMITTED_READS` entry (the file, the function, the read and the
 *   reason), and an entry that matches no read fails the audit. Negative
 *   controls pin the matcher and the checks on planted sources.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { PermissionRequestInfo } from 'agent-director'
import ts from 'typescript'
import { forEachNode } from './test-helpers/ad-value-reads.ts'
import { srcModules, stripComments } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// SR-0.3 — no shellout to agent-director
// ---------------------------------------------------------------------------

function walkSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walkSources(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('SR-0.3: no-shellout invariant', () => {
  test('no src/ file invokes agent-director as a subprocess', () => {
    const srcDir = join(__dirname, '..', 'src')
    const sourceFiles = walkSources(srcDir)
    const offending: Array<{ file: string; line: number; text: string }> = []
    const subprocessIdents = ['spawnSync', 'exec', 'execSync', 'spawn', 'Bun.$']
    for (const file of sourceFiles) {
      const lines = readFileSync(file, 'utf-8').split('\n')
      lines.forEach((text, i) => {
        // Skip comments
        const stripped = text.replace(/\/\/.*$/, '').trim()
        if (!stripped) return
        // The legal reference is `from 'agent-director'` — skip those lines.
        if (/from\s+['"]agent-director['"]/.test(stripped)) return
        // The `client.spawn(...)` library call is explicitly allowed — its
        // identifier is `spawn` but matched only when prefixed by `.` or
        // `client`. We disallow `spawn(` only when paired with a subprocess
        // identifier in the same line.
        for (const ident of subprocessIdents) {
          // Build a regex that matches the ident as a CALL form, not member access.
          const regex = new RegExp(`\\b${ident.replace('$', '\\$').replace('.', '\\.')}\\s*\\(`)
          if (regex.test(stripped) && /agent-director/.test(stripped)) {
            offending.push({ file, line: i + 1, text: stripped })
          }
        }
      })
    }
    expect(offending).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// SR-8.6 — PermissionRequestInfo.request_id is number
// ---------------------------------------------------------------------------

describe('SR-8.6: PermissionRequestInfo.request_id type', () => {
  test('request_id is typed as number — fails compile if widened', () => {
    // This is a compile-time tripwire: if the agent-director library
    // widens request_id beyond `number`, this assertion stops compiling.
    // No runtime expectation; the existence of the assignment is the test.
    const info: PermissionRequestInfo = {
      request_id: Number.MAX_SAFE_INTEGER,
      request_token: '00000000-0000-4000-8000-000000000000',
      tool_name: 'Bash',
      tool_input: '{}',
      requested_at: '2026-01-01T00:00:00Z',
    }
    // Assignment back to a `number` variable confirms the type.
    const n: number = info.request_id
    expect(typeof n).toBe('number')
    expect(n).toBe(Number.MAX_SAFE_INTEGER)
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-1.2, SR-7.1; b.deo SRI-102, SRI-202, SRI-701 — the reader audit
// ---------------------------------------------------------------------------

/**
 * The persona fields the audit follows (b.deo SRI-102, SRI-202): the
 * declarative section (`channels`, `permission_prompts`), the fungible
 * section (`invited`) and the resolved forms (`fungible_destination`,
 * `sections`).
 */
const AUDITED_FIELDS = ['channels', 'permission_prompts', 'invited', 'fungible_destination', 'sections'] as const
type AuditedField = (typeof AUDITED_FIELDS)[number]

/** b.deo SRI-202's fixed list: the only `src/` files that may read an audited field. */
const FIXED_READERS: readonly string[] = [
  'config.ts',
  'reload-plan.ts',
  'delivery-decision.ts',
  'persona-routing.ts',
  'registry.ts',
  'persona-destination.ts',
  'jsonl-persistence-check.ts',
]

/** The one destination rule (b.av2 SR-7.1, b.deo SRI-701), declared in `src/persona-destination.ts`. */
const ONE_DESTINATION_RULE = 'personaDestinationOf'

/** Where `src/config.ts` builds a persona's resolved forms (b.deo SRI-102): building them is no read. */
const PERSONA_BUILDER = 'parsePersonaEntry'

/** b.deo SRI-102: the only files that read `sections` (the reload plan). */
const SECTIONS_READERS: readonly string[] = ['reload-plan.ts']

/**
 * b.deo SRI-102: the only files that read `fungible_destination`: the one
 * destination rule, the delivery decision (its exported channel-delivery
 * function included), the routing's input to the decision and the reload
 * plan, and `src/config.ts`, which builds it.
 */
const FUNGIBLE_DESTINATION_READERS: readonly string[] = ['persona-destination.ts', 'delivery-decision.ts', 'persona-routing.ts', 'reload-plan.ts', 'config.ts']

/**
 * b.deo SRI-701's consumers outside the resolver: the destination hold, the
 * permission poller, the persona notifier and the lost-message notice. None
 * reads an audited field; each goes through the rule.
 */
const DESTINATION_CONSUMERS: readonly string[] = ['persona-destination-hold.ts', 'permission-poller.ts', 'persona-notifier.ts', 'lost-message.ts']

/** The destination hold (b.av2 SR-7.1, b.deo SRI-701), and its reads of the resolver it is handed. */
const DESTINATION_HOLD = 'persona-destination-hold.ts'
const HOLD_RESOLVER = 'deps.destinations'

/** The resolver's factory in `src/persona-destination.ts`: its methods hold the per-persona DM cache. */
const RESOLVER_FACTORY = 'createPersonaDestinations'

/** A part of a module: a function (declared, or a function bound to a name), or the arguments of every call of a function. */
type Region = { readonly fn: string } | { readonly argsOf: string }

/** One row of the inside-the-list check: the reads of `fields` in `file` lie only in `regions`. */
interface PlacementRow {
  readonly file: string
  readonly part: string
  readonly regions: readonly Region[]
  readonly fields: readonly AuditedField[]
}

/** b.deo SRI-202, inside the list: the part of each file its reads lie in. */
const PLACEMENT: readonly PlacementRow[] = [
  {
    file: 'registry.ts',
    part: 'the posting-scope check and its classifier',
    regions: [{ fn: 'checkPersonaTarget' }, { fn: 'classifyPersonaTarget' }],
    fields: AUDITED_FIELDS,
  },
  { file: 'persona-routing.ts', part: "the decision's input", regions: [{ argsOf: 'decideDelivery' }], fields: AUDITED_FIELDS },
  {
    file: 'persona-destination.ts',
    part: 'the one destination rule',
    regions: [{ fn: ONE_DESTINATION_RULE }],
    fields: ['channels', 'permission_prompts', 'invited', 'sections'],
  },
]

/**
 * A read of a same-named field of a non-persona object, outside the fixed
 * list (b.deo SRI-202): the file, the functions it lies in (outermost first,
 * joined by ` > `), the read's text and why it is no persona read. Each entry
 * must match a read, or the audit fails.
 */
interface AdmittedRead {
  readonly file: string
  readonly within: string
  readonly read: string
  readonly reason: string
}

/** Why the stored-choice file's reads are admitted: its per-persona entry's own `channels`. */
const STORED_CHOICES_ENTRY = "a persona key's entry of the stored-choice file (b.deo SRI-402): its own `channels` map of stored choices, never a persona's"

const ADMITTED_READS: readonly AdmittedRead[] = [
  { file: 'channel-delivery.ts', within: 'serializeChannelDelivery', read: 'entry.channels', reason: STORED_CHOICES_ENTRY },
  {
    file: 'channel-delivery.ts',
    within: 'personaEntryOf',
    read: "value['channels']",
    reason: "a persona key's entry of the stored-choice file as parsed from JSON (b.deo SRI-402), checked before it is a record",
  },
  { file: 'channel-delivery.ts', within: 'createChannelDeliveryStore > set', read: 'existing?.channels', reason: STORED_CHOICES_ENTRY },
  { file: 'channel-delivery.ts', within: 'createChannelDeliveryStore > drop', read: 'entry.channels', reason: STORED_CHOICES_ENTRY },
  { file: 'channel-delivery.ts', within: 'createChannelDeliveryStore > storedChoice', read: 'entries.get(key)?.channels', reason: STORED_CHOICES_ENTRY },
  { file: 'channel-delivery.ts', within: 'createChannelDeliveryStore > storedChannels', read: 'entries.get(key)?.channels', reason: STORED_CHOICES_ENTRY },
]

/** How a field is read. */
type ReadForm = 'property' | 'optional property' | 'string key' | 'optional string key' | 'destructuring'

/** One read of an audited field in a module. */
interface FieldRead {
  readonly file: string
  readonly field: AuditedField
  readonly form: ReadForm
  /** The read's text, whitespace collapsed. */
  readonly text: string
  /** The functions it lies in, outermost first, joined by ` > ` (empty at module scope). */
  readonly within: string
  readonly node: ts.Node
}

function isAuditedField(name: string | undefined): name is AuditedField {
  return name !== undefined && (AUDITED_FIELDS as readonly string[]).includes(name)
}

/** The name a property name or key expression gives, when it is plain (an identifier, a string, a computed string), else undefined. */
function plainName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isComputedPropertyName(node)) return plainName(node.expression)
  return undefined
}

/** The name a function is declared with or bound to (a variable or a property), or undefined. */
function boundName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) return plainName(node.name)
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent))) {
    return plainName(node.parent.name)
  }
  return undefined
}

/** The functions `node` lies in, outermost first, joined by ` > `. */
function enclosingFunctions(node: ts.Node): string {
  const names: string[] = []
  for (let n = node.parent; n !== undefined; n = n.parent) {
    const name = boundName(n)
    if (name !== undefined) names.unshift(name)
  }
  return names.join(' > ')
}

/** Whether an object literal is the target of an assignment (`({ a } = x)`, `for ({ a } of xs)`), directly or nested in one. */
function isAssignmentTarget(node: ts.Expression): boolean {
  let at: ts.Node = node
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent
  const parent = at.parent
  if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === at
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === at
  if (ts.isPropertyAssignment(parent) && parent.initializer === at) return isAssignmentTarget(parent.parent)
  if (ts.isArrayLiteralExpression(parent)) return isAssignmentTarget(parent)
  return false
}

/** The field and form `node` reads, when it reads an audited field. */
function readOf(node: ts.Node): { field: AuditedField; form: ReadForm } | undefined {
  let name: string | undefined
  let form: ReadForm
  if (ts.isPropertyAccessExpression(node)) {
    name = node.name.text
    form = node.questionDotToken !== undefined ? 'optional property' : 'property'
  } else if (ts.isElementAccessExpression(node)) {
    name = ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined
    form = node.questionDotToken !== undefined ? 'optional string key' : 'string key'
  } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    name = plainName(node.propertyName ?? node.name)
    form = 'destructuring'
  } else if ((ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) && isAssignmentTarget(node.parent)) {
    name = plainName(node.name)
    form = 'destructuring'
  } else {
    return undefined
  }
  return isAuditedField(name) ? { field: name, form } : undefined
}

/** Parses comment-stripped `code` as the module `file`. */
function parseModule(file: string, code: string): ts.SourceFile {
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** Every read of an audited field in `code` (comment-stripped), in source order. */
function fieldReads(file: string, code: string): FieldRead[] {
  const sf = parseModule(file, code)
  const reads: FieldRead[] = []
  forEachNode(sf, (node) => {
    const read = readOf(node)
    if (read === undefined) return
    reads.push({ file, ...read, text: node.getText(sf).replace(/\s+/g, ' '), within: enclosingFunctions(node), node })
  })
  return reads
}

/** Every read of an audited field across `modules` (file name → comment-stripped code). */
function allFieldReads(modules: ReadonlyMap<string, string>): FieldRead[] {
  return [...modules].flatMap(([file, code]) => fieldReads(file, code))
}

/** A read as a finding: `src/<file>: <form> read of <field> <text> (in <functions>)`. */
function describeRead(read: FieldRead): string {
  return `src/${read.file}: ${read.form} read of ${read.field} ${read.text} (in ${read.within || 'module scope'})`
}

/** Whether `node` lies in `region`. */
function inRegion(node: ts.Node, region: Region): boolean {
  for (let child: ts.Node = node, n = node.parent; n !== undefined; child = n, n = n.parent) {
    if ('fn' in region && boundName(n) === region.fn) return true
    if ('argsOf' in region && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === region.argsOf && n.arguments.some((a) => a === child)) {
      return true
    }
  }
  return false
}

function admits(entry: AdmittedRead, read: FieldRead): boolean {
  return entry.file === read.file && entry.within === read.within && entry.read === read.text
}

/**
 * b.deo SRI-202, outside the list: each read in a file not on
 * `fixedReaders` that no entry of `admitted` matches, and each entry that
 * matches no read.
 */
function outsideListFindings(modules: ReadonlyMap<string, string>, fixedReaders: readonly string[], admitted: readonly AdmittedRead[]): string[] {
  const reads = allFieldReads(modules).filter((r) => !fixedReaders.includes(r.file))
  return [
    ...reads.filter((r) => !admitted.some((entry) => admits(entry, r))).map(describeRead),
    ...admitted
      .filter((entry) => !reads.some((r) => admits(entry, r)))
      .map((entry) => `admitted read matches nothing: src/${entry.file} ${entry.read} (in ${entry.within})`),
  ]
}

/**
 * The reads of `fields` in `file` that lie in none of `regions`, and a
 * finding when none lies in them (the row would hold vacuously).
 */
function placementFindings(modules: ReadonlyMap<string, string>, row: Omit<PlacementRow, 'part'>): string[] {
  const code = modules.get(row.file)
  if (code === undefined) return [`no module src/${row.file}`]
  const reads = fieldReads(row.file, code).filter((r) => row.fields.includes(r.field))
  const inside = reads.filter((r) => row.regions.some((region) => inRegion(r.node, region)))
  return [
    ...reads.filter((r) => !inside.includes(r)).map(describeRead),
    ...(inside.length === 0 ? [`src/${row.file}: no read lies in ${JSON.stringify(row.regions)}`] : []),
  ]
}

/** The reads of `field` in any file but `readers`. */
function readersFindings(modules: ReadonlyMap<string, string>, field: AuditedField, readers: readonly string[]): string[] {
  return allFieldReads(modules)
    .filter((r) => r.field === field && !readers.includes(r.file))
    .map(describeRead)
}

/** The functions named `name` in `sf`. */
function functionsNamed(sf: ts.SourceFile, name: string): ts.Node[] {
  const found: ts.Node[] = []
  forEachNode(sf, (node) => {
    if (boundName(node) === name) found.push(node)
  })
  return found
}

/** The names of the plain functions called (`name(…)`) inside `fn`. */
function plainCallees(fn: ts.Node): Set<string> {
  const names = new Set<string>()
  forEachNode(fn, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text)
  })
  return names
}

/** Whether the function `from` in `sf` reaches the function `to` through plain calls of functions declared in `sf`. */
function reachesThroughCalls(sf: ts.SourceFile, from: string, to: string): boolean {
  const seen = new Set<string>([from])
  const queue = [from]
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    for (const fn of functionsNamed(sf, name)) {
      for (const callee of plainCallees(fn)) {
        if (callee === to) return true
        if (!seen.has(callee)) {
          seen.add(callee)
          queue.push(callee)
        }
      }
    }
  }
  return false
}

/** The methods `code` calls on `receiver` (`<receiver>.<method>(…)`), sorted. */
function methodsCalledOn(file: string, code: string, receiver: string): string[] {
  const sf = parseModule(file, code)
  const methods = new Set<string>()
  forEachNode(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(sf) === receiver) {
      methods.add(node.expression.name.text)
    }
  })
  return [...methods].sort()
}

/** A planted module, as the audit sees a `src/` file: comment-stripped. */
function planted(code: string): string {
  return stripComments(code)
}

describe('b.av2 SR-1.2, b.deo SRI-202: the section not in force is never read', () => {
  const modules = srcModules()

  test('the walk holds every src/ module, and every file the audit names is one', () => {
    const srcDir = join(import.meta.dir, '..', 'src')
    const everyTs = (readdirSync(srcDir, { recursive: true }) as string[]).filter((name) => name.endsWith('.ts')).sort()
    expect([...modules.keys()]).toEqual(everyTs)
    const named = [
      ...FIXED_READERS,
      ...SECTIONS_READERS,
      ...FUNGIBLE_DESTINATION_READERS,
      ...DESTINATION_CONSUMERS,
      ...PLACEMENT.map((row) => row.file),
      ...ADMITTED_READS.map((entry) => entry.file),
    ]
    expect(named.filter((file) => !modules.has(file))).toEqual([])
  })

  test('outside the fixed list, no src/ file reads a persona field, and every admitted read matches one', () => {
    expect(outsideListFindings(modules, FIXED_READERS, ADMITTED_READS)).toEqual([])
  })

  test.each(PLACEMENT.map((row) => [`src/${row.file}`, row.part, row] as const))('inside the list, %s reads them only in %s', (_file, _part, row) => {
    expect(placementFindings(modules, row)).toEqual([])
  })
})

describe('b.deo SRI-102: the readers of sections and fungible_destination', () => {
  const modules = srcModules()

  test('sections is read only by the reload plan', () => {
    expect(readersFindings(modules, 'sections', SECTIONS_READERS)).toEqual([])
    expect(allFieldReads(modules).filter((r) => r.field === 'sections').length).toBeGreaterThan(0)
  })

  test('fungible_destination is read only by the one destination rule, the delivery decision, the routing and the reload plan', () => {
    expect(readersFindings(modules, 'fungible_destination', FUNGIBLE_DESTINATION_READERS)).toEqual([])
    expect(allFieldReads(modules).filter((r) => r.field === 'fungible_destination' && r.file === 'reload-plan.ts').length).toBeGreaterThan(0)
  })

  test('src/config.ts reads fungible_destination only where it builds a persona', () => {
    expect(placementFindings(modules, { file: 'config.ts', regions: [{ fn: PERSONA_BUILDER }], fields: ['fungible_destination'] })).toEqual([])
  })
})

describe('b.av2 SR-7.1, b.deo SRI-701: one destination rule', () => {
  const modules = srcModules()

  test('the rule is declared once, in src/persona-destination.ts, and reads both destination fields', () => {
    const declared = [...modules].flatMap(([file, code]) => functionsNamed(parseModule(file, code), ONE_DESTINATION_RULE).map(() => file))
    expect(declared).toEqual(['persona-destination.ts'])
    const ruleReads = fieldReads('persona-destination.ts', modules.get('persona-destination.ts')!).filter((r) => inRegion(r.node, { fn: ONE_DESTINATION_RULE }))
    expect([...new Set(ruleReads.map((r) => r.field))].sort()).toEqual(['fungible_destination', 'permission_prompts'])
  })

  test.each(DESTINATION_CONSUMERS.map((file) => [`src/${file}`, file] as const))('%s reads none of the persona fields', (_label, file) => {
    expect(fieldReads(file, modules.get(file)!).map(describeRead)).toEqual([])
  })

  test("the hold's destination reads are calls of the rule, through the resolver it is handed", () => {
    const methods = methodsCalledOn(DESTINATION_HOLD, modules.get(DESTINATION_HOLD)!, HOLD_RESOLVER)
    expect(methods).toContain('destinationOf')
    expect(methods).toContain('post')
    const resolver = parseModule('persona-destination.ts', modules.get('persona-destination.ts')!)
    const [factory] = functionsNamed(resolver, RESOLVER_FACTORY)
    expect(factory).toBeDefined()
    for (const method of methods) {
      expect({ method, inFactory: functionsNamed(resolver, method).some((fn) => inRegion(fn, { fn: RESOLVER_FACTORY })) }).toEqual({ method, inFactory: true })
      expect({ method, reachesRule: reachesThroughCalls(resolver, method, ONE_DESTINATION_RULE) }).toEqual({ method, reachesRule: true })
    }
  })
})

describe('b.deo SRI-202: negative controls for the reader audit', () => {
  test.each([
    ['a property access', 'export const f = (p: P) => p.channels', 'channels', 'property'],
    ['an optional chain', 'export const f = (p?: P) => p?.permission_prompts', 'permission_prompts', 'optional property'],
    ['a string-keyed access', "export const f = (p: P) => p['invited']", 'invited', 'string key'],
    ['an optional string-keyed access', 'export const f = (p?: P) => p?.["sections"]', 'sections', 'optional string key'],
    ['a template-keyed access', 'export const f = (p: P) => p[`fungible_destination`]', 'fungible_destination', 'string key'],
    ['a destructuring declaration', 'export function f(p: P) { const { channels } = p; return channels }', 'channels', 'destructuring'],
    ['a renamed destructuring', 'export function f(p: P) { const { invited: section } = p; return section }', 'invited', 'destructuring'],
    ['a string-keyed destructuring', "export function f(p: P) { const { 'sections': s } = p; return s }", 'sections', 'destructuring'],
    ['a nested destructuring', 'export function f(x: X) { const { persona: { fungible_destination } } = x; return fungible_destination }', 'fungible_destination', 'destructuring'],
    ['a destructured parameter', 'export function f({ permission_prompts }: P) { return permission_prompts }', 'permission_prompts', 'destructuring'],
    ['a destructured arrow parameter', 'export const f = ({ channels }: P) => channels', 'channels', 'destructuring'],
    ['an assignment destructuring', 'let invited: unknown\nexport function f(p: P) { ({ invited } = p) }', 'invited', 'destructuring'],
    ['a for-of destructuring', 'export function f(ps: P[]) { for (const { sections } of ps) void sections }', 'sections', 'destructuring'],
  ] as const)('%s is a read', (_form, code, field, form) => {
    expect(fieldReads('planted.ts', planted(code)).map((r) => ({ field: r.field, form: r.form }))).toEqual([{ field, form }])
  })

  test.each([
    ['a setting name held in a settings set', "export const SETTINGS: ReadonlySet<string> = new Set(['channels', 'permission_prompts'])"],
    ['a setting name held in a constant', "export const SETTING = 'invited'"],
    ['a setting name in a log line', "export const f = (log: (l: string) => void) => log(`fungible_destination and sections ${'channels'}`)"],
    ['a read inside a line comment', 'export const f = (p: P) => 0 // p.channels, p?.invited'],
    ['a read inside a block comment', "/** p['sections'], const { permission_prompts } = p */\nexport const f = 0"],
    ['an object literal that builds the fields', 'export const f = () => ({ channels: [], permission_prompts: undefined, fungible_destination: undefined })'],
    ['a type that names the fields', "export type T = Pick<P, 'channels' | 'invited'> & { sections: P['sections'] }"],
  ] as const)('%s is no read', (_what, code) => {
    expect(fieldReads('planted.ts', planted(code))).toEqual([])
  })

  test('a read outside the fixed list is a finding, an exact admission clears it, and an admission matching nothing is one', () => {
    const modules = new Map([['planted.ts', planted('export function f(p: P) { return p.channels }')]])
    expect(outsideListFindings(modules, FIXED_READERS, [])).toEqual(['src/planted.ts: property read of channels p.channels (in f)'])
    const exact: AdmittedRead = { file: 'planted.ts', within: 'f', read: 'p.channels', reason: 'planted' }
    expect(outsideListFindings(modules, FIXED_READERS, [exact])).toEqual([])
    expect(outsideListFindings(modules, FIXED_READERS, [{ ...exact, within: 'g' }])).toEqual([
      'src/planted.ts: property read of channels p.channels (in f)',
      'admitted read matches nothing: src/planted.ts p.channels (in g)',
    ])
    expect(outsideListFindings(modules, ['planted.ts'], [])).toEqual([])
  })

  test("a read inside the list but outside its file's part is a finding, and a part with no read is one", () => {
    const row = { file: 'planted.ts', regions: [{ fn: 'scope' }, { argsOf: 'decide' }], fields: AUDITED_FIELDS }
    const inside = planted('function scope(p: P) { return p.channels }\nexport const g = (p: P) => decide({ channels: p.channels })')
    expect(placementFindings(new Map([['planted.ts', inside]]), row)).toEqual([])
    const outside = planted("function scope(p: P) { return p.channels }\nexport function other(p: P) { return p['invited'] }")
    expect(placementFindings(new Map([['planted.ts', outside]]), row)).toEqual(["src/planted.ts: string key read of invited p['invited'] (in other)"])
    const none = planted('function scope(p: P) { return p.dm }')
    expect(placementFindings(new Map([['planted.ts', none]]), row)).toEqual([`src/planted.ts: no read lies in ${JSON.stringify(row.regions)}`])
  })
})
