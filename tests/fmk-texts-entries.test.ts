/**
 * fmk-texts-entries.test.ts — Every `src/` export the `/ci` scenarios' value
 * printer (`tests/integration/fixtures/fmk-texts.ts`
 * read by every fmk scenario and by the shared-mode
 * test-29-invited-channels.sh) names exists in `src/` with the kind the
 * printer reads it as, so a renamed, removed or retyped export fails on the
 * host, before `/ci` runs a scenario.
 *
 * The printer's image entrypoint is never imported or run here.
 * `printerRefs` reads its text with the TypeScript
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
 *   `conflict-latch.ts`; each `derivedWaitEntry(<name>)`: a function in
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
 * every kind mismatch) is passed through `assertNoLeak`. Shared-entry controls
 * extract declarations into scratch copies, inject package imports and keep
 * image/main statements out. A bounded child checks the real FIFO refusal.
 *
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, truncateSync, statSync, readdirSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { makeFifo, mkfifoAvailable } from './test-helpers/fifo.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

import * as adDescriptionPhrases from '../src/ad-description-phrases.ts'
import * as adConfigFile from '../src/ad-config-file.ts'
import * as adErrorClass from '../src/ad-error-class.ts'
import * as adSettings from '../src/ad-settings.ts'
import * as adVersionGate from '../src/ad-version-gate.ts'
import * as backoff from '../src/backoff.ts'
import * as channelDelivery from '../src/channel-delivery.ts'
import * as channelDeliveryAttempt from '../src/channel-delivery-attempt.ts'
import * as channelMembership from '../src/channel-membership.ts'
import * as channelMembershipRetry from '../src/channel-membership-retry.ts'
import * as deliveryQueue from '../src/delivery-queue.ts'
import * as deliveryReceipt from '../src/delivery-receipt.ts'
import * as deliveryNotices from '../src/delivery-notices.ts'
import * as reloadPreviewClauses from '../src/reload-preview-clauses.ts'
import * as reloadRecovery from '../src/reload-recovery.ts'
import * as sharedRecovery from '../src/shared-recovery.ts'
import * as sharedStateReports from '../src/shared-state-reports.ts'
import * as tagDescription from '../src/tag-description.ts'
import * as tagWrapper from '../src/tag-wrapper.ts'
import * as threadMemoryReports from '../src/thread-memory-reports.ts'
import * as threadMemorySeal from '../src/thread-memory-seal.ts'
import * as threadMemory from '../src/thread-memory.ts'
import * as crontable from '../src/crontable.ts'
import * as config from '../src/config.ts'
import * as conflictLatch from '../src/conflict-latch.ts'
import * as deliveryDecision from '../src/delivery-decision.ts'
import * as deliveryConstants from '../src/delivery-constants.ts'
import * as installCheckLabels from '../src/install-check-labels.ts'
import * as installCheck from '../src/install-check.ts'
import * as installSkillPointer from '../src/install-skill-pointer.ts'
import * as invalidFlagsHold from '../src/invalid-flags-hold.ts'
import * as liveRowSequence from '../src/live-row-sequence.ts'
import * as livenessReading from '../src/liveness-reading.ts'
import * as outageState from '../src/outage-state.ts'
import * as paneRead from '../src/pane-read.ts'
import * as pendingRow from '../src/pending-row.ts'
import * as personaDiagnostics from '../src/persona-diagnostics.ts'
import * as personaEpisodes from '../src/persona-episodes.ts'
import * as personaIdentity from '../src/persona-identity.ts'
import * as personaNotifier from '../src/persona-notifier.ts'
import * as registry from '../src/registry.ts'
import * as reloadApply from '../src/reload-apply.ts'
import * as reload from '../src/reload.ts'
import * as reloadPlan from '../src/reload-plan.ts'
import * as reloadRequest from '../src/reload-request.ts'
import * as reloadReview from '../src/reload-review.ts'
import * as reloadFingerprint from '../src/reload-fingerprint.ts'
import * as restart from '../src/restart.ts'
import * as rowReadRules from '../src/row-read-rules.ts'
import * as sessionManager from '../src/session-manager.ts'
import * as channelMembershipReadiness from '../src/channel-membership-readiness.ts'
import * as channelMembershipScan from '../src/channel-membership-scan.ts'
import * as sharedChannels from '../src/shared-channels.ts'
import * as testTimerOverrides from '../src/test-timer-overrides.ts'
import * as testMeasurements from '../src/test-measurements.ts'
import * as unavailableRetry from '../src/unavailable-retry.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { makePersona, makePersonaConfigInput } from './test-helpers/persona-config.ts'
import { initialSharedState } from './test-helpers/shared-channels.ts'

const REPO_ROOT = join(import.meta.dir, '..')
const SRC_DIR = join(REPO_ROOT, 'src')
const PRINTER_PATH = join(REPO_ROOT, 'tests', 'integration', 'fixtures', 'fmk-texts.ts')

describe('test-29 Channel Stamp printer', () => {
  // Execute only these declarations, never the image-only printer entry
  // point. Read bytes from memory; use the real authority parser and the
  // established helper's minted stamps, without a handwritten state record.
  const source = ts.createSourceFile('fmk-texts.ts', readFileSync(PRINTER_PATH, 'utf8'), ts.ScriptTarget.Latest, true)
  const names = ['readSharedConfiguration', 'sharedThreadStamp', 'expectArguments']
  const declarations = source.statements.filter(statement =>
    ts.isFunctionDeclaration(statement) ? names.includes(statement.name?.text ?? '') :
      ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d => names.includes(d.name.getText(source))))
  const js = ts.transpileModule(declarations.map(d => d.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const base = join(tmpdir(), 'stamp-printer-in-memory')
  const configPath = join(base, 'config.json'), recordPath = `${configPath}.last-applied`
  const input = makePersonaConfigInput({ personas: [makePersona({ name: 'alpha', channels: [
    { id: 'CHYBRID', delivery: 'thread_hybrid' }, { id: 'COTHER', delivery: 'mentions' },
  ], permission_prompts: 'CHYBRID' }, base)] }, base)
  const state = initialSharedState(base, input)
  const key = personaIdentity.personaKey('alpha')

  function reader(bytes = sharedChannels.serializeSharedChannelState(state)) {
    const reads: string[] = []
    const packageFunction = async (_context: unknown, file: string, name: string) => {
      if (file === 'config.ts' && name === 'readPersonaConfigBytes') return (path: string) => {
        reads.push(path)
        if (path !== recordPath) throw new Error('unexpected read')
        return bytes
      }
      if (file === 'shared-channels.ts') return (sharedChannels as Record<string, unknown>)[name]
      throw new Error('unexpected package export')
    }
    const entry = new Function('packageFunction', 'PrinterFailure', 'PRINTER_FAIL_EXIT', 'usageFail',
      `${js}\nreturn sharedThreadStamp;`)(packageFunction, Error, 1, () => { throw new Error('invalid arguments') }) as {
        print(args: string[], context: object): Promise<string>
      }
    return { reads, print: (persona = key, channel = 'CHYBRID') => entry.print([configPath, recordPath, persona, channel], {}) }
  }

  test('prints only the selected current stamp, obtained through the production reader', async () => {
    expect(declarations).toHaveLength(names.length)
    const r = reader(), output = await r.print()
    expect(JSON.parse(output)).toEqual({ incarnation: state.personas[key]!.incarnation,
      threadHybridSince: state.personas[key]!.assignments.CHYBRID!.threadHybridSince })
    expect(r.reads).toEqual([recordPath])
    assertNoLeak(output)
  })

  test('refuses absent, non-hybrid and inherited-property lookups', async () => {
    for (const [persona, channel] of [[key, 'COTHER'], [key, 'CMISSING'], ['missing', 'CHYBRID'],
      ['constructor', 'CHYBRID'], [key, 'constructor']]) {
      await expect(reader().print(persona, channel)).rejects.toThrow('expected a current thread_hybrid Channel Stamp')
    }
  })

  test('an invalid authority fails closed without echoing its bytes', async () => {
    await expect(reader(Buffer.from('private-invalid-authority')).print()).rejects
      .toThrow('shared configuration authority could not be read or validated')
  })
})

/** The `src/` modules the printer reads, by the file name it passes. */
const MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'install-check.ts': installCheck,
  'install-skill-pointer.ts': installSkillPointer,
  'ad-description-phrases.ts': adDescriptionPhrases,
  'ad-config-file.ts': adConfigFile,
  'ad-error-class.ts': adErrorClass,
  'ad-settings.ts': adSettings,
  'ad-version-gate.ts': adVersionGate,
  'backoff.ts': backoff,
  'channel-delivery.ts': channelDelivery,
  'channel-membership-readiness.ts': channelMembershipReadiness,
  'channel-membership-scan.ts': channelMembershipScan,
  'channel-delivery-attempt.ts': channelDeliveryAttempt,
  'channel-membership.ts': channelMembership,
  'channel-membership-retry.ts': channelMembershipRetry,
  'delivery-queue.ts': deliveryQueue,
  'delivery-receipt.ts': deliveryReceipt,
  'delivery-notices.ts': deliveryNotices,
  'reload-preview-clauses.ts': reloadPreviewClauses,
  'reload-recovery.ts': reloadRecovery,
  'shared-recovery.ts': sharedRecovery,
  'shared-state-reports.ts': sharedStateReports,
  'tag-description.ts': tagDescription,
  'tag-wrapper.ts': tagWrapper,
  'thread-memory-reports.ts': threadMemoryReports,
  'thread-memory-seal.ts': threadMemorySeal,
  'thread-memory.ts': threadMemory,
  'crontable.ts': crontable,
  'config.ts': config,
  'conflict-latch.ts': conflictLatch,
  'delivery-decision.ts': deliveryDecision,
  'delivery-constants.ts': deliveryConstants,
  'install-check-labels.ts': installCheckLabels,
  'invalid-flags-hold.ts': invalidFlagsHold,
  'live-row-sequence.ts': liveRowSequence,
  'liveness-reading.ts': livenessReading,
  'outage-state.ts': outageState,
  'pane-read.ts': paneRead,
  'pending-row.ts': pendingRow,
  'persona-diagnostics.ts': personaDiagnostics,
  'persona-episodes.ts': personaEpisodes,
  'persona-identity.ts': personaIdentity,
  'persona-notifier.ts': personaNotifier,
  'registry.ts': registry,
  'reload-apply.ts': reloadApply,
  'reload.ts': reload,
  'reload-plan.ts': reloadPlan,
  'reload-request.ts': reloadRequest,
  'reload-review.ts': reloadReview,
  'reload-fingerprint.ts': reloadFingerprint,
  'restart.ts': restart,
  'row-read-rules.ts': rowReadRules,
  'session-manager.ts': sessionManager,
  'shared-channels.ts': sharedChannels,
  'test-timer-overrides.ts': testTimerOverrides,
  'test-measurements.ts': testMeasurements,
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
  builderEntry: { fileArg: 0, nameArg: 1, kind: 'function' },
  derivedWaitEntry: { fixedFile: 'ad-settings.ts', nameArg: 0, kind: 'function' },
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
  'systemInstallTooOldMessage:foundByExport': 'FOUND_BY_EXPORTS',
  'conflictLatchSetHead:outcomeExport': 'LATCH_SET_OUTCOME_EXPORTS',
  'launchTimeoutFormTextOf:name': 'LAUNCH_TIMEOUT_FORM_EXPORTS',
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
  'liveRowRunLine:placementExport': { file: 'live-row-sequence.ts', prefix: 'LIVE_ROW_RUN_', kind: 'string' },
  'launchUnavailableGetLine:outcomeExport': { file: 'session-manager.ts', prefix: 'LAUNCH_UNAVAILABLE_OUTCOME_', kind: 'string' },
  'sequenceStartLine:stepExport': { file: 'live-row-sequence.ts', prefix: 'LIVE_ROW_SEQUENCE_ENTRY_', kind: 'defined' },
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

/** The string values of a top-level `const` initializer: an array of literals, or an object whose values are literals (`as const` read through). */
function collectionValues(init: ts.Expression): string[] | undefined {
  if (ts.isAsExpression(init)) return collectionValues(init.expression)
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
  test.each(['delivery-queue.ts:parseQueueRecord:function', 'delivery-queue.ts:slackKeyString:function'])(
    'shared queue evidence uses the production callable %s', ref => {
      expect(named.has(ref)).toBe(true)
    })
  test.each([
    'config.ts:readPersonaConfigBytes:function',
    'config.ts:parsePersonaConfigBytes:function',
    'shared-channels.ts:parseSharedChannelState:function',
    'shared-channels.ts:sharedAppliedConfig:function',
    'reload.ts:reloadSharedAuthorityStartLine:function',
  ])('shared-authority assertions use the production export %s', ref => {
    expect(named.has(ref)).toBe(true)
  })
  const scenario20Values: Readonly<Record<string, () => void>> = {
    // test-23 prints `AD_SETTING_MINIMUMS` for the two keys it writes at their
    // minimums, `starting_session_seconds` and `stopping_window_seconds`, and
    // looks both up in `AD_TMUX_KEYS`: each a positive whole number, each key listed.
    'ad-settings.ts:AD_TMUX_KEYS:defined': () => {
      expect(adSettings.AD_TMUX_KEYS).toContain('starting_session_seconds')
      expect(adSettings.AD_TMUX_KEYS).toContain('stopping_window_seconds')
    },
    'ad-settings.ts:AD_SETTING_MINIMUMS:defined': () => {
      const minimums = adSettings.AD_SETTING_MINIMUMS
      for (const key of ['starting_session_seconds', 'stopping_window_seconds'] as const) {
        const minimum = Object.hasOwn(minimums, key) ? minimums[key] : undefined
        expect(typeof minimum === 'bigint' || typeof minimum === 'number').toBe(true)
        expect(Number(minimum)).toBeGreaterThan(0)
      }
    },
    // The override block test-23 writes: the keys it names, the bound the printer checks them against.
    'config.ts:TEST_TIMER_OVERRIDE_KEYS:defined': () => {
      expect(config.TEST_TIMER_OVERRIDE_KEYS).toContain('latch_recheck_interval_ms')
    },
    'config.ts:MAX_TEST_TIMER_OVERRIDE_MS:defined': () => {
      expect(config.MAX_TEST_TIMER_OVERRIDE_MS).toBeGreaterThan(0)
    },
    'test-timer-overrides.ts:effectiveTestTimer:function': () => {
      expect(testTimerOverrides.effectiveTestTimer('latch_recheck_interval_ms', { latch_recheck_interval_ms: 7000 })).toBe(7000)
    },
    'test-timer-overrides.ts:buildTestTimerOverridesLine:function': () => {
      expect(testTimerOverrides.buildTestTimerOverridesLine({ latch_recheck_interval_ms: 7000 })).toContain('latch_recheck_interval_ms=7000')
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
    'ad-settings.ts:AD_TMUX_KEYS:defined',
    'ad-settings.ts:AD_SETTING_MINIMUMS:defined',
    'config.ts:TEST_TIMER_OVERRIDE_KEYS:defined',
    'config.ts:MAX_TEST_TIMER_OVERRIDE_MS:defined',
    'test-timer-overrides.ts:effectiveTestTimer:function',
    'test-timer-overrides.ts:buildTestTimerOverridesLine:function',
    'session-manager.ts:latchClearRetryAtOnceLineHead:function',
    'row-read-rules.ts:LATCHING_LIVENESS_NOTE:constant',
  ])("scenario 20's printer reads %s", (ref) => {
    expect(named.has(ref)).toBe(true)
    scenario20Values[ref]?.()
  })

  // test-29's lists the printer checks an argument against or prints whole:
  // each a non-empty array of strings, a class label on one line.
  const nonEmptyStrings = (value: unknown, oneLine: boolean): void => {
    expect(Array.isArray(value)).toBe(true)
    const list = value as readonly unknown[]
    expect(list.length).toBeGreaterThan(0)
    expect(list.filter((v) => typeof v !== 'string' || v === '' || (oneLine && v.includes('\n')))).toEqual([])
  }
  const test29Values: Readonly<Record<string, () => void>> = {
    'delivery-decision.ts:FUNGIBLE_REFUSALS:defined': () => nonEmptyStrings(deliveryDecision.FUNGIBLE_REFUSALS, false),
    'config.ts:CHANNEL_MODES:defined': () => nonEmptyStrings(config.CHANNEL_MODES, false),
    'config.ts:DELIVERY_MODES:defined': () => nonEmptyStrings(config.DELIVERY_MODES, false),
    'persona-diagnostics.ts:PERSONA_DIAGNOSTIC_CLASSES:defined': () => nonEmptyStrings(personaDiagnostics.PERSONA_DIAGNOSTIC_CLASSES, true),
  }

  // test-29's references (test-29-invited-channels.sh), each
  // `<file>:<export>:<kind>`: the invited-channel texts it matches, the
  // persona lines' framing, the switch's key (the configuration's and the
  // mode lookup's), mode name and class labels its upgrade phase checks no
  // line names, and the applied line, tmux session names and relaunch line
  // it reads beside them; with what the scenario reads of the value beyond
  // its kind, when it reads more.
  test.each([
    'reload-apply.ts:RELOAD_APPLIED:constant',
    'persona-identity.ts:personaKey:function',
    'persona-identity.ts:personaTmuxSessionName:function',
    'restart.ts:relaunchAfterKillLine:function',
    'restart.ts:RELAUNCH_KILL_NONE:string',
    'persona-diagnostics.ts:UNCLAIMED_CHANNEL:constant',
    'persona-diagnostics.ts:unclaimedChannelCause:function',
    'persona-diagnostics.ts:UNCLAIMED_REASON_EXTERNALLY_SHARED:constant',
    'persona-diagnostics.ts:UNCLAIMED_REASON_FLAG_MISSING:constant',
    'persona-diagnostics.ts:UNCLAIMED_REASON_FLAG_NOT_BOOLEAN:constant',
    'persona-diagnostics.ts:fungibleUnclaimedChannelCause:function',
    'delivery-decision.ts:FUNGIBLE_REFUSALS:defined',
    'persona-diagnostics.ts:PERSONA_INVITED_CHANNEL:constant',
    'persona-diagnostics.ts:invitedChannelCause:function',
    'persona-diagnostics.ts:PERSONA_CHANNEL_DELIVERY_SET:constant',
    'persona-diagnostics.ts:channelDeliverySetCause:function',
    'persona-diagnostics.ts:NO_STORED_CHOICE:string',
    'persona-diagnostics.ts:NO_STORED_CHOICE:constant',
    'channel-delivery.ts:SET_CHANNEL_DELIVERY_TOOL:constant',
    'registry.ts:channelDeliveryDeclarativeRefusal:function',
    'registry.ts:channelDeliveryChannelRefusal:function',
    'registry.ts:channelDeliveryValueRefusal:function',
    'registry.ts:channelDeliverySetResultText:function',
    'registry.ts:channelDeliveryAttemptResultText:function',
    'registry.ts:channelDeliveryAttemptInputRefusal:function',
    'registry.ts:channelDeliveryDryRunRefusal:function',
    'shared-channels.ts:createSharedChannelAuthority:function',
    'reload-plan.ts:modeSwitchLine:function',
    'config.ts:CHANNEL_MODES:defined',
    'config.ts:DELIVERY_MODES:defined',
    'config.ts:channelModeOf:function',
    'reload-plan.ts:MODE_SWITCH_SETTING:constant',
    'reload-plan.ts:MODE_SWITCH_SETTING:string',
    'channel-delivery.ts:CHANNEL_DELIVERY_FILE_NAME:constant',
    'persona-diagnostics.ts:formatPersonaDiagnostic:function',
    'persona-diagnostics.ts:PERSONA_DIAGNOSTIC_CLASSES:defined',
  ])("test-29's printer reads %s", (ref) => {
    expect(named.has(ref)).toBe(true)
    test29Values[ref]?.()
  })

  // test-47's refused starts and test-40's upgrade again: the current
  // package's exports these scenarios' entries print or run. The earlier
  // release's entries import another package, which this reader does not follow.
  test.each([
    'reload.ts:reloadFilePaths:function',
    'reload.ts:createReloadController:function',
    'config.ts:resolvePersonaConfig:function',
    'config.ts:PERSONA_TOP_LEVEL_KEYS:defined',
    'config.ts:PERSONA_ENTRY_KEYS:defined',
    'persona-diagnostics.ts:THREAD_MEMORY_CHANGED_WHILE_STOPPED:constant',
    'thread-memory-reports.ts:buildThreadMemoryChangedWhileStoppedNotice:function',
    'thread-memory-reports.ts:buildThreadMemoryChangedWhileStoppedLine:function',
  ])("test-47's and test-40's printer reads %s", (ref) => {
    expect(named.has(ref)).toBe(true)
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


// Execute declarations from a scratch copy, never the image-only entrypoint.
// Imports stay production implementations. Native client discovery is refused
// even if a future entry accidentally tries it. Mutations are scratch-only.
function sharedPrinterEvidence() {
  const captured: unknown[] = []
  const value = <T>(result: T): T => { captured.push(result); return result }
  const call = <T>(fn: () => T): T => {
    try {
      const result = fn()
      if (result instanceof Promise) return result.then(value, error => { value(error); throw error }) as T
      return value(result)
    } catch (error) { value(error); throw error }
  }
  const wrap = (module: any) => {
    module.setAuditLog?.((...args: unknown[]) => value(args))
    const entries = Object.fromEntries(Object.entries(module.ENTRIES ?? {}).map(([name, entry]: [string, any]) =>
      [name, { ...entry, print: (...args: any[]) => call(() => entry.print(...args)) }]))
    return { ...module, ...entries, ENTRIES: entries, entryValue: (...args: any[]) => call(() => module.entryValue(...args)) }
  }
  // Scan durable outputs at the write boundary, before a negative case can
  // replace/delete them. Credential input fixtures are deliberately not paths
  // in this list. Keep full Error objects until the outer finally so a leak
  // assertion cannot be mistaken for an expected printer rejection.
  const files = (...paths: string[]) => assertNoLeak(paths.map(writtenFile), 'shared printer written evidence')
  const methods = <T extends object>(target: T, outputs: () => string[]): T => new Proxy(target, {
    get(object, key) {
      const member = Reflect.get(object, key)
      if (typeof member !== 'function') return member
      return (...args: unknown[]) => {
        const result = call(() => Reflect.apply(member, object, args))
        if (result instanceof Promise) return result.finally(() => files(...outputs()))
        files(...outputs())
        return result
      }
    },
  })
  return { value, call, wrap, files, methods, scan: () => assertNoLeak(captured, 'shared printer results and errors') }
}
async function sharedPrinterControl(run: (fixture: {
  scratch: string; pkg: string; body: string; printer: any; evidence: ReturnType<typeof sharedPrinterEvidence>
}) => Promise<void>, isolated = false) {
  mkdirSync('/tmp/c9', { recursive: true })
  const scratch = mkdtempSync('/tmp/c9/shared-printer-audit-'), pkg = REPO_ROOT
  const previousRoot = process.env.SCENARIO_ROOT
  const source = readFileSync(PRINTER_PATH, 'utf8')
  writeFileSync(join(scratch, 'printer-source.ts'), source)
  const ast = ts.createSourceFile('printer.ts', source, ts.ScriptTarget.Latest, true)
  let body = ast.statements.filter(n => ts.isImportDeclaration(n) || ts.isFunctionDeclaration(n) ||
    ts.isVariableStatement(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isClassDeclaration(n))
    .map(n => n.getText(ast)).join('\n')
  body = body.replace("process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'", JSON.stringify(pkg))
    .replaceAll("import('./transcript-receipts.ts')", `import(${JSON.stringify(join(REPO_ROOT, 'tests/integration/fixtures/transcript-receipts.ts'))})`)
    .replace("return await import(Bun.resolveSync('agent-director', join(PKG_DIR, 'src')))", "throw new Error('native client forbidden in declaration audit')")
    .replace('process.exit(code)', 'throw new PrinterFailure(reason, code)')
    .replaceAll('console.error(', 'auditLog(')
  body = 'let auditLog = (..._args: unknown[]) => {}; export function setAuditLog(log: typeof auditLog) { auditLog = log }\n' + body
  const path = join(scratch, 'printer.ts')
  writeFileSync(path, body + '\nexport { entryValue, ENTRIES, sharedOwnPostState, membershipRetryDelay };\n')
  try {
    if (isolated) {
      // Recovery uses the guarded shared-authority writer. Its OS temp root
      // must contain the probe, even when the parent inherited another TMPDIR
      // or an earlier suite replaced process.env. Establish it at child launch;
      // never rebind the parent's environment or relax the writer's guard.
      const home = mkdtempSync(join(scratch, 'home-'))
      const scenario = join(scratch, 'scenario')
      mkdirSync(scenario)
      const control = join(scratch, 'control.ts')
      writeFileSync(join(scratch, 'declarations.ts'), body)
      writeFileSync(control, [
        "import assert from 'node:assert/strict'",
        "import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, truncateSync, statSync, readdirSync } from 'node:fs'",
        "import { join } from 'node:path'",
        `import { assertNoLeak, writtenFile } from ${JSON.stringify(join(pkg, 'tests/test-helpers/credentials.ts'))}`,
        sharedPrinterEvidence.toString(),
        `const scratch = ${JSON.stringify(scenario)}, pkg = ${JSON.stringify(pkg)}`,
        `const body = readFileSync(${JSON.stringify(join(scratch, 'declarations.ts'))}, 'utf8')`,
        `const evidence = sharedPrinterEvidence(), printer = evidence.wrap(await import(${JSON.stringify(path)}))`,
        `try { await evidence.call(() => (${run.toString()})({ scratch, pkg, body, printer, evidence })) } finally { evidence.scan() }`,
        "console.log('recovery/content controls complete')",
      ].join('\n'))
      const result = spawnSync(process.execPath, ['--preload', join(REPO_ROOT, 'tests/test-helpers/host-safety-preload.ts'), control], {
        env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: scratch, SCENARIO_ROOT: scenario, SLACK_STATE_DIR: join(home, 'state') } }),
        encoding: 'utf8', timeout: 4000,
      })
      assertNoLeak({ stdout: result.stdout, stderr: result.stderr, error: result.error })
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull()
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
      expect(result.stdout).toBe('recovery/content controls complete\n')
    } else {
      process.env.SCENARIO_ROOT = scratch
      const evidence = sharedPrinterEvidence()
      const printer = await import(path)
      try { await evidence.call(() => run({ scratch, pkg, body, printer: evidence.wrap(printer), evidence })) }
      finally { evidence.scan() }
    }
  }
  finally {
    if (previousRoot === undefined) delete process.env.SCENARIO_ROOT
    else process.env.SCENARIO_ROOT = previousRoot
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('SR-8 printer entries print the current package exports', () => sharedPrinterControl(async ({ printer, scratch }) => {
  const path = join(scratch, 'configured state', testMeasurements.TEST_MEASUREMENTS_FILE_NAME)
  const rows: Array<[string, string[], string | number]> = [
    ['TEST_MEASUREMENTS_FILE_NAME', [], testMeasurements.TEST_MEASUREMENTS_FILE_NAME],
    ['TEST_MEASUREMENTS_KEY', [], config.TEST_MEASUREMENTS_KEY],
    ['DELIVERY_MAX_AD_CALLS_PER_S', [], deliveryConstants.DELIVERY_MAX_AD_CALLS_PER_S],
    ['NAME_LOOKUP_TIMEOUT_MS', [], tagWrapper.NAME_LOOKUP_TIMEOUT_MS],
    ['QUEUE_COMPACT_INTERVAL_MS', [], deliveryQueue.QUEUE_COMPACT_INTERVAL_MS],
    ['buildTestMeasurementsStartLine', [path], testMeasurements.buildTestMeasurementsStartLine(path)],
  ]
  for (const [name, args, expected] of rows) expect(await printer.entryValue(name, args)).toBe(String(expected))
}))

describe('shared scenario printer evidence contracts', () => {
  test.skipIf(!mkfifoAvailable())('own-post reader refuses a real FIFO without blocking (requires mkfifo)', () => sharedPrinterControl(async ({ scratch, pkg }) => {
    const { threadJoin, postIntent } = await import(join(pkg, 'tests/test-helpers/thread-memory.ts'))
    const fact = threadJoin(), intent = postIntent(fact), fifo = join(scratch, 'memory-fifo')
    makeFifo(fifo)
    const probe = join(scratch, 'fifo-refusal.ts')
    writeFileSync(probe, `import { entryValue } from './printer.ts';
      import { assertNoLeak } from ${JSON.stringify(join(pkg, 'tests/test-helpers/credentials.ts'))};
      let result, error;
      try { result = await entryValue('sharedOwnPostState', JSON.parse(process.env.ENTRY_ARGS!)) }
      catch (caught) { error = caught }
      assertNoLeak({ result, error });
      if (error?.exitCode !== 1) process.exit(2);
    `)
    const child = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 2000,
      env: hostSafeChildEnv(scratch, { tools: [], extras: {
        SCENARIO_ROOT: scratch, SLACK_STATE_DIR: join(scratch, 'state'),
        ENTRY_ARGS: JSON.stringify([fifo, intent.operationId, fact.channel, JSON.stringify(fact.stamp), 'unresolved']),
      } }),
    })
    assertNoLeak({ stdout: child.stdout, stderr: child.stderr, error: child.error })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' })
  }), 5000)
  test('cancellation requires the exact current durable request and cleared review', () => sharedPrinterControl(async ({ scratch, pkg, body, printer, evidence }) => {
    const { entryValue: print, ENTRIES, sharedOwnPostState, membershipRetryDelay } = printer
    const { makePersonaConfigInput } = await import(join(pkg, 'tests/test-helpers/persona-config.ts'))
    const { parsePersonaConfigBytes, MAX_RELOAD_FILE_BYTES } = await import(join(pkg, 'src/config.ts'))
    const { initialSharedChannelState, serializeSharedChannelState, parseSharedChannelState, createSharedChannelAuthority } = await import(join(pkg, 'src/shared-channels.ts'))
    const { buildReviewRequest, composeReviewRequest, parseReviewRequestBytes } = await import(join(pkg, 'src/reload-request.ts'))
    const { createReviewObserver, reviewLedger } = await import(join(pkg, 'src/reload-review.ts'))
    const dir = mkdtempSync(join(scratch, 'authority-'))
    const config = join(dir, 'config.json'), record = config + '.last-applied'
    const input = Buffer.from(JSON.stringify(makePersonaConfigInput({}, dir)))
    writeFileSync(config, input)
    const initial = initialSharedChannelState(input, parsePersonaConfigBytes(input, config, dir))
    writeFileSync(record, serializeSharedChannelState(initial))
    const authority = evidence.methods(createSharedChannelAuthority(record, initial, { sourcePath: config, home: process.env.HOME }), () => [record])
    evidence.files(record)
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const observe = createReviewObserver()
    const observeNow = (label: string, pending: boolean) => {
      const result = evidence.call(() => observe(authority, hash(label), pending, authority.operatorIntent().generation, hash(input.toString())))
      assert.equal(result.result?.kind, 'applied')
    }
    const snapshot = (name: string) => { writeFileSync(join(dir, name), readFileSync(record)); evidence.files(record, join(dir, name)) }
    const checks: string[] = []
    async function rejects(label: string, submitted: string, recordPath = record) {
      await assert.rejects(print('operatorReviewCancelled', [config, recordPath, submitted]), /cancellation|authority/)
      checks.push(label)
    }
    async function passes(label: string, submitted: string) {
      const before = readFileSync(record)
      assert.equal(await print('operatorReviewCancelled', [config, record, submitted]), '')
      assert.deepEqual(readFileSync(record), before, 'observer must not write the authority')
      checks.push(label)
    }

    const emptyCancel = composeReviewRequest(buildReviewRequest('not-processed', 0, 'cancel'))
    await rejects('no intent/review before processing does not pass', emptyCancel)
    const request = buildReviewRequest('request-one', 0, 'request')
    assert.equal(authority.requestReview(request, input).kind, 'recorded')
    observeNow('original-review', true)
    const oldReview = reviewLedger(authority.snapshot())!.active!
    const submitted = await print('operatorReviewRequest', [config, record, 'cancel-one', 'cancel'])
    const cancel = parseReviewRequestBytes(Buffer.from(submitted))!
    assert.equal(cancel.action, 'cancel')
    snapshot('before-cancel')
    await rejects('active requested review before processing does not pass', submitted)
    assert.equal(authority.requestReview(cancel, input).kind, 'recorded')
    snapshot('cancel-recorded-active-review')
    await rejects('recorded cancel with prior active review still does not pass', submitted)
    observeNow('cancelled-review', false)
    assert.equal(reviewLedger(authority.snapshot())!.outcomes[oldReview.fingerprint]!.status, 'superseded')
    snapshot('cancelled')
    await passes('exact durable current cancellation passes with old review revoked', submitted)
    await rejects('wrong request ID does not pass', composeReviewRequest(buildReviewRequest('wrong-id', cancel.intent_generation, 'cancel')))
    await rejects('same ID with different base generation does not pass', composeReviewRequest(buildReviewRequest(cancel.request_id, cancel.intent_generation + 1, 'cancel')))
    await rejects('wrong action does not pass', composeReviewRequest(buildReviewRequest(cancel.request_id, cancel.intent_generation, 'refresh')))
    await rejects('invalid request grammar does not pass', '{"action":"cancel"}')
    // Existing old waiter is a failing-before control against the same valid cancellation.
    await assert.rejects(print('operatorReviewPending', [config, record, config + '.pending', cancel.request_id]), /pending review/)
    checks.push('previous pending waiter rejects the successfully cancelled state')
    // Durable proof is independent of a leftover preview file or a replaced request file.
    writeFileSync(config + '.pending', 'obsolete preview')
    writeFileSync(config + '.request', composeReviewRequest(buildReviewRequest('replacement', authority.operatorIntent().generation, 'cancel')))
    await passes('leftover preview/replaced request file cannot retarget retained cancellation', submitted)

    const refreshed = buildReviewRequest('refresh-after-cancel', authority.operatorIntent().generation, 'refresh')
    assert.equal(authority.requestReview(refreshed, input).kind, 'recorded')
    snapshot('refreshed-intent-no-active-review')
    await rejects('later requested intent rejects old cancellation even without active review', submitted)
    observeNow('refreshed-review', true)
    snapshot('refreshed-active-review')
    await rejects('later active review rejects old cancellation', submitted)
    const cancelTwo = buildReviewRequest('cancel-two', authority.operatorIntent().generation, 'cancel')
    assert.equal(authority.requestReview(cancelTwo, input).kind, 'recorded')
    observeNow('second-cancellation', false)
    snapshot('second-cancellation')
    await rejects('later cleared cancellation cannot make an old tombstone current', submitted)
    await passes('second exact cancellation passes', composeReviewRequest(cancelTwo))
    // Read back and reopen through production APIs; observation remains read-only.
    const reopened = evidence.methods(createSharedChannelAuthority(record, parseSharedChannelState(readFileSync(record), record, { sourcePath: config })!, { sourcePath: config, home: process.env.HOME }), () => [record])
    assert.equal(reopened.requestReview(cancelTwo, input).kind, 'duplicate')
    await passes('reopened authority and exact duplicate preserve cancellation proof', composeReviewRequest(cancelTwo))

    // Planted malformed/contradictory records stay scratch-only and use the full parser.
    const good = readFileSync(record)
    for (const [name, mutate] of [
      ['requested-with-current-cancel', (state: any) => { state.pendingIntent.operator.requested = true }],
      ['wrong-recorded-action', (state: any) => { state.pendingIntent.operator.requests[cancelTwo.request_id].request.action = 'refresh' }],
      ['invalid-recorded-generation', (state: any) => { state.pendingIntent.operator.requests[cancelTwo.request_id].generation++ }],
    ] as const) {
      const state = JSON.parse(good.toString()); mutate(state)
      writeFileSync(record, JSON.stringify(state))
      await rejects(name, composeReviewRequest(cancelTwo))
    }
    writeFileSync(record, good)
    await rejects('missing authority cannot pass', submitted, join(dir, 'missing-record'))
    writeFileSync(join(dir, 'bad-record'), '{broken')
    await rejects('malformed authority cannot pass', submitted, join(dir, 'bad-record'))
    mkdirSync(join(dir, 'directory-record'))
    await rejects('nonregular authority cannot pass', submitted, join(dir, 'directory-record'))
    writeFileSync(join(dir, 'oversized-record'), Buffer.alloc(MAX_RELOAD_FILE_BYTES + 1, 32))
    await rejects('bounded production reader rejects oversized authority', submitted, join(dir, 'oversized-record'))

  }))
  test('own-post journals bind exact operation, channel, stamp and complete outcome evidence', () => sharedPrinterControl(async ({ scratch, pkg, body, printer, evidence }) => {
    const { entryValue: print, ENTRIES, sharedOwnPostState, membershipRetryDelay } = printer
    const memory = await import(join(pkg, 'src/thread-memory.ts'))
    const timing = await import(join(pkg, 'src/channel-membership-retry.ts'))
    const { threadHeader, threadJoin, joinRecord, postIntent, postOutcome } = await import(join(pkg, 'tests/test-helpers/thread-memory.ts'))
    const header = threadHeader(), fact = threadJoin(), intent = postIntent(fact), outcome = postOutcome(intent)
    const path = join(scratch, 'post-memory.jsonl')
    const stamp = JSON.stringify(fact.stamp)
    const args = (expected = 'unresolved', operation = intent.operationId, channel = fact.channel, expectedStamp = stamp) =>
      [path, operation, channel, expectedStamp, expected]
    const state = (expected = 'unresolved', operation = intent.operationId, channel = fact.channel, expectedStamp = stamp) =>
      print('sharedOwnPostState', args(expected, operation, channel, expectedStamp))
    const write = (rows: any[], tail = '') => writeFileSync(path, Buffer.concat([memory.serializeThreadMemoryRecords(rows), Buffer.from(tail)]))
    const failure = async (f: () => Promise<unknown>, code = 1, pattern?: RegExp) => {
      await assert.rejects(f(), (e: any) => {
        assert.equal(e.exitCode, code, e.message)
        assert(!e.message.includes('PRIVATE_EVIDENCE_SENTINEL'))
        if (pattern) assert.match(e.message, pattern)
        return true
      })
    }
    let checks = 0
    async function check(name: string, fn: () => unknown) { try { await fn(); checks++ } catch (error) { throw new Error(name, { cause: error }) } }
    for (const name of ['MEMBERSHIP_REQUEST_TIMEOUT_MS', 'MEMBERSHIP_ATTEMPT_TIMEOUT_MS', 'MEMBERSHIP_RETRY_MIN_MS', 'MEMBERSHIP_RETRY_MAX_MS', 'MEMBERSHIP_PAGE_LIMIT']) {
      await check('constant is the production export: ' + name, async () => {
        assert.equal(await print(name, []), String(timing[name]))
        const fake = { importPackageModule: async (module: string) => { assert.equal(module, 'channel-membership-retry.ts'); return { [name]: 12345 } } }
        assert.equal(await ENTRIES[name].print([], fake), '12345')
      })
    }
    await check('retry calculator forwards failures, Retry-After and fractional seconds', async () => {
      for (const failures of [0, 1, 4, 20, 100]) for (const after of [undefined, 0, 12.34567, 120, Number.MAX_SAFE_INTEGER]) {
        const args = [String(failures), ...(after === undefined ? [] : [String(after)])]
        assert.equal(await print('membershipRetryDelay', args), String(timing.membershipRetryDelay(failures, after)))
      }
      let forwarded: any[] | undefined
      assert.equal(await membershipRetryDelay.print(['3', '123.4'], {importPackageModule: async (module: string) => {
        assert.equal(module, 'channel-membership-retry.ts'); return { membershipRetryDelay: (...args: any[]) => { forwarded = args; return 6789 } }
      }}), '6789')
      assert.deepEqual(forwarded, [3, 123.4])
    })
    await check('invalid retry arguments fail before import', async () => {
      for (const args of [[], ['-1'], ['1.1'], ['NaN'], [''], ['0', ''], ['0', 'Infinity'], ['0', '-1'], ['1', '1', '1']]) {
        await failure(() => membershipRetryDelay.print(args, {importPackageModule() { throw new Error('must not import') }}))
      }
    })
    await check('exact complete unresolved intent passes read-only', async () => {
      write([header, intent]); const before = readFileSync(path), stat = statSync(path), names = readdirSync(scratch)
      assert.deepEqual(JSON.parse(await state()), { intent, outcome: null })
      assert.deepEqual(readFileSync(path), before); assert.equal(statSync(path).mtimeMs, stat.mtimeMs)
      assert.deepEqual(readdirSync(scratch), names)
    })
    await check('projection includes only actual intent/outcome records, not the header key', async () => {
      write([header, joinRecord(fact), intent, outcome])
      assert.deepEqual((await print('sharedOwnPostRecords', [path])).split('\n').map((line: string) => JSON.parse(line)), [intent, outcome])
      assert(!(await print('sharedOwnPostRecords', [path])).includes(header.digestKey))
    })
    await check('parser comes from installed production module, never load/repair', async () => {
      write([header, intent]); let parsed = 0
      const ctx = {importPackageModule: async (module: string) => {
        assert.equal(module, 'thread-memory.ts')
        return {parseThreadMemoryRecord: (line: string) => { parsed++; return memory.parseThreadMemoryRecord(line) }}
      }}
      assert.deepEqual(JSON.parse(await sharedOwnPostState.print(args(), ctx)), {intent, outcome:null}); assert.equal(parsed, 2)
      await failure(() => sharedOwnPostState.print(args(), {importPackageModule: async () => ({parseThreadMemoryRecord: () => undefined})}))
    })
    await check('empty and header-only are pending, not durable intent evidence', async () => {
      for (const rows of [[], [header]]) { write(rows); await failure(state, 75) }
    })
    await check('absent exact operation remains pending beside an unrelated operation', async () => {
      write([header, {...intent, operationId: intent.operationId + '-other'}]); await failure(state, 75)
    })
    await check('wrong channel fails immediately', async () => { write([header, intent]); await failure(() => state('unresolved', intent.operationId, fact.channel + 'X'), 1, /another channel/) })
    await check('stale incarnation fails immediately', async () => { write([header, intent]); await failure(() => state('unresolved', intent.operationId, fact.channel, JSON.stringify({...fact.stamp, incarnation: 'different'})), 1, /Channel Stamp/) })
    await check('stale hybrid-since fails immediately', async () => { write([header, intent]); await failure(() => state('unresolved', intent.operationId, fact.channel, JSON.stringify({...fact.stamp, threadHybridSince: 'different'})), 1, /Channel Stamp/) })
    for (const result of ['joined', 'none']) await check('durable '+result+' outcome rejects unresolved and contrary result', async () => {
      const recorded = postOutcome(intent, result); write([header, intent, recorded])
      assert.deepEqual(JSON.parse(await state(result)), {intent, outcome:recorded})
      await failure(state, 1, /already has/)
      await failure(() => state(result === 'joined' ? 'none' : 'joined'), 1, /differs/)
    })
    await check('unresolved intent waits for requested joined or none outcome', async () => {
      write([header, intent]); await failure(() => state('joined'), 75); await failure(() => state('none'), 75)
    })
    await check('another operation outcome cannot resolve the target', async () => {
      const other = {...intent, seq: intent.seq + 1, operationId: intent.operationId + '-other'}
      write([header, intent, other, postOutcome(other)]); assert.equal(JSON.parse(await state()).outcome, null)
      await failure(() => state('joined'), 75)
    })
    await check('torn intent is pending and leaves bytes unchanged', async () => {
      write([header], JSON.stringify(intent)); const before = readFileSync(path)
      await failure(state, 75); assert.deepEqual(readFileSync(path), before)
    })
    await check('torn outcome cannot turn a complete intent into an unresolved PASS', async () => {
      write([header, intent], JSON.stringify(outcome)); await failure(state, 75)
      await failure(() => print('sharedOwnPostRecords', [path]), 75)
    })
    await check('malformed complete record fails even with a partial tail', async () => {
      write([header, intent], '{PRIVATE_EVIDENCE_SENTINEL}\n{'); await failure(state)
    })
    await check('invalid UTF-8 complete records fail', async () => {
      const bad = Buffer.from(JSON.stringify(intent).replace(intent.operationId, 'PRIVATE_EVIDENCE_SENTINEL'))
      bad[bad.indexOf('PRIVATE_EVIDENCE_SENTINEL')] = 0xff
      writeFileSync(path, Buffer.concat([memory.serializeThreadMemoryRecords([header]), bad, Buffer.from('\n')]))
      await failure(state)
    })
    await check('duplicate sequence fails', async () => { write([header, intent, {...outcome,seq:intent.seq}]); await failure(state) })
    await check('reordered sequence fails', async () => { write([header, intent, {...outcome,seq:intent.seq-1}]); await failure(state) })
    await check('duplicate intent fails even when independently parseable', async () => { write([header, intent, {...intent,seq:intent.seq+1}]); await failure(state) })
    await check('orphan outcome fails', async () => { write([header, outcome]); await failure(state) })
    await check('duplicate outcome fails', async () => { write([header,intent,outcome,{...outcome,seq:outcome.seq+1}]); await failure(state) })
    await check('missing or duplicate header fails', async () => {
      write([intent]); await failure(state)
      write([header, {...header,seq:header.seq+1,highWater:header.highWater+1}, intent]); await failure(state)
    })
    await check('compacted unresolved intent with sparse seq/high-water still passes', async () => {
      write([{...header,highWater:intent.seq+100}, intent]); assert.equal(JSON.parse(await state()).intent.operationId, intent.operationId)
    })
    await check('compaction dropping resolved records gives no invented outcome', async () => {
      write([{...header, highWater:outcome.seq}]); await failure(() => state('none'), 75)
    })
    await check('bad identity, stamp and state arguments fail', async () => {
      write([header,intent])
      for (const op of ['', '../x', 'PRIVATE_EVIDENCE_SENTINEL!']) { if (op) await failure(() => state('unresolved',op)) }
      for (const stamp of ['{bad}', '{}', 'null', '[]', JSON.stringify({...fact.stamp,extra:true}), JSON.stringify({...fact.stamp,incarnation:''})]) {
        await failure(() => state('unresolved',intent.operationId,fact.channel,stamp))
      }
      await failure(() => state('unexpected')); await failure(() => state('unresolved',intent.operationId,'../x'))
    })
    await check('missing file fails, never exists-only inference', async () => {
      unlinkSync(path); await failure(state)
    })
    await check('directory and symlink are refused', async () => {
      const directory = join(scratch,'directory'); mkdirSync(directory,{recursive:true})
      await failure(() => print('sharedOwnPostState',[directory,...args().slice(1)]))
      write([header,intent]); const linked = join(scratch,'memory-link'); try {unlinkSync(linked)} catch {}
      symlinkSync(path,linked); await failure(() => print('sharedOwnPostState',[linked,...args().slice(1)]))
    })
    await check('injected nonregular descriptor is refused before reading and is closed', async () => {
      write([header, intent])
      const injected = join(scratch, 'nonregular.ts')
      const imports = 'closeSync, fstatSync, readSync,'
      assert(body.includes(imports))
      writeFileSync(injected, body.replace(imports, 'closeSync as realCloseSync, fstatSync as realFstatSync, readSync as realReadSync,') + `
        let reads = 0, closes = 0;
        const fstatSync = fd => ({ ...realFstatSync(fd), isFile: () => false });
        const readSync = (...args) => { reads++; return realReadSync(...args) };
        const closeSync = fd => { closes++; return realCloseSync(fd) };
        export { entryValue }; export const counts = () => ({ reads, closes });
      `)
      const mod = evidence.wrap(await import(injected))
      await failure(() => mod.entryValue('sharedOwnPostState', args()), 1, /non-regular/)
      assert.deepEqual(evidence.value(mod.counts()), { reads: 0, closes: 1 })
    })
    await check('oversized regular file is refused before body parsing', async () => {
      write([header,intent]); truncateSync(path,64*1024*1024+1); await failure(state); write([header,intent])
    })
    await check('outcome-blind mutant incorrectly accepts resolved intent (negative control)', async () => {
      const needle = "if (expected === 'unresolved') evidenceAssert(!outcome, 'own-post intent already has a durable outcome')"
      assert(body.includes(needle))
      const mutant = join(scratch,'outcome-blind.ts')
      writeFileSync(mutant,body.replace(needle,"if (expected === 'unresolved') {}")+'\nexport { entryValue };\n')
      const mod = evidence.wrap(await import(mutant)); write([header,intent,outcome])
      await failure(state); assert.equal(JSON.parse(await mod.entryValue('sharedOwnPostState',args())).outcome.outcome,'joined')
    })
    await check('tail-blind mutant incorrectly accepts intent before torn outcome (negative control)', async () => {
      const mutant = join(scratch,'tail-blind.ts')
      assert(body.includes('!header || end !== bytes.length'))
      writeFileSync(mutant,body.replace('!header || end !== bytes.length','!header')+'\nexport { entryValue };\n')
      const mod = evidence.wrap(await import(mutant)); write([header,intent],JSON.stringify(outcome))
      await failure(state,75); assert.equal(JSON.parse(await mod.entryValue('sharedOwnPostState',args())).outcome,null)
    })
  }))
  test('recovery and injected-content observers reject changed identities and missing receipts', () => sharedPrinterControl(async ({ scratch, pkg, body, printer, evidence }) => {
    const { entryValue: print, ENTRIES, sharedOwnPostState, membershipRetryDelay } = printer
    const shared = await import(join(pkg, 'tests/test-helpers/shared-channels.ts'))
    const persona = await import(join(pkg, 'tests/test-helpers/persona-config.ts'))
    const recovery = await import(join(pkg, 'src/shared-recovery.ts'))
    const startup = await import(join(pkg, 'src/reload-recovery.ts'))
    const stateModule = await import(join(pkg, 'src/shared-channels.ts'))
    const reviewModule = await import(join(pkg, 'src/reload-review.ts'))
    const fingerprint = await import(join(pkg, 'src/reload-fingerprint.ts'))
    const requestModule = await import(join(pkg, 'src/reload-request.ts'))
    const retired = await import(join(pkg, 'src/retired-keys.ts'))
    const tags = await import(join(pkg, 'src/tag-wrapper.ts'))
    const cron = await import(join(pkg, 'src/crontable.ts'))
    const queueFixtures = await import(join(pkg, 'tests/test-helpers/delivery-queue.ts'))
    const { constants: fsConstants } = await import('node:fs')
    let checks = 0
    async function check(name: string, fn: () => unknown) { try { await fn(); checks++ } catch (error) { throw new Error(name, { cause: error }) } }
    async function failure(fn: () => Promise<unknown>, pattern?: RegExp) {
      await assert.rejects(fn(), (e: any) => {
        assert.equal(e.exitCode, 1, e.message)
        assert(!e.message.includes('PRIVATE_SENTINEL'))
        if (pattern) assert.match(e.message, pattern)
        return true
      })
    }
    for (const [name,module] of [['RELOAD_STALE_CONFIRMATION','reload-apply.ts'],['RELOAD_RECORD_WRITE_FAILED','reload.ts']]) await check('installed constant '+name, async () => {
      assert.equal(await print(name,[]), (await import(join(pkg,'src',module)))[name])
      assert.equal(await ENTRIES[name].print([], {importPackageModule: async (p: string) => {assert.equal(p,module);return {[name]:'forwarded'}}}), 'forwarded')
    })
    const dir = mkdtempSync(join(scratch,'recovery-')), damagedPath = join(dir,'damaged'), replacementPath = join(dir,'replacement')
    const damaged = Buffer.from([0x00,0xff,0xfe,0x31,0x0a])
    const input = persona.makePersonaConfigInput({}, dir), replacement = shared.configBytes(input)
    writeFileSync(damagedPath, damaged); writeFileSync(replacementPath, replacement)
    for (const replace of [false,true]) await check('request equals existing unit builder, exact binary evidence '+replace, async () => {
      const args = ['repair-binary', damagedPath, ...(replace ? [replacementPath] : [])]
      const got = JSON.parse(await print('sharedRecoveryRequest',args))
      assert.deepEqual(got, shared.sharedRecoveryRequest('repair-binary', damaged, replace ? replacement : undefined))
      assert.deepEqual(recovery.parseSharedRecoveryRequest(got), got)
      assert.deepEqual(readFileSync(damagedPath),damaged)
    })
    await check('recovery request uses installed hash/format/parser only', async () => {
      let called = 0
      const ctx = {importPackageModule: async (name: string) => {
        if(name === 'reload-request.ts') return {REVIEW_REQUEST_FORMAT:'installed-format'}
        assert.equal(name,'shared-recovery.ts')
        return {recoveryHash:(bytes: Buffer)=>{assert.deepEqual(bytes,damaged); return 'installed-hash'},parseSharedRecoveryRequest:(v: any)=>{called++;assert.equal(v.format,'installed-format');assert.equal(v.evidence_sha256,'installed-hash');return {validated:true}}}
      }}
      assert.deepEqual(JSON.parse(await ENTRIES.sharedRecoveryRequest.print(['id',damagedPath],ctx)),{validated:true});assert.equal(called,1)
    })
    await check('request refuses invalid identity through production parser', async () => {
      await failure(()=>print('sharedRecoveryRequest',['bad id',damagedPath]))
    })
    for (const kind of ['missing','directory','symlink','outside','parent-symlink','oversized']) await check('raw evidence guard '+kind, async () => {
      let p = join(dir,'guard-'+kind)
      if(kind === 'directory') mkdirSync(p)
      if(kind === 'symlink') symlinkSync(damagedPath,p)
      if(kind === 'outside') p='/etc/hosts'
      if(kind === 'parent-symlink') {symlinkSync('/etc',p); p=join(p,'hosts')}
      if(kind === 'oversized') {writeFileSync(p,'');truncateSync(p,64*1024*1024+1)}
      await failure(()=>print('sharedRecoveryRequest',['valid-id',p]))
    })
    await check('unset scratch root fails before any evidence read',async()=>{
      delete process.env.SCENARIO_ROOT
      await failure(()=>print('sharedRecoveryRequest',['id',damagedPath]))
      process.env.SCENARIO_ROOT=scratch
    })

    async function fixture(action: 'restore'|'replace') {
      const root = mkdtempSync(join(scratch,action+'-'))
      const paths = {config:join(root,'config.json'),lastApplied:join(root,'config.json.last-applied'),pending:join(root,'config.json.pending'),apply:join(root,'config.json.apply')}
      const input = persona.makePersonaConfigInput({},root), bytes=shared.configBytes(input)
      writeFileSync(paths.config,bytes)
      const authority = evidence.methods(shared.makeSharedAuthority(root,input), () => [paths.lastApplied])
      evidence.files(paths.lastApplied)
      writeFileSync(paths.lastApplied,damaged)
      const damage = join(root,'damage');writeFileSync(damage,damaged)
      const replacement = join(root,'replacement');writeFileSync(replacement,bytes)
      const request = join(root,'retained-request')
      writeFileSync(request,await print('sharedRecoveryRequest',[action+'-request',damage,...(action==='replace'?[replacement]:[])]))
      copyFileSync(request,paths.config+requestModule.REVIEW_REQUEST_SUFFIX)
      const parsed = recovery.readSharedRecoveryRequest(readFileSync(request))!
      if(action==='restore') assert.equal(authority.stageRestoration(parsed,damaged,bytes).kind,'unresolved')
      const keys = evidence.call(() => retired.loadRetiredKeyStore(root,{log: (...args: unknown[]) => evidence.value(args)}));assert.equal(keys.kind,'loaded')
      const deps = {paths,home:process.env.HOME,dryRun:true,retiredKeys:keys.store,write:writeFileSync,remove:unlinkSync,log: (...args: unknown[]) => evidence.value(args)}
      const recover = () => {
        try { return evidence.call(() => startup.runStartupRecovery(deps)) }
        finally { evidence.files(...[paths.config,paths.lastApplied,paths.pending,paths.apply,join(root,'retired-keys.json')].filter(existsSync)) }
      }
      assert.equal(recover(),'pending')
      evidence.files(request)
      const args = [paths.config,paths.lastApplied,request,paths.pending]
      const read = ()=>stateModule.parseSharedChannelState(readFileSync(paths.lastApplied),paths.lastApplied,{sourcePath:paths.config})!
      const saved = readFileSync(paths.lastApplied), preview=readFileSync(paths.pending), requestBytes=readFileSync(request)
      return {root,paths,args,read,saved,preview,request,requestBytes,deps,recover}
    }
    for (const action of ['restore','replace'] as const) {
      const f = await fixture(action)
      await check(action+' production-created preview passes read-only exact observation',async()=>{
        const beforeStat=statSync(f.paths.lastApplied), names=readdirSync(f.root)
        const got = JSON.parse(await print('sharedRecoveryPending',f.args))
        assert.equal(got.phase,'review');assert.equal(got.action,action);assert.equal(got.boundary,f.read().recovery.boundary)
        assert.deepEqual(readFileSync(f.paths.lastApplied),f.saved);assert.equal(statSync(f.paths.lastApplied).mtimeMs,beforeStat.mtimeMs);assert.deepEqual(readdirSync(f.root),names)
        assert(!JSON.stringify(got).includes('Base64'))
        await failure(()=>print('sharedRecoveryConsumed',f.args))
      })
      for(const field of ['request_id','evidence_sha256','replacement_source_base64']) {
        if(field==='replacement_source_base64'&&action==='restore') continue
        await check(action+' rejects wrong exact request '+field,async()=>{
          const value=JSON.parse(f.requestBytes.toString())
          value[field]=field==='request_id'?'other-id':field==='evidence_sha256'?'a'.repeat(64):Buffer.from('other input').toString('base64')
          writeFileSync(f.request,JSON.stringify(value));await failure(()=>print('sharedRecoveryPending',f.args));writeFileSync(f.request,f.requestBytes)
        })
      }
      await check(action+' rejects absent/invalid authority and stale/modified preview',async()=>{
        writeFileSync(f.paths.lastApplied,damaged);await failure(()=>print('sharedRecoveryPending',f.args));writeFileSync(f.paths.lastApplied,f.saved)
        writeFileSync(f.paths.pending,f.preview.toString()+'changed');await failure(()=>print('sharedRecoveryPending',f.args))
        writeFileSync(f.paths.pending,f.preview.toString().replace(fingerprint.parsePendingFingerprint(f.preview.toString())!,'a'.repeat(64)));await failure(()=>print('sharedRecoveryPending',f.args))
        writeFileSync(f.paths.pending,f.preview)
      })
      await check(action+' prepared input changed refuses pending',async()=>{
        const bytes=readFileSync(f.paths.config);writeFileSync(f.paths.config,Buffer.concat([bytes,Buffer.from('\n')]))
        await failure(()=>print('sharedRecoveryPending',f.args));writeFileSync(f.paths.config,bytes)
      })
      if(action==='replace') await check('cancelled proposal cannot satisfy pending evidence',async()=>{
        const a=evidence.methods(stateModule.createSharedChannelAuthority(f.paths.lastApplied,f.read(),{sourcePath:f.paths.config}), () => [f.paths.lastApplied])
        const req=requestModule.buildReviewRequest('cancel-recovery',a.operatorIntent().generation,'cancel',[])
        assert.equal(a.requestReview(req,readFileSync(f.paths.config)).kind,'recorded')
        await failure(()=>print('sharedRecoveryPending',f.args));writeFileSync(f.paths.lastApplied,f.saved)
      })
      await check(action+' real scratch activation supplies durable consumed evidence',async()=>{
        copyFileSync(f.paths.pending,f.paths.apply)
        assert.equal(f.recover(),'activated')
        const got=JSON.parse(await print('sharedRecoveryConsumed',f.args));assert.equal(got.phase,'active')
        await failure(()=>print('sharedRecoveryPending',f.args))
        const state=f.read(), outcome=reviewModule.reviewLedger(state).outcomes[got.fingerprint]
        assert.equal(state.recovery.activation.order,outcome.revision)
        const activeBytes=readFileSync(f.paths.lastApplied)
        writeFileSync(f.paths.lastApplied,f.saved);await failure(()=>print('sharedRecoveryConsumed',f.args));writeFileSync(f.paths.lastApplied,activeBytes)
        const wrong=JSON.parse(f.requestBytes.toString());wrong.request_id='different-request';writeFileSync(f.request,JSON.stringify(wrong))
        await failure(()=>print('sharedRecoveryConsumed',f.args));writeFileSync(f.request,f.requestBytes)
      })
    }
    await check('scratch mutation dropping exact request equality admits a foreign request',async()=>{
      const f=await fixture('replace'), wrong=JSON.parse(f.requestBytes.toString());wrong.request_id='foreign-id'
      writeFileSync(f.request,JSON.stringify(wrong));await failure(()=>print('sharedRecoveryPending',f.args))
      const mutant=join(scratch,'mutant-request.ts')
      const changed=body.replace(' || !isDeepStrictEqual(recovery.request, request)', '')
      assert.notEqual(changed,body);writeFileSync(mutant,changed+'\nexport {entryValue};\n')
      const m=evidence.wrap(await import(mutant))
      assert.equal(JSON.parse(await m.entryValue('sharedRecoveryPending',f.args)).request_id,'foreign-id')
    })
    const table=join(dir,'crontable'), prompt=join(dir,'scheduled.prompt.md')
    await check('cron identity is production parsed from independently retained schedule',async()=>{
      const contents='# header\n* * * * * '+prompt+' Alpha\n';writeFileSync(table,contents)
      assert.equal(await print('sharedCronIdentity',[table,prompt]),cron.parseCrontable(contents).schedules[0].identity)
      for(const bytes of ['',contents+contents,'invalid\n'+contents]) {writeFileSync(table,bytes);await failure(()=>print('sharedCronIdentity',[table,prompt]))}
      writeFileSync(table,contents);await failure(()=>print('sharedCronIdentity',[table,prompt+'other']))
    })
    await check('injected parts match production without Slack fields, Unicode and multipart',async()=>{
      for(const text of ['🐝 <tag> & text\nline', '🙂'.repeat(20000)]) {
        const parts=JSON.parse(await print('sharedInjectedExpectedParts',[text,'1700000000.000001','custom-sender']))
        assert.deepEqual(parts,tags.buildTagParts({user:'custom-sender',ts:'1700000000.000001',text}))
      }
    })
    for(const source of ['cron','interject']) {
      const root=mkdtempSync(join(scratch,'queue-')),key='alpha',log=join(root,'server.log'),snapshot=join(root,'snapshot.jsonl')
      const work=join(root,'work-alpha'),project=join(process.env.HOME!,'.claude','projects',work.replace(/[/._]/g,'-')),transcript=join(project,'session.jsonl')
      mkdirSync(work)
      assert(!project.startsWith(scratch + '/'))
      mkdirSync(project,{recursive:true})
      writeFileSync(log,'');writeFileSync(transcript,'')
      const q=evidence.methods(await queueFixtures.makeQueue(root,{now:()=>100}), () => [queueFixtures.queuePath(root,key)].filter(existsSync))
      const text='PRIVATE_SENTINEL 🐝 '+source, sender='custom-'+source
      await q.accept(key,queueFixtures.injectedInput({source,sender,text,received_at:100}))
      const accepted=q.items(key)[0].accepted, parts=JSON.parse(await print('sharedInjectedExpectedParts',[text,accepted.ts,sender]))
      await q.append(key,queueFixtures.fixedRecord(accepted.seq,parts))
      await q.append(key,{...queueFixtures.sentRecord(accepted.seq),at:101,session_id:'session',transcript_path:transcript})
      await q.append(key,{...queueFixtures.deliveredRecord(accepted.seq,110),receipt:{path:transcript,uuid:'receipt'}})
      const take={type:'user',uuid:'receipt',sessionId:'session',timestamp:105,message:{role:'user',content:parts[0]}}
      writeFileSync(transcript,JSON.stringify(take)+'\n')
      writeFileSync(snapshot,await print('sharedQueueSnapshot',[queueFixtures.queuePath(root,key)]))
      evidence.files(snapshot)
      const bytes=readFileSync(snapshot),args=[key,log,snapshot,source,sender,accepted.ts,text,JSON.stringify(parts)]
      await check(source+' exact injected original plus own-session receipt passes',async()=>{
        const out=JSON.parse(await print('sharedAssertInjectedContent',args));assert.equal(out.source,source);assert.equal(out.sender,sender);assert.equal(out.ts,accepted.ts);assert.equal(out.complete,true)
        assert(!JSON.stringify(out).includes(text));assert.deepEqual(readFileSync(snapshot),bytes)
      })
      await check(source+' wrong source/sender/time/text/parts each fail',async()=>{
        for(const [index,value] of [[3,source==='cron'?'interject':'cron'],[4,'wrong-sender'],[5,'1.000001'],[6,'different'],[7,'["wrong"]']] as const) {
          const bad=[...args];bad[index]=value;await failure(()=>print('sharedAssertInjectedContent',bad))
        }
      })
      await check(source+' missing/stale/foreign/text-mismatched receipt cannot pass',async()=>{
        for(const record of [null,{...take,sessionId:'foreign'},{...take,timestamp:99},{...take,message:{role:'user',content:'wrong'}}]) {
          writeFileSync(transcript,record?JSON.stringify(record)+'\n':'');await failure(()=>print('sharedAssertInjectedContent',args))
        }
        writeFileSync(transcript,JSON.stringify(take)+'\n')
      })
      await check(source+' foreign receipt path is refused',async()=>{
        const rows=bytes.toString().trimEnd().split('\n').map((line: string) => JSON.parse(line))
        writeFileSync(snapshot,rows.map(r=>JSON.stringify(r.kind==='sent'?{...r,transcript_path:'/etc/hosts'}:r)).join('\n')+'\n')
        await failure(()=>print('sharedAssertInjectedContent',args));writeFileSync(snapshot,bytes)
      })
      const rows=bytes.toString().trimEnd().split('\n').map((line: string) => JSON.parse(line))
      const saveRows=(items: any[])=>writeFileSync(snapshot,items.map(r=>JSON.stringify(r)).join('\n')+'\n')
      const restore=()=>{writeFileSync(snapshot,bytes);writeFileSync(log,'');writeFileSync(transcript,JSON.stringify(take)+'\n')}
      const reference={key,instance_id:'cscb_'+key,session_id:'session',jsonl_path:transcript}
      await check(source+' late matching log reference supplies the exact receipt',async()=>{
        saveRows(rows.map(r=>r.kind==='sent'?{...r,transcript_path:''}:r))
        writeFileSync(log,'[slack] delivery-transcript-reference: '+JSON.stringify(reference)+'\n')
        const output=JSON.parse(await print('sharedAssertInjectedContent',args))
        assert.equal(output.complete,true);assert.equal(output.receipts[0].transcript.session_id,'session')
        restore()
      })
      for(const delta of [{key:'foreign'},{instance_id:'cscb_foreign'},{session_id:'foreign'}]) await check(source+' foreign log ownership '+Object.keys(delta)[0],async()=>{
        saveRows(rows.map(r=>r.kind==='sent'?{...r,transcript_path:''}:r))
        writeFileSync(log,'[slack] delivery-transcript-reference: '+JSON.stringify({...reference,...delta})+'\n')
        await failure(()=>print('sharedAssertInjectedContent',args));restore()
      })
      for(const mode of ['foreign-home','scenario-only','home-only','projects-direct','nested','wrong-extension','wrong-basename','foreign-project','project-symlink','directory','oversize']) await check(source+' transcript path guard '+mode,async()=>{
        let path=join(project,'foreign.jsonl'),updateSent=true
        if(mode==='foreign-home') path=join(scratch,'foreign-home','.claude','projects','foreign','session.jsonl')
        if(mode==='scenario-only') path=join(root,'session.jsonl')
        if(mode==='home-only') path=join(process.env.HOME!,'session.jsonl')
        if(mode==='projects-direct') path=join(process.env.HOME!,'.claude','projects','session.jsonl')
        if(mode==='nested') path=join(project,'subagents','session.jsonl')
        if(mode==='wrong-extension') path=join(project,'session.txt')
        if(mode==='wrong-basename') path=join(project,'other-session.jsonl')
        if(mode==='foreign-project') {path=join(process.env.HOME!,'.claude','projects','foreign-'+source,'session.jsonl');updateSent=false}
        if(mode==='project-symlink') {
          const alias=join(process.env.HOME!,'.claude','projects','alias-'+source)
          symlinkSync(project,alias);path=join(alias,'session.jsonl')
        } else if(mode==='directory') {
          path=join(process.env.HOME!,'.claude','projects','directory-'+source,'session.jsonl');mkdirSync(path,{recursive:true})
        } else {
          if(mode==='oversize') path=join(process.env.HOME!,'.claude','projects','oversize-'+source,'session.jsonl')
          mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify(take)+'\n')
          if(mode==='oversize') truncateSync(path,64*1024*1024+1)
        }
        saveRows(rows.map(r=>r.kind==='sent'&&updateSent?{...r,transcript_path:path}:r.kind==='delivered'?{...r,receipt:{...r.receipt,path}}:r))
        await failure(()=>print('sharedAssertInjectedContent',args));restore()
      })
      await check(source+' final symlink is refused even with exact adapter identity',async()=>{
        const target=join(root,'target.jsonl');writeFileSync(target,JSON.stringify(take)+'\n')
        unlinkSync(transcript);symlinkSync(target,transcript)
        try {await failure(()=>print('sharedAssertInjectedContent',args))} finally {unlinkSync(transcript);restore()}
      })
      await check(source+' transcript HOME allowance cannot authorize logs, snapshots or recovery evidence',async()=>{
        for(const [index,content,name] of [[1,'','server.log'],[2,bytes,'snapshot.jsonl']] as const) {
          const path=join(project,name);writeFileSync(path,content)
          const bad=[...args];bad[index]=path;await failure(()=>print('sharedAssertInjectedContent',bad),/scratch evidence/)
        }
        await failure(()=>print('sharedRecoveryRequest',['valid-id',transcript]),/scratch evidence/)
        const rotation=log+'.1';symlinkSync(log,rotation)
        try {await failure(()=>print('sharedAssertInjectedContent',args),/scratch evidence/)} finally {unlinkSync(rotation)}
      })
      await check(source+' guarded transcript descriptor closes after nonregular, short and changed reads',async()=>{
        const start=body.indexOf('async function sharedInjectedTranscriptBytes('),end=body.indexOf('const sharedAssertInjectedContent:',start)
        assert(start>=0&&end>start)
        const declaration=body.slice(start,end)
        for(const mode of ['nonregular','oversize','short-read','growth','mtime']) {
          const changed=declaration.replace(/\b(openSync|fstatSync|readSync|closeSync)\(/g,'auditFs.$1(')
          assert.notEqual(changed,declaration)
          const file=join(scratch,source+'-transcript-'+mode+'.ts')
          writeFileSync(file,body.slice(0,start)+changed+body.slice(end)+`
            const counts={opens:0,reads:0,stats:0,closes:0,flags:-1};
            const mode=${JSON.stringify(mode)};
            const auditFs={
              openSync(...args){counts.opens++;counts.flags=args[1];return openSync(...args)},
              fstatSync(fd){const stat=fstatSync(fd);counts.stats++;return {
                ...stat,isFile:()=>mode!=='nonregular'&&stat.isFile(),
                size:mode==='oversize'?SHARED_EVIDENCE_BYTES+1:stat.size+(mode==='growth'&&counts.stats>1?1:0),
                mtimeMs:stat.mtimeMs+(mode==='mtime'&&counts.stats>1?1:0),
              }},
              readSync(...args){counts.reads++;return mode==='short-read'?0:readSync(...args)},
              closeSync(fd){counts.closes++;return closeSync(fd)},
            }; export {entryValue,counts};
          `)
          const module=evidence.wrap(await import(file))
          await failure(()=>module.entryValue('sharedAssertInjectedContent',args),/transcript evidence/)
          assert.equal(module.counts.opens,1);assert.equal(module.counts.closes,1)
          assert.equal(module.counts.flags,fsConstants.O_RDONLY|fsConstants.O_NONBLOCK|fsConstants.O_NOFOLLOW)
          assert.equal(module.counts.reads,['nonregular','oversize'].includes(mode)?0:1)
          evidence.value(module.counts)
        }
      })
      await check(source+' a Slack-only selector cannot assert an injected item',async()=>{
        await failure(()=>print('sharedAssertContent',[key,log,snapshot,'CNOCHANNEL',accepted.ts,text,JSON.stringify(parts),'-']))
      })
      await check(source+' reminder/duplicate/Slack-attribute corruption is rejected',async()=>{
        const rows=bytes.toString().trimEnd().split('\n').map((line: string) => JSON.parse(line)),row=rows.find(r=>r.kind==='accepted')
        const changes=[{channel:'COTHER'},{via:'mention'},{user:'UOTHER'},...(source==='interject'?[{reminder_for:99}]:[])]
        for(const change of changes) {writeFileSync(snapshot,rows.map(r=>JSON.stringify(r===row?{...r,...change}:r)).join('\n')+'\n');await failure(()=>print('sharedAssertInjectedContent',args))}
        writeFileSync(snapshot,bytes.toString()+JSON.stringify({...row,seq:99})+'\n');await failure(()=>print('sharedAssertInjectedContent',args))
        writeFileSync(snapshot,bytes)
      })
      if(source==='interject') await check('scratch sender-blind and fixed-expectation-blind mutations are caught',async()=>{
        const blindSender=body.replace('r.source === source && r.sender === sender && r.ts === ts', 'r.source === source && r.ts === ts')
        const blindParts=body.replace(" && isDeepStrictEqual(fixed[0].parts, sharedParseJSON(expectedParts))",'')
        for(const [label,changed,bad] of [['sender',blindSender,[...args.slice(0,4),'wrong-sender',...args.slice(5)]],['parts',blindParts,[...args.slice(0,7),'["wrong"]']]] as const) {
          assert.notEqual(changed,body);const file=join(scratch,'mutant-'+label+'.ts');writeFileSync(file,changed+'\nexport {entryValue};\n')
          await failure(()=>print('sharedAssertInjectedContent',bad))
          const m=evidence.wrap(await import(file));assert.equal(JSON.parse(await m.entryValue('sharedAssertInjectedContent',bad)).complete,true)
        }
      })
      await q.stop()
    }
  }, true))
  test('successful notice identity is independent of Thread Memory and requires one exact post', () => sharedPrinterControl(async ({ scratch, pkg, body, printer, evidence }) => {
    const { entryValue: print, ENTRIES, sharedOwnPostState, membershipRetryDelay } = printer
    const { buildMessagesWaitingNotice, deliveryAge } = await import(join(pkg, 'src/delivery-notices.ts'))
    const { formatPersonaNotice } = await import(join(pkg, 'src/persona-notifier.ts'))
    const { renderPersonaRef, personaKey, personaInstanceId } = await import(join(pkg, 'src/persona-identity.ts'))
    const checks: string[] = []
    async function check(label: string, f: () => unknown) { try { await f(); checks.push(label) } catch (error) { throw new Error(label, { cause: error }) } }
    const name = 'Notice fixture', key = personaKey(name), label = 'fixture', channel = 'CROOM', user = 'UBOT', bot = 'BBOT'
    const notice = (age = 1200, count = 1) => evidence.call(() => formatPersonaNotice({ name, key }, buildMessagesWaitingNotice(renderPersonaRef(name, key), count, age, 'down with automatic restarts off')))
    const records = join(scratch, 'posts.jsonl')
    const post = { seq: 3, event: 'api', method: 'chat.postMessage', label, channel, text: notice(), answer: 'ok', status: 200,
      response_ts: '1234567890.123456', args_token_like: false }
    const prior = { seq: 1, event: 'control' }
    const writeRows = (rows: object[], tail = '') => writeFileSync(records, rows.map(r => JSON.stringify(r) + '\n').join('') + tail)
    const waiting = () => print('sharedMessagesWaitingPost', [records, label, channel, '1', name, key, '1'])
    const pending = async () => assert.rejects(waiting(), (err: any) => err.exitCode === 75 || err.code === 75)
    // The printer's error code is private but its structured field is available.
    const expectPending = async (f = waiting) => {
      try { await f(); assert.fail('unexpected post') } catch (error: any) {
        assert.equal(error.exitCode, 75, JSON.stringify({ keys: Object.keys(error), message: error.message }))
      }
    }
    await check('plain post independently returns exact successful Slack timestamp', async () => {
      writeRows([prior, post]); assert.deepEqual(JSON.parse(await waiting()), {seq:3,label,channel,ts:post.response_ts})
      assert.equal(await print('sharedPostMark', [records]), '3')
      assert.equal(JSON.parse(await print('sharedSuccessfulPost', [records, label, channel, '1', notice()])).ts, post.response_ts)
    })
    await check('all production age forms match without fixed sleeps', async () => {
      for (const ms of [0, 59000, 60000, 3599000, 3600000, 100000000]) {
        writeRows([prior, {...post, text:notice(ms)}]); await waiting()
      }
    })
    for (const [field, value] of [['label','other'],['channel','COTHER'],['text',notice(0,2)],['method','chat.update'],['answer','error']] as const) {
      await check('wrong post '+field+' cannot satisfy notice', async () => { writeRows([prior,{...post,[field]:value}]); await expectPending() })
    }
    await check('absent and lost post do not count as successful', async () => {
      writeRows([prior,{...post,event:'fault',answer:'lost'}]); await expectPending()
    })
    await check('stale sequence cannot satisfy a fresh observation', async () => {
      writeRows([prior,post]); await expectPending(() => print('sharedMessagesWaitingPost',[records,label,channel,'3',name,key,'1']))
    })
    for (const delta of [{response_ts:undefined},{response_ts:'wrong'},{thread_ts:'111.222'},{status:500},{args_token_like:true}]) {
      await check('incomplete/non-root success fails closed '+Object.keys(delta)[0], async () => {
        writeRows([prior,{...post,...delta}]); await assert.rejects(waiting(),/invalid successful root/)
      })
    }
    await check('ambiguous successes fail; no silent last-post selection', async () => {
      writeRows([prior,post,{...post,seq:4,response_ts:'1234567890.456789'}]); await assert.rejects(waiting(),/ambiguous/)
    })
    await check('partial tail defers; malformed complete line fails', async () => {
      writeRows([prior],JSON.stringify(post)); await expectPending()
      writeRows([prior],'{bad}\n'); await assert.rejects(waiting(),/invalid shared evidence/)
    })
    await check('sequence reset and duplicate evidence fail', async () => {
      writeRows([prior]); await assert.rejects(print('sharedMessagesWaitingPost',[records,label,channel,'9',name,key,'1']),/moved behind/)
      writeRows([prior,post,post]); await assert.rejects(waiting(),/sequence/)
    })
    await check('notice prefix, remedy and age grammar are required', async () => {
      for (const text of ['prefix '+notice(),notice()+' suffix',notice().replace(deliveryAge(1200),'stale'),notice().replace('off','on')]) {
        writeRows([prior,{...post,text}]); await expectPending()
      }
    })
    await check('echo binds actual successful post text, ts and supplied installation IDs', async () => {
      writeRows([prior,post])
      assert.deepEqual(JSON.parse(await print('sharedObservedPostEvent',[records,label,channel,'3',user,bot])),
        {type:'message',subtype:'bot_message',channel,channel_type:'channel',ts:post.response_ts,text:post.text,user,bot_id:bot})
      await assert.rejects(print('sharedObservedPostEvent',[records,'other',channel,'3',user,bot]),/invalid successful root/)
      await assert.rejects(print('sharedObservedPostEvent',[records,label,channel,'2',user,bot]),/invalid successful root/)
    })

  }))
  test('report printers preserve production scopes, arguments and export validation', () => sharedPrinterControl(async ({ scratch, pkg, body, printer, evidence }) => {
    const { entryValue: print, ENTRIES, sharedOwnPostState, membershipRetryDelay } = printer
    const reports = await import(join(pkg, 'src/shared-state-reports.ts'))
    const recovery = await import(join(pkg, 'src/reload-recovery.ts'))
    let checks = 0
    async function check(name: string, fn: () => unknown) { try { await fn(); checks++ } catch (error) { throw new Error(name, { cause: error }) } }

    const ref = 'persona="repair & <reference>"', key = 'repair-persona'
    const path = '/scratch/configured path/authority\u2028quoted".json'
    const failure = 'CONTROLLED_ERROR & <filesystem>\nsecond line'
    const scopes = [
      {channels: []},
      {channels: ['C_second', 'C_first'], all: false, dm: false},
      {channels: ['C_second', 'C_first'], all: true, dm: true, repairPending: {usable: ['C_second'], held: ['C_first']}},
      {channels: Array.from({length: 40}, (_, i) => 'C_' + i), all: true, repairPending: {usable: [], held: Array.from({length: 40}, (_, i) => 'C_' + i)}},
    ]
    const cases: {name: string, args: string[], forwarded: unknown[], module: string}[] = []
    for (const scope of scopes) {
      for (const cause of ['unsynced', 'evidence-changed', 'restoration-staged', 'retirement-unresolved', 'not-saved']) {
        for (const optional of [[], [failure]]) {
          for (const name of ['buildSharedStateUnresolvedNotice', 'buildSharedStateUnresolvedLine']) {
            const identity = name.endsWith('Notice') ? ref : key
            cases.push({name, args: [identity, JSON.stringify(scope), cause, path, ...optional], forwarded: [identity, scope, cause, path, optional[0]], module: 'shared-state-reports.ts'})
          }
        }
      }
      for (const closing of ['state', 'evidence', 'repair']) {
        cases.push({name: 'buildSharedStateRecoveredNotice', args: [ref, JSON.stringify(scope), closing], forwarded: [ref, scope, closing], module: 'shared-state-reports.ts'})
        for (const optional of [[], [failure]]) cases.push({name: 'buildSharedStateRecoveredLine', args: [key, JSON.stringify(scope), closing, path, ...optional], forwarded: [key, scope, closing, path, optional[0]], module: 'shared-state-reports.ts'})
      }
    }
    for (const record of ['authority', 'retired-keys']) for (const optional of [[], [failure]]) {
      cases.push({name: 'buildReloadApplyFailedNotice', args: [ref, record, path, ...optional], forwarded: [ref, {record, path, failure: optional[0] ?? ''}], module: 'shared-state-reports.ts'})
    }
    for (const status of ['restoration staged', 'confirmation not activated', 'durable repair activated']) for (const optional of [[], ['independent retained detail']]) {
      cases.push({name: 'sharedRecoveryLine', args: [status, ...optional], forwarded: [status, optional[0]], module: 'reload-recovery.ts'})
    }
    for (let i = 0; i < cases.length; i++) await check('forwarding and production equality ' + i + ' ' + cases[i].name, async () => {
      const c = cases[i]
      const production = c.module === 'shared-state-reports.ts' ? reports : recovery
      assert.equal(await print(c.name, c.args), evidence.call(() => production[c.name](...c.forwarded)))
      let calls = 0
      const result = await ENTRIES[c.name].print(c.args, {importPackageModule: async (module: string) => {
        assert.equal(module, c.module)
        return {[c.name]: (...args: unknown[]) => { calls++; assert.deepEqual(args, c.forwarded); return 'installed builder sentinel' }}
      }})
      assert.equal(result, 'installed builder sentinel')
      assert.equal(calls, 1)
    })
    async function rejected(name: string, args: string[], code: number, context?: unknown) {
      await assert.rejects(context ? ENTRIES[name].print(args, context) : print(name, args), (error: any) => {
        assert.equal(error.exitCode, code)
        assert(!error.message.includes('PRIVATE_SENTINEL'))
        assertNoLeak(error.message)
        return true
      })
    }
    for (const name of new Set(cases.map(c => c.name))) {
      const sample = cases.find(c => c.name === name)!
      const min = sample.args.length
      const max = Math.max(...cases.filter(c => c.name === name).map(c => c.args.length))
      await check(name + ' rejects missing, extra and empty arguments', async () => {
        await rejected(name, sample.args.slice(0, min - 1), 64)
        const fullest = cases.find(c => c.name === name && c.args.length === max)!.args
        await rejected(name, [...fullest, 'extra'], 64)
        for (let i = 0; i < max; i++) { const args = [...fullest]; args[i] = ''; await rejected(name, args, 64) }
      })
      await check(name + ' refuses missing and nonfunction installed export', async () => {
        for (const module of [{}, {[name]: 'not a function'}]) await rejected(name, sample.args, 1, {importPackageModule: async () => module})
      })
    }
    for (const name of ['buildSharedStateUnresolvedNotice', 'buildSharedStateUnresolvedLine', 'buildSharedStateRecoveredNotice', 'buildSharedStateRecoveredLine']) {
      await check(name + ' rejects malformed scope facts and unknown cause/closing before import', async () => {
        const sample = cases.find(c => c.name === name)!
        const neverImport = {importPackageModule: async () => { throw Error('invalid input imported production') }}
        for (const raw of ['PRIVATE_SENTINEL', 'null', '[]', '{}', '{"channels":"PRIVATE_SENTINEL"}', '{"channels":[null]}', '{"channels":[],"all":"true"}', '{"channels":[],"dm":1}', '{"channels":[],"repairPending":null}', '{"channels":[],"repairPending":[]}', '{"channels":[],"repairPending":{"usable":[],"held":[2]}}']) {
          const args = [...sample.args]; args[1] = raw; await rejected(name, args, 64, neverImport)
        }
        const args = [...sample.args]; args[2] = 'PRIVATE_SENTINEL'; await rejected(name, args, 64, neverImport)
      })
    }
    await check('reload failure record union rejects unknown before import', async () => {
      await rejected('buildReloadApplyFailedNotice', [ref, 'PRIVATE_SENTINEL', path], 64, {importPackageModule: async () => { throw Error('invalid record imported production') }})
    })
  }))
})

type HoldArchiveMode = 'memory-release' | 'post-release' | 'post-park'
async function holdArchiveFixture({ scratch, pkg, printer, evidence }: {
  scratch: string; pkg: string; printer: any; evidence: ReturnType<typeof sharedPrinterEvidence>
}, mode: HoldArchiveMode, resolutionAt = 150) {
  const f = await import(join(pkg, 'tests/test-helpers/delivery-queue.ts'))
  // Queue record timestamps use wall time, which can move backwards.
  let wall = 100
  const now = () => wall, setWallTime = (value: number) => { wall = value }, key = 'alpha'
  const dir = mkdtempSync(join(scratch, 'hold-state-')), journal = f.queuePath(dir, key)
  const original = join(scratch, 'original.jsonl'), resolved = join(scratch, 'resolved.jsonl')
  const log = join(dir, 'server.log'), transcript = join(scratch, 'session.jsonl')
  const q = evidence.methods(await f.makeQueue(dir, { now }), () => [journal].filter(existsSync))
  const save = (path: string, bytes: string | Buffer) => { writeFileSync(path, bytes); evidence.files(path) }
  try {
    save(log, ''); save(transcript, '')
    const field = mode === 'memory-release' ? f.memoryHold(now())
      : f.postHold(now(), { root_unknown: mode === 'post-park' })
    const input = f.heldSlackInput(field, { text: 'private held original', files: [{ name: 'note.txt', size: 3 }] })
    assert.equal((await q.accept(key, input)).status, 'accepted')
    const parts = ['held-first', 'held-second']
    save(original, await printer.entryValue('sharedQueueSnapshot', [journal]))
    setWallTime(resolutionAt)
    const resolutions = [{ seq: 1, outcome: mode === 'post-park' ? 'parked' : 'released', at: now() }]
    assert.deepEqual(await q.resolveHolds(key, resolutions), resolutions)
    save(resolved, await printer.entryValue('sharedQueueSnapshot', [journal]))
    await q.compact(key)
    const after = f.readQueue(dir, key)
    const accepted = after.find((r: any) => r.kind === 'accepted' && !('compact' in r))!
    assert.equal(accepted.attempt_high_watermark, 0)
    assert(after.some((r: any) => r.compact === 'allocation' && r.seq === 1))
    assert(!after.some((r: any) => ['released', 'parked'].includes(r.kind)), 'compaction must remove resolution records')
    if (mode === 'post-park') assert.deepEqual(accepted.hold, f.memoryHold(100))
    else { assert.equal(accepted.hold, undefined); assert.equal(accepted.released_at, resolutionAt) }
    return { f, q, setWallTime, key, journal, original, resolved, log, transcript, input, parts, save,
      compacted: readFileSync(journal), before: readFileSync(original) }
  } catch (error) { await q.stop(); throw error }
}

test.each([['memory-release', 150], ['post-release', 150], ['post-release', 99], ['post-park', 200], ['post-park', 120]] as const)(
  'shared queue archive lifecycle reconciles production %s at wall time %s with original-workload receipts', (mode, releaseAt) => sharedPrinterControl(async fixture => {
    const { scratch, printer: { entryValue: print }, evidence } = fixture
    const h = await holdArchiveFixture(fixture, mode, mode === 'post-park' ? 150 : releaseAt)
    try {
      const pending = { accepted: 1, complete: false, progress: 0, incomplete: 1,
        first_incomplete: [{ seq: 1, received_at: 100, parts: 0, receipted_parts: 0, complete: false, recent: [] }], incomplete_items_omitted: 0 }
      const cumulative = join(scratch, 'cumulative.jsonl'), currentOriginal = join(scratch, 'current-original.jsonl')
      h.save(currentOriginal, await print('sharedQueueSnapshot', [h.journal]))
      h.save(cumulative, await print('sharedQueueSnapshot', [h.journal, h.original]))
      const full = (bytes: string) => bytes.trim().split('\n').map(line => JSON.parse(line))
        .filter(row => row.kind === 'accepted' && !('compact' in row))
      const accepted = full(readFileSync(cumulative, 'utf8'))
      assert.deepEqual(accepted, full(h.before.toString()), 'retain the exact informative original, including its hold')
      // Path order and repeated snapshots retain one validated original.
      assert.deepEqual(full(await print('sharedQueueSnapshot', [h.original, h.journal])), accepted)
      assert.deepEqual(full(await print('sharedQueueSnapshot', [h.journal, cumulative])), accepted)
      // The old original also validates when it is only the workload input;
      // the live full acceptance is observed in its rewritten form alone.
      assert.deepEqual(JSON.parse(await print('sharedQueueReceipts', [h.key, h.log, h.journal, h.original])), pending)
      assert.deepEqual(JSON.parse(await print('sharedQueueReceipts', [h.key, h.log, h.journal, h.original, h.original])), pending)
      assert.deepEqual(JSON.parse(await print('sharedQueueReceipts', [h.key, h.log, h.journal, cumulative, cumulative])), pending)
      assert.deepEqual(JSON.parse(await print('sharedQueueReceipts', [h.key, h.log, h.journal, currentOriginal, h.original])), pending)
      await assert.rejects(print('sharedDedupePreserved', [h.original, h.journal]), (error: any) => error.exitCode === 1)

      if (mode === 'post-park') {
        h.setWallTime(releaseAt)
        const release = [{ seq: 1, outcome: 'released', at: releaseAt }]
        assert.deepEqual(await h.q.resolveHolds(h.key, release), release)
        // Keep both actual resolution records as well as compacted forms: a
        // backwards wall clock must not invalidate the recorded lifecycle.
        const releaseEvidence = join(scratch, 'parked-then-released.jsonl')
        h.save(releaseEvidence, await print('sharedQueueSnapshot', [h.journal, h.resolved]))
        await h.q.compact(h.key)
        const status = JSON.parse(await print('sharedQueueReceipts', [h.key, h.log, h.journal, h.original, h.original, cumulative, releaseEvidence]))
        assert.deepEqual(status, pending)
      }
      await h.q.append(h.key, h.f.fixedRecord(1, h.parts))
      await h.q.append(h.key, { ...h.f.sentRecord(), at: 210, transcript_path: h.transcript })
      h.save(h.transcript, h.parts.map((text, i) => JSON.stringify({ type: 'user', sessionId: 'session', uuid: `hold-${i}`,
        timestamp: 220, message: { role: 'user', content: text } })).join('\n') + '\n')
      for (let i = 0; i < h.parts.length; i++) await h.q.append(h.key, { ...h.f.deliveredRecord(1, 230 + i), part: i + 1,
        receipt: { path: h.transcript, uuid: `hold-${i}` } })
      const complete = { accepted: 1, complete: true, progress: 2, incomplete: 0, first_incomplete: [], incomplete_items_omitted: 0 }
      assert.deepEqual(JSON.parse(await print('sharedQueueReceipts', [h.key, h.log, h.journal, h.original])), complete)
      assert.deepEqual(JSON.parse(await print('sharedQueueReceipts', [h.key, h.log, h.journal, h.original, h.original, cumulative])), complete)
      await assert.rejects(print('sharedDedupePreserved', [h.original, h.journal]), (error: any) => error.exitCode === 1)
      h.save(cumulative, await print('sharedQueueSnapshot', [h.journal, h.original, cumulative]))
      await h.q.compact(h.key)
      assert.deepEqual(JSON.parse(await print('sharedQueueReceipts', [h.key, h.log, h.journal, h.original, cumulative])), complete)
      assert.equal(await print('sharedDedupePreserved', [cumulative, h.journal]), '')
      assert.deepEqual(readFileSync(h.original), h.before, 'readers must not rewrite the original workload')
      evidence.files(h.journal, h.original, cumulative)
    } finally { await h.q.stop() }
  }))

test('shared queue archive lifecycle refuses unsupported rewrites and conflicting originals', () => sharedPrinterControl(async fixture => {
  const { scratch, printer: { entryValue: print } } = fixture
  const h = await holdArchiveFixture(fixture, 'post-release')
  const { isQueueRecord } = await import(join(fixture.pkg, 'src/delivery-queue.ts'))
  const rows = (bytes: string | Buffer): any[] => String(bytes).trim().split('\n').map(line => JSON.parse(line))
  const encode = (records: any[]) => records.map(row => JSON.stringify(row)).join('\n') + '\n'
  const full = (records: any[]) => records.find(row => row.kind === 'accepted' && !('compact' in row))!
  const refused = async (label: string, args: string[], entry = 'sharedQueueSnapshot') => {
    await assert.rejects(print(entry, args), (error: any) => error.exitCode === 1, label)
  }
  try {
    const bad = join(scratch, 'bad.jsonl')
    // These shapes still pass the production record parser: refusal must come
    // from reconciling lifecycle/immutable evidence, not malformed JSON.
    for (const [label, change] of [
      ['missing allocation', (r: any[]) => { r.splice(r.findIndex(row => row.compact === 'allocation'), 1) }],
      ['wrong allocation sequence', (r: any[]) => { r.find(row => row.compact === 'allocation').seq = 0 }],
      ['release without time', (r: any[]) => { delete full(r).released_at }],
      ['changed text', (r: any[]) => { full(r).text += ' changed' }],
      ['changed source', (r: any[]) => { const row = full(r); row.source = 'cron'; row.sender = 'schedule'; delete row.key }],
      ['changed key', (r: any[]) => { full(r).key.ts = '99.000000' }],
      ['changed timestamp', (r: any[]) => { full(r).ts = '99.000000' }],
      ['changed channel', (r: any[]) => { full(r).channel = 'CFOREIGN' }],
      ['changed channel type', (r: any[]) => { full(r).channel_type = 'im' }],
      ['changed sender', (r: any[]) => { full(r).user = 'UFOREIGN' }],
      ['added sender', (r: any[]) => { full(r).sender = 'foreign' }],
      ['added bot identity', (r: any[]) => { full(r).bot_id = 'BFOREIGN' }],
      ['added username', (r: any[]) => { full(r).username = 'foreign' }],
      ['added profile name', (r: any[]) => { full(r).bot_profile_name = 'foreign' }],
      ['changed thread timestamp', (r: any[]) => { full(r).thread_ts = '99.000000' }],
      ['added edit timestamp', (r: any[]) => { full(r).edited_ts = '99.000000' }],
      ['changed receipt time', (r: any[]) => { full(r).received_at++ }],
      ['changed sequence', (r: any[]) => { full(r).seq++ }],
      ['changed attachment', (r: any[]) => { full(r).files[0].size++ }],
      ['changed delivery reason', (r: any[]) => { full(r).via = 'all' }],
      ['added queued reaction', (r: any[]) => { full(r).queued_ack_reaction = 'changed' }],
      ['changed reminder metadata', (r: any[]) => { const row = full(r); row.source = 'interject'; row.sender = 'reply-reminder'; row.reminder_for = 2; delete row.key }],
      ['changed join metadata', (r: any[]) => { const row = full(r), hold = h.input.hold!; row.via = 'mention'; row.thread_join = { thread_ts: hold.thread_ts, stamp: hold.stamp, at: 100 } }],
      ['added unknown metadata', (r: any[]) => { full(r).extra = { changed: true } }],
    ] as const) {
      const current = rows(h.compacted); change(current)
      assert(current.every(isQueueRecord), label + ' must remain parser-valid')
      h.save(bad, encode(current))
      await refused(label, [bad, h.original])
    }
    const allocation = join(scratch, 'separate-allocation.jsonl'), current = rows(h.compacted)
    h.save(allocation, encode(current.filter(row => row.compact === 'allocation')))
    h.save(bad, encode(current.filter(row => row.compact !== 'allocation')))
    await refused('allocation from another observation cannot justify a rewrite', [bad, h.original, allocation])
    // Original-only inputs never become observed evidence by being supplied as
    // workload: compare them against the same validated archive representation.
    for (const field of ['text', 'seq', 'received_at'] as const) {
      const originals = rows(h.before), accepted = full(originals)
      if (field === 'text') accepted.text += ' changed'
      else accepted[field]++
      h.save(bad, encode(originals))
      await refused('foreign original ' + field, [h.key, h.log, h.journal, bad, h.original], 'sharedQueueReceipts')
    }
    for (const [field, value] of [['operations', ['different-operation']], ['root_unknown', true], ['arrived_at', 99],
      ['stamp', { incarnation: 'foreign', threadHybridSince: 'foreign' }]] as const) {
      const changedHold = rows(h.before)
      full(changedHold).hold[field] = value
      h.save(bad, encode(changedHold))
      await refused('release cannot mask conflicting original hold ' + field, [h.journal, bad, h.original])
      await refused('original-only hold mismatch ' + field, [h.key, h.log, h.journal, bad, h.original], 'sharedQueueReceipts')
    }
    const duplicate = rows(h.compacted)
    duplicate.push(structuredClone(full(duplicate)))
    h.save(bad, encode(duplicate))
    await refused('identical duplicate in one file', [bad, h.original])
    full(duplicate).text += ' changed'
    h.save(bad, encode(duplicate))
    await refused('differing duplicate in one file', [bad, h.original])
    const conflicting = rows(readFileSync(h.resolved))
    conflicting.find(row => row.kind === 'released').at++
    h.save(bad, encode(conflicting))
    await refused('retained release time conflicts with compacted acceptance', [h.journal, bad])
    const changedRelease = rows(h.compacted)
    full(changedRelease).released_at++
    h.save(bad, encode(changedRelease))
    await refused('released variants must agree even without retained resolution records', [h.journal, bad, h.original])
    const withdrawn = rows(readFileSync(h.resolved))
    withdrawn.find(row => row.kind === 'released').kind = 'withdrawn'
    h.save(bad, encode(withdrawn))
    await refused('withdrawal cannot justify release', [h.journal, bad])
  } finally { await h.q.stop() }
}))

test('shared queue archive lifecycle refuses unsupported Post Hold parking', () => sharedPrinterControl(async fixture => {
  const { scratch, printer: { entryValue: print } } = fixture
  const h = await holdArchiveFixture(fixture, 'post-park')
  const { isQueueRecord } = await import(join(fixture.pkg, 'src/delivery-queue.ts'))
  const original = JSON.parse(h.before.toString().split('\n')[0]!)
  try {
    const bad = join(scratch, 'bad-parking.jsonl')
    for (const [label, change] of [
      ['known root', (row: any) => { row.hold.root_unknown = false }],
      ['wrong thread', (row: any) => { row.hold.thread_ts = '99.000000' }],
      ['wrong incarnation', (row: any) => { row.hold.stamp.incarnation += '-foreign' }],
      ['wrong hybrid stamp', (row: any) => { row.hold.stamp.threadHybridSince += '-foreign' }],
      ['wrong arrival', (row: any) => { row.hold.arrived_at-- }],
    ] as const) {
      const changed = structuredClone(original); change(changed)
      assert(isQueueRecord(changed), label + ' must remain parser-valid')
      h.save(bad, JSON.stringify(changed) + '\n')
      await assert.rejects(print('sharedQueueSnapshot', [h.journal, bad]), (error: any) => error.exitCode === 1, label)
    }
    const conflicting = readFileSync(h.resolved, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const parked = conflicting.find(row => row.kind === 'parked')!
    conflicting.push({ ...parked, at: parked.at + 1 })
    h.save(bad, conflicting.map(row => JSON.stringify(row)).join('\n') + '\n')
    await assert.rejects(print('sharedQueueSnapshot', [h.journal, bad]), (error: any) => error.exitCode === 1,
      'retained parking resolutions must agree')
  } finally { await h.q.stop() }
}))

test('shared receipt archives, saved joins, accounting and recorded buttons need exact independent evidence', () => sharedPrinterControl(async ({ scratch, pkg, printer, evidence: audit }) => {
  const { entryValue: print } = printer
  const f=await import(join(pkg,'tests/test-helpers/delivery-queue.ts'))
  const t=await import(join(pkg,'tests/test-helpers/thread-memory.ts'))
  const diag=await import(join(pkg,'src/persona-diagnostics.ts'))
  const identity=await import(join(pkg,'src/persona-identity.ts'))
  const dir=mkdtempSync(join(scratch,'state-')), key='alpha', name='Alpha'
  const journal=f.queuePath(dir,key), log=join(dir,'server.log'), original=join(dir,'original.jsonl'), snapshot=join(dir,'all.jsonl')
  writeFileSync(log,'')
  const q=audit.methods(await f.makeQueue(dir,{now:()=>100,threadJoinSaved:()=>true}), () => [journal].filter(existsSync))
  try {
  const fixture={slack:{id:'FFILE',name:'scenario-note.txt',mimetype:'text/plain',size:23},queue:{name:'scenario-note.txt',mimetype:'text/plain',size:23},attributes:{attachment_count:'1',attachments:'scenario-note.txt (text/plain, 23 bytes)'}}
  const input=f.slackInput({text:'preserved <channel> 🐝',via:'mention',files:[fixture.queue],received_at:100,thread_join:{thread_ts:t.THREAD_ROOTS.primary,stamp:t.THREAD_STAMP,at:100}})
  const accepted=await q.accept(key,input); if(accepted.status==='failed') throw accepted.error; assert.equal(accepted.status,'accepted')
  const parts=JSON.parse(await print('sharedExpectedParts',[input.text,input.ts!,input.user!,'Human',input.channel!,'channel','mention','-',JSON.stringify(fixture)]))
  await q.append(key,f.fixedRecord(1,parts))
  writeFileSync(original,await print('sharedQueueSnapshot',[journal]))
  audit.files(original)
  let state=JSON.parse(await print('sharedQueueReceipts',[key,log,journal,original]))
  assert.equal(state.complete,false);assert.equal(state.progress,0)
  const session='session-fixture', transcript=join(dir,session+'.jsonl')
  writeFileSync(transcript,'')
  await q.append(key,{...f.sentRecord(1),at:101,session_id:session,transcript_path:transcript})
  await q.append(key,{...f.deliveredRecord(1,110),receipt:{path:transcript,uuid:'receipt'}})
  const take={type:'user',uuid:'receipt',sessionId:session,timestamp:105,message:{role:'user',content:parts[0]}}
  writeFileSync(transcript,JSON.stringify({...take,sessionId:'foreign'})+'\n')
  state=JSON.parse(await print('sharedQueueReceipts',[key,log,journal,original])); assert.equal(state.progress,0)
  writeFileSync(transcript,JSON.stringify({...take,timestamp:99})+'\n')
  state=JSON.parse(await print('sharedQueueReceipts',[key,log,journal,original])); assert.equal(state.progress,0)
  writeFileSync(transcript,JSON.stringify({...take,message:{role:'user',content:'wrong body'}})+'\n')
  state=JSON.parse(await print('sharedQueueReceipts',[key,log,journal,original])); assert.equal(state.progress,0)
  writeFileSync(transcript,JSON.stringify(take)+'\n')
  state=JSON.parse(await print('sharedQueueReceipts',[key,log,journal,original])); assert.equal(state.progress,1); assert.equal(state.complete,true)
  writeFileSync(snapshot,await print('sharedQueueSnapshot',[journal]))
  audit.files(snapshot)
  const contentArgs=[key,log,snapshot,input.channel!,input.ts!,input.text,JSON.stringify(parts),JSON.stringify(fixture)]
  const evidence=JSON.parse(await print('sharedAssertContent',contentArgs)); assert.equal(evidence.receipts[0].transcript.session_id,session)
  assert(!JSON.stringify(evidence).includes(input.text))
  await assert.rejects(print('sharedAssertContent',[...contentArgs.slice(0,6),JSON.stringify(['wrong']),contentArgs[7]]),/independent expectation/)
  await assert.rejects(print('sharedAssertContent',[...contentArgs.slice(0,7),'-']),/attachment changed/)
  // Duplicate take-ins do not renew the original-workload watchdog.
  writeFileSync(transcript,JSON.stringify(take)+'\n'+JSON.stringify(take)+'\n')
  state=JSON.parse(await print('sharedQueueReceipts',[key,log,journal,original])); assert.equal(state.progress,1)
  // New work cannot renew the frozen original progress, and still blocks completion.
  await q.accept(key,f.injectedInput({source:'cron',sender:'cron-fixture',text:'cron',received_at:120}))
  state=JSON.parse(await print('sharedQueueReceipts',[key,log,journal,original])); assert.equal(state.progress,1); assert.equal(state.complete,false)
  assert.equal(state.first_incomplete.length,1)
  const cron=q.items(key)[1].accepted
  await q.append(key,f.fixedRecord(2,['cron']))
  await q.append(key,{...f.sentRecord(2),at:121,session_id:session,transcript_path:transcript})
  await q.append(key,{...f.deliveredRecord(2,130),receipt:{path:transcript,uuid:'cron-receipt'}})
  writeFileSync(transcript,JSON.stringify(take)+'\n'+JSON.stringify({...take,uuid:'cron-receipt',timestamp:125,message:{role:'user',content:'cron'}})+'\n')
  state=JSON.parse(await print('sharedQueueReceipts',[key,log,journal,original])); assert.equal(state.progress,1); assert.equal(state.complete,true)
  // The production-parser Thread Memory adapter binds the exact stamp and time.
  const joinFact=t.threadJoin({channel:input.channel,at:100})
  t.seedThreads(dir,[t.threadHeader(),t.joinRecord(joinFact)],key)
  await print('sharedQueueJoinsSaved',[t.threadPath(dir,key),snapshot])
  assert.equal((await print('sharedThreadJoins',[t.threadPath(dir,key),input.channel!,JSON.stringify(t.THREAD_STAMP)])).split('\n').length,1)
  t.seedThreads(dir,[t.threadHeader(),t.joinRecord({...joinFact,stamp:{...joinFact.stamp,threadHybridSince:'foreign'}})],key)
  await assert.rejects(print('sharedQueueJoinsSaved',[t.threadPath(dir,key),snapshot]),/missing saved queue join/)
  // Source/sender-aware accounting, built from independently supplied expectations.
  const expectations=join(dir,'expected.jsonl')
  writeFileSync(expectations,await print('sharedDeliveryExpectation',[key,name,'slack',input.channel!,input.ts!,input.user!,'mention'])+
    await print('sharedDeliveryExpectation',[key,name,'cron','cron-fixture',cron.ts,'cron-fixture','-']))
  audit.files(expectations)
  const diagnostic=(item:any)=>audit.call(()=>diag.buildDeliveryDiagnostic(diag.MESSAGE_RECEIVED,identity.renderPersonaRef(name,key),diag.deliveryIdentity(item)))
  writeFileSync(log,'[time] '+diagnostic(q.items(key)[0].accepted)+'\n[time] '+diagnostic(cron)+'\n')
  writeFileSync(snapshot,await print('sharedQueueSnapshot',[journal]))
  audit.files(log,snapshot)
  assert.equal(JSON.parse(await print('sharedAssertAccounting',[expectations,log,key,snapshot])).accepted,2)
  writeFileSync(log,readFileSync(log,'utf8')+'[time] '+diagnostic(cron)+'\n')
  await assert.rejects(print('sharedAssertAccounting',[expectations,log,key,snapshot]),/diagnostic set mismatch/)
  writeFileSync(log,'[time] '+diagnostic(q.items(key)[0].accepted)+'\n[time] '+diagnostic(cron)+'\n')
  await q.compact(key)
  await print('sharedDedupePreserved',[snapshot,journal])
  await assert.rejects(print('sharedQueueReceipts',[key,log,journal,original]),/original workload unavailable/)
  state=JSON.parse(await print('sharedQueueReceipts',[key,log,journal,original,snapshot]));assert.equal(state.complete,true)
  // Missing/damaged evidence never reports a successful empty workload.
  await assert.rejects(print('sharedQueueSnapshot',[join(dir,'missing')]),/shared evidence/)
  const broken=join(dir,'broken');writeFileSync(broken,readFileSync(snapshot,'utf8').replace('"v":1','"v":99'))
  await assert.rejects(print('sharedQueueSnapshot',[broken]),/invalid complete queue/)
  const linked=join(dir,'linked');symlinkSync(snapshot,linked)
  await assert.rejects(print('sharedQueueSnapshot',[linked]),/shared evidence/)
  // Recorded button: latest successful message, exact value/block and ambiguity.
  const records=join(dir,'stub.jsonl'), post={event:'api',label:'alpha',method:'chat.postMessage',channel:input.channel,response_ts:input.ts,answer:'ok',blocks:[{type:'actions',block_id:'block',elements:[{type:'button',action_id:'allow-real-token',value:'exact-value'},{type:'button',action_id:'allow-second-token'}]}]}
  writeFileSync(records,JSON.stringify(post)+'\n')
  assert.deepEqual(JSON.parse(await print('sharedRecordedButton',[records,'alpha',input.channel!,input.ts!,'allow-real-'])),{type:'button',action_id:'allow-real-token',value:'exact-value',block_id:'block'})
  await assert.rejects(print('sharedRecordedButton',[records,'alpha',input.channel!,input.ts!,'allow-']),/ambiguous/)
  await assert.rejects(print('sharedRecordedButton',[records,'bravo',input.channel!,input.ts!,'allow-real-']),/prompt missing/)
  writeFileSync(records,JSON.stringify(post)+'\n'+JSON.stringify({...post,method:'chat.update',blocks:[]})+'\n')
  await assert.rejects(print('sharedRecordedButton',[records,'alpha',input.channel!,input.ts!,'allow-real-']),/button missing/)

  assertNoLeak({ evidence, state })
  } finally { await q.stop() }
}))

describe("test-47's refused starts and test-40's earlier release", () => {
  const exitCode = (code: number) => (err: unknown) => (err as { exitCode?: unknown }).exitCode === code

  test('reloadStartRefusalLine prints the production start refusal for each source and leaves every file as it was', () => sharedPrinterControl(async ({ scratch, printer }) => {
    const { entryValue: print } = printer
    const startDir = (label: string) => {
      const dir = mkdtempSync(join(scratch, `${label}-`))
      return { dir, config: join(dir, 'config.json'), record: join(dir, 'config.json.last-applied') }
    }
    const valid = (dir: string) => makePersonaConfigInput({ channel_mode: 'strict', personas: [makePersona({ name: 'alpha' }, dir)] }, dir)
    const listing = (dir: string) => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')])
    const loaderError = (path: string, detail: string) =>
      `loadPersonaConfig: invalid persona config in ${JSON.stringify(path)}: Persona config validation error: ${detail}`

    const top = startDir('top-level-removed')
    writeFileSync(top.config, JSON.stringify({ ...valid(top.dir), allow_invited_channels: true }))
    const topBefore = listing(top.dir)
    const topSentence = await print('removedKeyRefusal', ['allow_invited_channels'])
    expect(topSentence).toBe('allow_invited_channels has been removed; use channel_mode.')
    const topLine = await print('reloadStartRefusalLine', ['config', top.config, 'allow_invited_channels'])
    expect(topLine).toBe(`[slack] Fatal: configuration error — ${loaderError(top.config, topSentence)}`)
    expect(await print('reloadStartRefusalLine', ['config', top.config])).toBe(topLine)
    await assert.rejects(print('reloadStartRefusalLine', ['record', top.config]), /refuses the config, not the record/)
    await assert.rejects(print('reloadStartRefusalLine', ['config', top.config, 'channel_mode']), /does not name channel_mode/)
    expect(listing(top.dir)).toEqual(topBefore)

    const applied = startDir('applied-removed')
    writeFileSync(applied.config, JSON.stringify(valid(applied.dir)))
    const oldRecord = valid(applied.dir)
    oldRecord.personas = [{ ...oldRecord.personas[0]!, invited: true } as (typeof oldRecord.personas)[number]]
    writeFileSync(applied.record, JSON.stringify(oldRecord))
    const appliedBefore = listing(applied.dir)
    const entrySentence = await print('removedKeyRefusal', ['invited'])
    expect(entrySentence).toBe('invited has been removed; use permission_prompts.')
    expect(await print('reloadStartRefusalLine', ['record', applied.config, 'invited'])).toBe(
      `[slack] Fatal: last-applied record error — ${loaderError(applied.record, `personas[0] "alpha" (key=alpha): ${entrySentence}`)} ` +
      `Preserve the shared channel authority ${JSON.stringify(applied.record)} and prepared configuration ${JSON.stringify(applied.config)}; ` +
      'restore trustworthy authority evidence before starting again.')
    await assert.rejects(print('reloadStartRefusalLine', ['config', applied.config]), /refuses the record, not the config/)
    expect(listing(applied.dir)).toEqual(appliedBefore)

    // Invalid new input the upgrade cases prepare: each refusal names its setting.
    const invalid: ReadonlyArray<[string, (input: ReturnType<typeof valid>) => object, string]> = [
      ['channel-mode', input => ({ ...input, channel_mode: 'invited' }), 'channel_mode'],
      ['missing-destination', input => ({ ...input, personas: input.personas.map(({ permission_prompts: _omitted, ...p }) => p) }), 'permission_prompts'],
      ['invalid-destination', input => ({ ...input, personas: input.personas.map(p => ({ ...p, permission_prompts: 'not-a-channel' })) }), 'permission_prompts'],
      ['unlisted-destination', input => ({ ...input, personas: input.personas.map(p => ({ ...p, permission_prompts: 'CUNLISTED' })) }), 'permission_prompts'],
    ]
    for (const [label, change, setting] of invalid) {
      const files = startDir(label)
      writeFileSync(files.config, JSON.stringify(change(valid(files.dir))))
      const before = listing(files.dir)
      const line = await print('reloadStartRefusalLine', ['config', files.config, setting])
      expect(line.startsWith(`[slack] Fatal: configuration error — ${loaderError(files.config, '')}`)).toBe(true)
      expect(line).toContain(`: ${setting} `)
      expect(listing(files.dir)).toEqual(before)
    }

    // A start that would apply writes its record: never printed, nothing written.
    const startable = startDir('startable')
    writeFileSync(startable.config, JSON.stringify(valid(startable.dir)))
    const startableBefore = listing(startable.dir)
    await assert.rejects(print('reloadStartRefusalLine', ['config', startable.config]), /would use write/)
    expect(listing(startable.dir)).toEqual(startableBefore)

    await assert.rejects(print('reloadStartRefusalLine', ['pending', top.config]), exitCode(64))
    await assert.rejects(print('reloadStartRefusalLine', ['config']), exitCode(64))
  }))

  test('removedKeyRefusal prints only a removed key\'s own rule, never a current or unknown setting\'s', () => sharedPrinterControl(async ({ printer }) => {
    const { entryValue: print } = printer
    for (const current of ['channel_mode', 'personas', 'permission_prompts', 'channels']) {
      await assert.rejects(print('removedKeyRefusal', [current]), exitCode(64))
    }
    // An unknown key, and a test-only setting with a rule of its own naming no replacement.
    for (const key of ['no_such_setting', 'test_timer_overrides']) {
      await assert.rejects(print('removedKeyRefusal', [key]), new RegExp(`no rule removing '${key}' that names a current setting`))
    }
    // The renamed poll setting is a removal naming its replacement too.
    expect(await print('removedKeyRefusal', ['claude_director_poll_interval_ms'])).toContain('agent_director_poll_interval_ms')
    await assert.rejects(print('removedKeyRefusal', []), exitCode(64))
  }))

  test('the earlier-release entries print the earlier package\'s own exports and fail when they change', () => sharedPrinterControl(async ({ scratch, pkg, printer }) => {
    const { entryValue: print } = printer
    const diagnostics = await import(join(pkg, 'src/persona-diagnostics.ts'))
    const notices = await import(join(pkg, 'src/delivery-notices.ts'))
    const identity = await import(join(pkg, 'src/persona-identity.ts'))
    const earlier = (label: string, files: Readonly<Record<string, string>>, name = 'claude-slack-channel-bots') => {
      const dir = mkdtempSync(join(scratch, `earlier-${label}-`))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-stand-in' }))
      mkdirSync(join(dir, 'src'))
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, 'src', file), text)
      return dir
    }
    const lineArgs = (dir: string) => [dir, 'Alpha Bot', 'alpha', '3', '/scratch/alpha.unreadable-start']
    const noticeArgs = (dir: string) => [dir, 'Alpha Bot', 'alpha', '2', '/scratch/alpha.unreadable-start']

    // A package whose exports differ from the current build's: the entries print its values.
    const reporting = (body: string) => `export function createDeliveryReporting(deps) { return { queueEvent(e) { ${body} } } }\n`
    const marked = earlier('marked', {
      'delivery-notices.ts': reporting("deps.log(`MARKED ${deps.persona(e.key).name} ${e.type} ${e.line} ${e.quarantinePath} ${e.alert}`)") +
        'export function buildQueueRecordUnreadableNotice(persona, count, path) { return `MARKED-NOTICE ${persona} ${count} ${path}` }\n',
      'persona-identity.ts': 'export function renderPersonaRef(name, key) { return `REF(${name}|${key})` }\n',
    })
    expect(await print('earlierQueueRecordUnreadableLine', lineArgs(marked))).toBe('MARKED Alpha Bot record-unreadable 3 /scratch/alpha.unreadable-start false')
    expect(await print('earlierQueueRecordUnreadableNotice', noticeArgs(marked))).toBe('MARKED-NOTICE REF(Alpha Bot|alpha) 2 /scratch/alpha.unreadable-start')

    // Changed reporting, a missing export or another package fails.
    const twice = earlier('twice', { 'delivery-notices.ts': reporting('deps.log("a"); deps.log("b")') })
    await assert.rejects(print('earlierQueueRecordUnreadableLine', lineArgs(twice)), /logged 2 line\(s\) and posted 0/)
    const alerting = earlier('alerting', { 'delivery-notices.ts': reporting('deps.log("a"); deps.notify(e.key, "alert")') })
    await assert.rejects(print('earlierQueueRecordUnreadableLine', lineArgs(alerting)), /logged 1 line\(s\) and posted 1/)
    const silent = earlier('silent', { 'delivery-notices.ts': reporting('') })
    await assert.rejects(print('earlierQueueRecordUnreadableLine', lineArgs(silent)), /logged 0 line\(s\)/)
    const bare = earlier('bare', { 'delivery-notices.ts': 'export const nothing = 1\n', 'persona-identity.ts': 'export const nothing = 1\n' })
    await assert.rejects(print('earlierQueueRecordUnreadableLine', lineArgs(bare)), /exports no function createDeliveryReporting/)
    await assert.rejects(print('earlierQueueRecordUnreadableNotice', noticeArgs(bare)), /exports no function renderPersonaRef/)
    const other = earlier('other', {}, 'another-package')
    await assert.rejects(print('earlierQueueRecordUnreadableLine', lineArgs(other)), /is not an installed claude-slack-channel-bots package/)
    await assert.rejects(print('earlierQueueRecordUnreadableNotice', noticeArgs(join(scratch, 'missing'))), /is not an installed claude-slack-channel-bots package/)
    await assert.rejects(print('earlierQueueRecordUnreadableLine', ['relative/pkg', ...lineArgs(marked).slice(1)]), exitCode(64))
    await assert.rejects(print('earlierQueueRecordUnreadableLine', [...lineArgs(marked).slice(0, 3), '0', '/q']), exitCode(64))
    await assert.rejects(print('earlierQueueRecordUnreadableNotice', [...noticeArgs(marked).slice(0, 3), 'two', '/q']), exitCode(64))

    // The real reporting and builders, through a package directory over this build's src/:
    // the interface the entries drive is the one the package implements.
    const standIn = mkdtempSync(join(scratch, 'earlier-stand-in-'))
    writeFileSync(join(standIn, 'package.json'), JSON.stringify({ name: 'claude-slack-channel-bots', version: '0.0.0-stand-in' }))
    symlinkSync(join(pkg, 'src'), join(standIn, 'src'))
    const ref = identity.renderPersonaRef('Alpha Bot', 'alpha')
    const line = await print('earlierQueueRecordUnreadableLine', lineArgs(standIn))
    expect(line.startsWith(diagnostics.buildDeliveryDiagnostic(diagnostics.QUEUE_RECORD_UNREADABLE, ref, ''))).toBe(true)
    expect(line).toContain('line=3')
    expect(line).toContain(JSON.stringify('/scratch/alpha.unreadable-start'))
    expect(await print('earlierQueueRecordUnreadableNotice', noticeArgs(standIn))).toBe(
      notices.buildQueueRecordUnreadableNotice(ref, 2, '/scratch/alpha.unreadable-start'))
  }))
})
