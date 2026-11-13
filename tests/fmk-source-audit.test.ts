/**
 * fmk-source-audit.test.ts — One source audit over every `src/` file (
 * removed identifiers and process-start
 * rule source half).
 *
 * `auditSources` is a pure scanner over (path, text) pairs: the tree case
 * reads every `.ts` file under `src/` (recursively) and every planted case
 * hands it one synthetic source, so both run the same code. Each file is
 * passed through `stripComments`; a rule that must not be satisfied by text
 * in a literal locates its call in `maskLiterals` of that code. Every rule is
 * a pattern over the code, never a line number, so code added to `src/`
 * later is checked by the same rules. Each finding names the file and the
 * rule:
 *
 * - `client-delete`: a `delete` call on the agent-director client (a receiver
 *   whose last segment ends in `client`, a `getClient()` call, the CLI's
 *   `deps` or a `director…` receiver), with any spacing, optional chaining or
 *   the bracket form; a `destroy` call on a `director…` receiver. A bare
 *   `.delete(` on any other receiver (a `Map` or `Set`) is no finding.
 * - `delete-helper`: any of the row-delete names, in code or a string.
 * - `finished-row-option`: `include_finished` or `include-finished` anywhere.
 * - `ad-label`: `ad_owner` or `ad_pane` anywhere (HO rev 17).
 * - `tmux-process-start`: a process start whose command is `tmux` (a literal
 *   in any quote style, an absolute path ending `/tmux`, or the first word of
 *   a shell `-c` string): `spawn`, `spawnSync`, `exec`, `execSync`,
 *   `execFile`, `execFileSync` (bare, aliased on import, or on any receiver),
 *   the CLI's `spawnDaemon`, `Bun.spawn` and `Bun.spawnSync` (array and object
 *   forms) and `Bun.$` or `$` templates.
 * - `unlisted-process-start`: a process start whose command is not a literal
 *   and that `NON_LITERAL_STARTS` does not list (by file, callee and command
 *   expression). `stale-process-start-entry`: a listed entry that matches no
 *   start, so the list can never outlive its sites. An agent-director client
 *   method (`client.spawn(`) and a method `exec(` (a regex or a database) are
 *   no process start.
 * - `raw-tmux-subcommand`: `kill-session`, `has-session` or `start-server`
 * anywhere (HO C1, C18, C20).
 * - `removed-identifier`: any of the contract removed names, approver
 * seam names and ladder kill clock seam, in code or a string.
 *
 * Log text naming tmux sub-commands (`tmux attach -t`) is no process start.
 *
 * A second audit, `byNameFindings`, reads every `src/` file and the
 * agent-director stub (`tests/test-helpers/agent-director-stub.ts`) with the
 * TypeScript parser, so text in strings and comments never counts, and finds
 * any recognition of a class the client declares by name rather than by class
 * The class names are read from the installed
 * client's namespace (every subclass of its `AgentDirectorError`, the three
 * Phase-1-only classes in `PHASE1_ONLY_ERR_NAMES` among them), never listed
 * here. A name is the literal, a constant holding it, or an element of a
 * collection of them; its rules are listed at `byNameFindings`. The only
 * by-name uses kept are `SANCTIONED_BY_NAME`'s (`ErrAmbiguousRequest` in the
 * click handler, `ErrPermissionRequestNotFound` in the client module, the
 * system-install classes in the version gate, the GONE names in the checked
 * kill's log label, and the stub's two base-error builders), each checked to
 * be a client class still used there by its rule; no file and no declaration
 * is exempt otherwise. The same rows pin each rule with a planted violation,
 * at a synthetic path or at a real kill, sanctioned site's or
 * `src/agent-director-errors.ts`'s path, and the allowed uses (the name
 * constants and `PHASE1_ONLY_ERR_NAMES`, `REQUIRED_ERR_NAMES` and the
 * catalogue check, log labels, the stub's builders on the class bindings, the
 * A-13 and `UnknownError` rows, and the sanctioned comparisons).
 *
 * A third audit, with the same parser, holds the three Phase-1-only classes
 * to the pinned client's own:
 *
 * - `phase1ReExportFindings`: `src/agent-director-errors.ts` re-exports
 *   each of them by its own name in an `export { … } from 'agent-director'`
 *   declaration (not type-only, not aliased); a local binding exported in its
 *   place, a type-only or renamed re-export, a re-export from another module
 *   or `export *` is a finding.
 * - `phase1ReadFindings`: no file in `src/` or `tests/test-helpers/` reads
 *   one from agent-director other than by a named import or re-export: a
 *   property or element read through the namespace (a typed optional cast,
 *   a copy, a default or `import x = require` binding, or a dynamic
 *   `import()` or `require()` included), a destructuring, a read the audit
 *   cannot name, or the namespace passed to a call
 *   (`agentDirectorValueReads` and `agentDirectorNamespaceArguments`,
 *   `tests/test-helpers/ad-value-reads.ts`).
 * - `phase1StandInFindings`: no file in `src/` or `tests/test-helpers/`
 *   declares a class extending `AgentDirectorError` (or a client class) that
 *   is named one of the three: by its declaration, the variable or property
 *   it is bound to, or a `name` it is given (`this.name = …` or
 *   `Object.defineProperty(…, 'name', …)`), a name the audit cannot read
 *   counting as one.
 *
 * Each rule is pinned with flagged and allowed synthetic rows, then run over
 * the tree.
 *
 * A fourth, `phase1TypesFindings`, holds `src/ad-phase1-types.ts` to type
 * aliases and type-only agent-director imports, with no interface, object
 * type literal or mapped type, so it declares no field the client declares
 * it is pinned the same way.
 *
 * Source audits read only the repository and installed client. Legacy
 * contract regressions run extracted declarations in an inert bash child
 * under a temporary HOME; they never source the harness or execute AD/tmux.
 *
 * SPDX-License-Identifier: MIT
 */

import * as agentDirectorClient from 'agent-director'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { pathToFileURL } from 'node:url'
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import type { PersonaConfigInput } from '../src/config.ts'
import { createSharedChannelAuthority } from '../src/shared-channels.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { configBytes, makeSharedAuthority, readSharedState } from './test-helpers/shared-channels.ts'

import { AD_ERROR_CLASS_CONFIG, AD_ERROR_CLASS_CONFLICT, AD_ERROR_CLASS_UNAVAILABLE, AD_ERROR_CLASS_UNCLASSIFIED, AD_ERROR_CLASS_UNUSABLE_NAME, classifyAdError, LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE, launchTimeoutFormOf } from '../src/ad-error-class.ts'
import { LAUNCH_TIMEOUT_PHRASE } from '../src/ad-description-phrases.ts'
import { LAUNCH_CALL_END_LAUNCH_TIMEOUT, launchCallWindowOf, thisLaunchRowOf } from '../src/session-manager.ts'
import { collided, makeRecoveryHarness, personaRow } from './test-helpers/recovery-harness.ts'
import { adConfigMalformedOnset } from '../src/outage-state.ts'
import { PANE_READ_GONE, paneReadFailureOf } from '../src/pane-read.ts'

import { AD_TMUX_TABLE } from '../src/ad-settings.ts'
import { buildSystemInstallTooOldMessage, compareAdVersions, FOUND_BY_RUNTIME_RECHECK, FOUND_BY_STARTUP_CHECK, meetsPhase1Floor, PHASE1_FLOOR_VERSION } from '../src/ad-version-gate.ts'
import { PHASE1_ONLY_ERR_NAMES } from '../src/agent-director-errors.ts'
import { decideLatchRecheckProbe, LATCH_CASE_OWN_ID, latchRecheckRoundLine, RECHECK_VERDICT_CLEARED, recogniseConflictCase } from '../src/conflict-latch.ts'
import { parseDeliveryTranscriptRecord } from '../src/delivery-receipt.ts'
import { percentile } from './integration/fixtures/transcript-receipts.ts'
import { renderInstallSkillInstructions } from '../src/install-skill-pointer.ts'
import { AD_NS, AGENT_DIRECTOR_MODULE, agentDirectorNamespaceArguments, agentDirectorValueReads, finding, moduleLoadOf } from './test-helpers/ad-value-reads.ts'
import { CLIENT_MIN_VERSION } from './test-helpers/agent-director-versions.ts'
import {
  callArguments,
  DELETE_HELPERS,
  maskLiterals,
  REMOVED_IDENTIFIERS,
  SOURCE_WORD_RULES,
  splitTopLevel,
  stripComments,
} from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

// Decision 4: units reach the src-free population builders through the one
// Thread Memory helper; only the image evidence adapter loads them directly.
// Read syntax, including re-exports and dynamic loads, without importing it.
function populationEntryFindings(file: string, source: string): string[] {
  // Shell can pass the path through a variable to bun -e's dynamic import.
  // No shell entry is sanctioned, so even naming that module is a finding.
  if (file.endsWith('.sh')) return source.split('\n').flatMap((line, i) =>
    !/^\s*#/.test(line) && /(?:^|\/)thread-populations(?:\.ts)?(?:["'`]|$)/.test(line)
      ? [`${file}:${i + 1}: population-builder-entry`] : [])
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const findings: string[] = []
  const root = resolve(import.meta.dir, '..')
  const target = join(root, 'tests/test-helpers/thread-populations.ts')
  const allowed = ['tests/test-helpers/thread-memory.ts', 'tests/integration/fixtures/sr8-evidence.ts']
  const visit = (node: ts.Node) => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier :
      ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression :
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined
    const name = specifier && ts.isStringLiteralLike(specifier) ? specifier.text : moduleLoadOf(node)
    if (name && resolve(dirname(join(root, file)), name).replace(/(?:\.[cm]?[jt]sx?)?$/, '.ts') === target
      && !allowed.includes(file)) findings.push(`${file}:${finding(sf, node, 'population-builder-entry')}`)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

describe('SR-8 population builder entry rule', () => {
  test('only thread-memory and sr8-evidence load thread-populations in the tests tree', () => {
    const files = (readdirSync(import.meta.dir, { recursive: true }) as string[])
      .filter(file => /\.(?:[cm]?[jt]sx?|sh)$/.test(file))
    const findings = files.flatMap(file => populationEntryFindings(`tests/${file}`, readFileSync(join(import.meta.dir, file), 'utf8')))
    expect(findings).toEqual([])
  })
  test.each([
    "import { populationJoins } from './test-helpers/thread-populations.ts'",
    "export * from './test-helpers/thread-populations.ts'",
    "const p = import('./test-helpers/thread-populations.ts')",
    "const p = require('./test-helpers/thread-populations')",
    "import p = require('./test-helpers/thread-populations.ts')",
    "type P = import('./test-helpers/thread-populations.ts').PopulationJoin",
  ])('rejects a direct unit entry: %s', source => {
    expect(populationEntryFindings('tests/planted.test.ts', source)).toHaveLength(1)
  })
  test('rejects another integration loader and ignores comments and strings', () => {
    expect(populationEntryFindings('tests/integration/fixtures/planted.ts', "await import('../../test-helpers/thread-populations.ts')")).toHaveLength(1)
    expect(populationEntryFindings('tests/planted.test.ts', "// import './test-helpers/thread-populations.ts'\nconst documentation = \"import('./test-helpers/thread-populations.ts')\"")).toEqual([])
    expect(populationEntryFindings('tests/integration/planted.sh', 'POPULATIONS="${SCENARIO_FIXTURES}/../../test-helpers/thread-populations.ts"')).toHaveLength(1)
    expect(populationEntryFindings('tests/integration/planted.sh', '# See /thread-populations.ts')).toEqual([])
  })
})

type Rule =
  | 'client-delete'
  | 'delete-helper'
  | 'finished-row-option'
  | 'ad-label'
  | 'tmux-process-start'
  | 'unlisted-process-start'
  | 'stale-process-start-entry'
  | 'raw-tmux-subcommand'
  | 'removed-identifier'

interface Finding {
  readonly file: string
  readonly rule: Rule
  /** The offending text, for the failure message only. */
  readonly at: string
}

/** A `src/` process start whose command is not a literal, listed with why it starts no tmux. */
interface NonLiteralStart {
  /** The file, relative to `src/`. */
  readonly file: string
  /** The callee as written, whitespace and optional chaining removed (`deps.spawnSync`). */
  readonly callee: string
  /** The command expression as written, whitespace removed (`process.execPath`). */
  readonly command: string
  readonly reason: string
}

// DELETE_HELPERS, REMOVED_IDENTIFIERS and the word rules (`SOURCE_WORD_RULES`)
// live in tests/test-helpers/source-audit.ts, so tests/shipped-docs.test.ts
// reads the same lists over the architecture doc and the engineering guide.

/** Callees that start a process (the CLI's `spawnDaemon` dependency included). */
const START_NAMES = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'spawnDaemon'])

/** Modules whose start functions and `$` count as process starts. */
const PROCESS_MODULE = /^(?:(?:node:)?child_process|bun)$/

const WORD_RULES: ReadonlyArray<readonly [Rule, RegExp]> = SOURCE_WORD_RULES

const squash = (text: string): string => text.replace(/\s+/g, '').replace(/\?\./g, '.')

/**
 * The member chain that ends `before` (`this.client`, `getClient()`), with
 * whitespace and optional chaining removed; `<expr>` when it ends in some
 * other expression (a call with arguments, an index, a regex literal).
 */
function chainEnding(before: string): string {
  const m = /(?<![\w$])((?:[\w$]+(?:\s*\(\s*\))?\s*\??\.\s*)*[\w$]+(?:\s*\(\s*\))?)\s*$/.exec(before.slice(-300))
  return m ? squash(m[1]!) : '<expr>'
}

/** The receiver of the member call whose name starts at `at` in `mask`, or undefined for a bare call. */
function receiverOf(mask: string, at: number): string | undefined {
  const before = mask.slice(Math.max(0, at - 300), at).trimEnd()
  if (!before.endsWith('.')) return undefined
  return chainEnding(before.slice(0, before.endsWith('?.') ? -2 : -1))
}

const lastSegment = (receiver: string): string => receiver.split('.').at(-1)!
const isClientReceiver = (receiver: string): boolean => /client$/i.test(lastSegment(receiver)) || lastSegment(receiver) === 'getClient()'

/** The literal text of the string or template expression `expr`, and whether it is whole (a template stops at its first `${`). */
function literalText(expr: string): { text: string; whole: boolean } | undefined {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(expr)
  if (quoted) return { text: quoted[2]!, whole: true }
  if (!/^`[\s\S]*`$/.test(expr)) return undefined
  const body = expr.slice(1, -1)
  const cut = body.indexOf('${')
  return cut < 0 ? { text: body, whole: true } : { text: body.slice(0, cut), whole: false }
}

/** The command word of a command line: its first word past any `NAME=value` assignments, or undefined when that word is not all literal. */
function commandWordOf(literal: { text: string; whole: boolean }): string | undefined {
  const m = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(\S*)(\s|$)/.exec(literal.text)!
  return m[2] !== '' || literal.whole ? m[1]! : undefined
}

/** The command word of the expression `expr` (a literal), or undefined when it is not a literal. */
const commandWord = (expr: string): string | undefined => {
  const literal = literalText(expr)
  return literal && commandWordOf(literal)
}

const isTmux = (word: string): boolean => word === 'tmux' || word.endsWith('/tmux')

/** The elements of the array literal `expr`, or undefined when it is none. */
const arrayElements = (expr: string): string[] | undefined => (/^\[[\s\S]*\]$/.test(expr) ? splitTopLevel(expr.slice(1, -1)) : undefined)

/**
 * A start's command expression and the argv expressions after it, from its
 * call arguments: `(cmd, [args])`, `([cmd, …args])` or `({ cmd: [cmd, …args] })`.
 * Undefined for an object argument with no `cmd` (an agent-director call's params).
 */
function commandOf(args: string[]): { command: string; argv: string[] } | undefined {
  const first = args[0] ?? ''
  let elements = arrayElements(first)
  if (!elements && first.startsWith('{')) {
    const cmd = splitTopLevel(first.slice(1, -1))
      .map((p) => /^cmd(?:\s*:\s*([\s\S]*))?$/.exec(p))
      .find((m) => m)
    if (!cmd) return undefined
    const value = cmd[1] ?? 'cmd'
    elements = arrayElements(value) ?? [value]
  }
  if (elements) return { command: elements[0] ?? '', argv: elements.slice(1) }
  return { command: first, argv: arrayElements(args[1] ?? '') ?? [] }
}

/** How a file imports the process-start modules: local aliases of a start name or `$`, and namespace or default bindings. */
function processImports(code: string): { aliases: Map<string, string>; namespaces: Set<string> } {
  const aliases = new Map<string, string>()
  const namespaces = new Set(['Bun'])
  for (const m of code.matchAll(/\bimport\s+(?!type\b)([^'";]*?)\s*from\s*(['"])([^'"]+)\2/g)) {
    if (!PROCESS_MODULE.test(m[3]!)) continue
    const clause = m[1]!
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause)?.[1] ?? /^([\w$]+)\s*(?:,|$)/.exec(clause)?.[1]
    if (ns) namespaces.add(ns)
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? ''
    for (const spec of splitTopLevel(named)) {
      const s = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(spec)
      if (s && !spec.startsWith('type ') && (START_NAMES.has(s[1]!) || s[1] === '$')) aliases.set(s[2] ?? s[1]!, s[1]!)
    }
  }
  return { aliases, namespaces }
}

/**
 * One process start found in a file: its callee, its command expression (or
 * a shell `-c` script's) and whether it is tracked (a start whose non-literal
 * command must be listed).
 */
interface Start {
  readonly callee: string
  readonly command: string
  readonly tracked: boolean
}

/** Every call and tagged template in `code` that may start a process. */
function startsIn(code: string, mask: string): Start[] {
  const { aliases, namespaces } = processImports(code)
  const starts: Start[] = []
  const names = [...START_NAMES, ...[...aliases].filter(([, imported]) => START_NAMES.has(imported)).map(([local]) => local)]
  for (const m of mask.matchAll(new RegExp(`(?<![\\w$])(${names.map((n) => n.replace('$', '\\$')).join('|')})\\s*\\(`, 'g'))) {
    const name = m[1]!
    const receiver = receiverOf(mask, m.index)
    if (receiver === undefined && /\bfunction\s*\*?\s*$/.test(mask.slice(Math.max(0, m.index - 40), m.index))) continue
    let args: string[]
    try {
      args = splitTopLevel(callArguments(code, m.index))
    } catch {
      args = ['<unparsed>']
    }
    if (/^[\w$]+\s*\??\s*:/.test(args[0] ?? '')) continue // a declaration's typed parameter, not a call
    const tracked = receiver === undefined || namespaces.has(receiver) || (name !== 'exec' && !isClientReceiver(receiver))
    const call = commandOf(args) ?? (tracked ? { command: args[0] ?? '', argv: [] } : undefined)
    if (!call) continue
    const callee = receiver === undefined ? name : `${receiver}.${name}`
    starts.push({ callee, command: call.command, tracked })
    call.argv.forEach((arg, i) => {
      const flag = literalText(arg)
      if (flag?.whole && /^-[A-Za-z]*c$/.test(flag.text) && i + 1 < call.argv.length) starts.push({ callee, command: call.argv[i + 1]!, tracked })
    })
  }
  const tags = ['\\$', ...[...aliases].filter(([, imported]) => imported === '$').map(([local]) => local.replace('$', '\\$'))]
  for (const m of mask.matchAll(new RegExp(`(?<![\\w$])((?:[\\w$]+\\s*\\.\\s*)?)(${tags.join('|')})(?![\\w$])`, 'g'))) {
    let tick = m.index + m[0].length
    while (/\s/.test(code[tick] ?? '')) tick++
    if (code[tick] !== '`') continue
    const receiver = m[1] ? squash(m[1]).slice(0, -1) : undefined
    if (receiver !== undefined && (!namespaces.has(receiver) || m[2] !== '$')) continue
    const body = code.slice(tick + 1)
    const end = body.search(/(?<!\\)(?:`|\$\{)/)
    if (end < 0) continue
    const leading = body.slice(0, end)
    const whole = body[end] === '`'
    const word = commandWordOf({ text: leading, whole })
    // A non-literal command is keyed by the template's head through its first substitution (`${bin}`).
    const command = word !== undefined ? `'${word}'` : body.slice(0, body.indexOf('}') + 1)
    starts.push({ callee: receiver === undefined ? m[2]! : `${receiver}.$`, command, tracked: true })
  }
  return starts
}

/**
 * The findings for `files` ([path relative to `src/`, source text]) against
 * the closed list `listed` of non-literal process starts. An entry that
 * matches no start in `files` is itself a finding.
 */
function auditSources(files: ReadonlyArray<readonly [string, string]>, listed: readonly NonLiteralStart[]): Finding[] {
  const findings: Finding[] = []
  const used = new Set<NonLiteralStart>()
  for (const [file, text] of files) {
    const code = stripComments(text)
    const mask = maskLiterals(code)
    const add = (rule: Rule, at: string): void => {
      findings.push({ file, rule, at })
    }
    for (const [rule, re] of WORD_RULES) for (const m of code.matchAll(re)) add(rule, m[0])

    for (const m of mask.matchAll(/(?<![\w$])(delete|destroy)\s*(?:\?\.\s*)?\(/g)) {
      const receiver = receiverOf(mask, m.index)
      if (receiver !== undefined && isDeleteReceiver(receiver, m[1]!)) add('client-delete', `${receiver}.${m[1]}(`)
    }
    for (const m of code.matchAll(/(?:\?\.)?\s*\[\s*(['"`])(delete|destroy)\1\s*\]\s*(?:\?\.\s*)?\(/g)) {
      const bracket = m.index + m[0].indexOf('[')
      if (mask[bracket] !== '[') continue // inside a literal
      const receiver = chainEnding(mask.slice(0, m.index))
      if (isDeleteReceiver(receiver, m[2]!)) add('client-delete', `${receiver}[${m[2]}](`)
    }

    for (const start of startsIn(code, mask)) {
      const word = commandWord(start.command)
      if (word !== undefined) {
        if (isTmux(word)) add('tmux-process-start', `${start.callee}(${start.command})`)
        continue
      }
      if (!start.tracked) continue
      const entry = listed.find((e) => e.file === file && e.callee === start.callee && e.command === squash(start.command))
      if (entry) used.add(entry)
      else add('unlisted-process-start', `${start.callee}(${start.command})`)
    }
  }
  for (const entry of listed) {
    if (!used.has(entry)) findings.push({ file: entry.file, rule: 'stale-process-start-entry', at: `${entry.callee}(${entry.command})` })
  }
  return findings
}

/** Whether `verb` on `receiver` is an agent-director delete: `delete` on the client or the CLI's director ops, `destroy` on a director. */
function isDeleteReceiver(receiver: string, verb: string): boolean {
  const last = lastSegment(receiver)
  if (verb === 'destroy') return /^director/i.test(last)
  return isClientReceiver(receiver) || last === 'deps' || /^director/i.test(last)
}

/**
 * The `src/` process starts whose command is not a literal (closed list, by
 * file, callee and command expression; never a line number). None starts tmux.
 */
const NON_LITERAL_STARTS: readonly NonLiteralStart[] = [
  {
    file: 'cli.ts',
    callee: 'deps.spawnDaemon',
    command: 'process.execPath',
    reason: '`start`: the Bun runtime re-running cli.ts `start` as the detached server daemon',
  },
  {
    file: 'cli.ts',
    callee: 'deps.spawnSync',
    command: 'process.execPath',
    reason: '`clean_restart`: stopping and then starting the server through its own CLI under the Bun runtime',
  },
  {
    file: 'cli.ts',
    callee: 'spawnSync',
    command: 'cmd',
    reason: 'the real CliDeps.spawnSync behind deps.spawnSync, whose callers pass process.execPath (listed above)',
  },
  {
    file: 'cli.ts',
    callee: 'spawn',
    command: 'cmd',
    reason: 'the real CliDeps.spawnDaemon behind deps.spawnDaemon, whose caller passes process.execPath (listed above)',
  },
]

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

const SRC_DIR = join(import.meta.dir, '..', 'src')

/** Every `.ts` file under `src/`, recursively: [path relative to `src/`, text]. */
const SRC_FILES: ReadonlyArray<readonly [string, string]> = (readdirSync(SRC_DIR, { recursive: true }) as string[])
  .filter((name) => name.endsWith('.ts'))
  .sort()
  .map((name) => [name, readFileSync(join(SRC_DIR, name), 'utf-8')] as const)

describe('one source audit over every src/ file', () => {
  test('the real src/ has no finding, every listed non-literal start among them', () => {
    expect(SRC_FILES.map(([name]) => name)).toEqual(expect.arrayContaining(['cli.ts', 'session-manager.ts', 'server.ts', 'reply-reminder.ts']))
    expect(auditSources(SRC_FILES, NON_LITERAL_STARTS)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Planted violations and negative controls
// ---------------------------------------------------------------------------

/** [what is planted, the synthetic source (one line), the one rule it breaks]. */
const PLANTED: ReadonlyArray<readonly [string, string, Rule]> = [
  // The agent-director client's delete.
  ['client.delete', 'await client.delete({ instance_id: id })', 'client-delete'],
  ['client . delete with spacing', 'await client . delete ({ instance_id: id })', 'client-delete'],
  ['client?.delete', 'await client?.delete({ instance_id: id })', 'client-delete'],
  ['client.delete?.()', 'await client.delete?.({ instance_id: id })', 'client-delete'],
  ["client['delete']", "await client['delete']({ instance_id: id })", 'client-delete'],
  ['client?.["delete"]', 'await client?.["delete"]({ instance_id: id })', 'client-delete'],
  ['this.client.delete', 'await this.client.delete({ instance_id: id })', 'client-delete'],
  ['deps.adClient.delete', 'await deps.adClient.delete({ instance_id: id })', 'client-delete'],
  ['getClient().delete', 'await getClient().delete({ instance_id: id })', 'client-delete'],
  ['getClient() . delete with spacing', 'await getClient( ) . delete ({ instance_id: id })', 'client-delete'],
  ['deps.delete', 'await deps.delete(id)', 'client-delete'],
  ['directorOps.delete', 'await directorOps.delete(id)', 'client-delete'],
  ['director.destroy', 'await director.destroy(id)', 'client-delete'],
  ...DELETE_HELPERS.flatMap((name): Array<readonly [string, string, Rule]> => [
    [`${name} in code`, `await deps.${name}(key)`, 'delete-helper'],
    [`${name} in a string`, `log('${name} failed')`, 'delete-helper'],
  ]),
  // finished-row-option: include_finished or include-finished.
  ['include_finished in code', 'await c.kill({ instance_id: id, include_finished: true })', 'finished-row-option'],
  ['include_finished in a string', "const key = 'include_finished'", 'finished-row-option'],
  ['include-finished in a string', 'const flag = "--include-finished"', 'finished-row-option'],
  ['include-finished in a template', 'const line = `kill --include-finished ${id}`', 'finished-row-option'],
  // agent-director's labels.
  ['ad_owner in code', 'const ad_owner = row.label', 'ad-label'],
  ['ad_owner in a string', "const option = '@ad_owner'", 'ad-label'],
  ['ad_pane in code', 'const { ad_pane } = row', 'ad-label'],
  ['ad_pane in a template', 'const option = `@ad_pane=${token}`', 'ad-label'],
  // A tmux process start, each form and quote style.
  ["spawn('tmux')", "spawn('tmux', ['ls'])", 'tmux-process-start'],
  ['spawn("tmux")', 'spawn("tmux", ["ls"])', 'tmux-process-start'],
  ['spawn(`tmux`)', 'spawn(`tmux`, [`ls`])', 'tmux-process-start'],
  ["spawnSync('tmux')", "spawnSync('tmux', ['ls'])", 'tmux-process-start'],
  ["execFile('tmux')", "execFile('tmux', ['ls'])", 'tmux-process-start'],
  ["execFileSync('tmux')", "execFileSync('tmux', ['ls'])", 'tmux-process-start'],
  ["exec('tmux ls')", "exec('tmux ls')", 'tmux-process-start'],
  ['execSync("tmux ls")', 'execSync("tmux ls")', 'tmux-process-start'],
  ['execSync(`tmux … ${…}`)', 'execSync(`tmux list-panes -t ${target}`)', 'tmux-process-start'],
  ["exec('NAME=value tmux ls')", "exec('TMUX_TMPDIR=/tmp/x tmux ls')", 'tmux-process-start'],
  ["Bun.spawn(['tmux'])", "Bun.spawn(['tmux', 'ls'])", 'tmux-process-start'],
  ['Bun.spawnSync(["tmux"])', 'Bun.spawnSync(["tmux", "ls"])', 'tmux-process-start'],
  ["Bun . spawn ( [ 'tmux' ] ) with spacing", "Bun . spawn ( [ 'tmux' , 'ls' ] )", 'tmux-process-start'],
  ["Bun.spawn({ cmd: ['tmux'] })", "Bun.spawn({ cmd: ['tmux', 'ls'], stdout: 'pipe' })", 'tmux-process-start'],
  ['Bun.spawnSync({ cmd: ["tmux"] })', 'Bun.spawnSync({ stderr: "pipe", cmd: ["tmux", "ls"] })', 'tmux-process-start'],
  ["spawn(['tmux']) imported from bun", "import { spawn } from 'bun'; spawn(['tmux', 'ls'])", 'tmux-process-start'],
  ['Bun.$`tmux`', 'await Bun.$`tmux ls`', 'tmux-process-start'],
  ['$`tmux` imported from bun', "import { $ } from 'bun'; await $`tmux ls`", 'tmux-process-start'],
  ['$ aliased on import from bun', "import { $ as sh } from 'bun'; await sh`tmux ls`", 'tmux-process-start'],
  ['a start aliased on import', "import { execFileSync as run } from 'node:child_process'; run('tmux', ['ls'])", 'tmux-process-start'],
  ['a child_process namespace', "import * as cp from 'node:child_process'; cp.execSync('tmux ls')", 'tmux-process-start'],
  ["deps.spawnSync('tmux') (an indirection by name)", "deps.spawnSync('tmux', ['ls'])", 'tmux-process-start'],
  ["deps.spawnDaemon('tmux')", "deps.spawnDaemon('tmux', ['ls'], opts)", 'tmux-process-start'],
  ["spawn('/usr/bin/tmux')", "spawn('/usr/bin/tmux', ['ls'])", 'tmux-process-start'],
  ["Bun.spawn(['/opt/homebrew/bin/tmux'])", "Bun.spawn(['/opt/homebrew/bin/tmux', 'ls'])", 'tmux-process-start'],
  ["spawn('sh', ['-c', 'tmux …'])", "spawn('sh', ['-c', 'tmux ls'])", 'tmux-process-start'],
  ["execFileSync('/bin/bash', ['-lc', 'tmux …'])", "execFileSync('/bin/bash', ['-lc', 'tmux list-sessions'])", 'tmux-process-start'],
  ["Bun.spawn(['sh', '-c', 'tmux …'])", "Bun.spawn(['sh', '-c', 'tmux ls'])", 'tmux-process-start'],
  // A process start whose command is not a literal and is not listed.
  ['spawn(variable)', 'spawn(tmuxPath, args)', 'unlisted-process-start'],
  ['execSync(`${…} …`)', 'execSync(`${bin} ls`)', 'unlisted-process-start'],
  ['Bun.spawn([variable])', "Bun.spawn([bin, 'ls'])", 'unlisted-process-start'],
  ['Bun.spawn({ cmd: [variable] })', "Bun.spawn({ cmd: [bin, 'ls'] })", 'unlisted-process-start'],
  ['Bun.spawnSync({ cmd }) shorthand', 'Bun.spawnSync({ cmd })', 'unlisted-process-start'],
  ['Bun.$`${…}`', 'await Bun.$`${bin} ls`', 'unlisted-process-start'],
  ['deps.spawnSync(variable)', "deps.spawnSync(bin, ['ls'])", 'unlisted-process-start'],
  ["spawn('sh', ['-c', variable])", "spawn('sh', ['-c', script])", 'unlisted-process-start'],
  ['cp.exec(variable) on a child_process namespace', "import cp from 'child_process'; cp.exec(command)", 'unlisted-process-start'],
  // A raw tmux sub-command named in a string.
  ['kill-session', "const verb = 'kill-session'", 'raw-tmux-subcommand'],
  ['has-session', 'const verb = "has-session"', 'raw-tmux-subcommand'],
  ['start-server', 'const line = `tmux start-server ${flags}`', 'raw-tmux-subcommand'],
  // removed identifiers, and seams.
  ...REMOVED_IDENTIFIERS.flatMap((name): Array<readonly [string, string, Rule]> => [
    [`${name} in code`, `export const x = ${name}`, 'removed-identifier'],
    [`${name} in a string`, `log('${name}')`, 'removed-identifier'],
  ]),
  // stripComments' shapes: a template nested in ${…} holding a quote, a backtick or a quote in a regex
  // literal. Lexed out of step, the `//` in the string after them would be taken for a comment and the
  // call after it cut.
  ['client.delete after a template nested in ${…} holding a quote', "const q = `'${v.replaceAll(\"'\", `'\\\\''`)}'`; const u = `http://host`; await client.delete(x)", 'client-delete'],
  ['client.delete after a backtick in a regex literal', 'const BACKTICK = /[`]/; const u = `http://host`; await client.delete(x)', 'client-delete'],
  ['client.delete after a quote in a regex literal', `const QUOTE = /["']/; const u = 'http://host'; await client.delete(x)`, 'client-delete'],
  // An escaped slash in a regex literal (ci-live/lib/redact.ts's `/\//g`): lexed out of step, its `//` is a comment.
  ['client.delete after an escaped slash in a regex literal', "const s = json.replace(/\\//g, '\\\\/'); await client.delete(x)", 'client-delete'],
]

/** [what the source holds, the synthetic source]: none is a finding. */
const NEGATIVE: ReadonlyArray<readonly [string, string]> = [
  ['a Map delete', 'const pending = new Map<string, number>(); pending.delete(key)'],
  ['a Set delete', 'seen.delete(key)'],
  ['a delete on a map of clients', 'clients.delete(key)'],
  ['client.spawn(params)', 'await client.spawn(params)'],
  ['getClient().spawn({ … })', 'await getClient().spawn({ instance_id: id, cwd })'],
  ['a database exec', "db.exec('PRAGMA journal_mode = WAL;'); db.exec(SCHEMA_SQL)"],
  ['a regex exec', 'const m = RE.exec(line) ?? /x(\\d+)/.exec(text)'],
  ['a log line naming tmux attach -t', 'console.error(`[slack] attach with \\`tmux attach -t ${target}\\``)'],
  ['a log line reading like a call', "console.error('[slack] retrying spawn (single retry)')"],
  ["the settings module's tmux table name", `export const AD_TMUX_TABLE = '${AD_TMUX_TABLE}'`],
  ['a literal start that is not tmux', "spawn('which', ['cozempic']); spawnSync('bash', [script, file], { stdio: 'inherit' })"],
  ['a shell -c string that is not tmux', "execFileSync('sh', ['-c', 'command -v jq >/dev/null 2>&1'], { stdio: 'ignore' })"],
  ['declarations named like a start', 'interface Deps { spawnSync(cmd: string, args: string[]): number }; function exec(command: string): void {}'],
  ['the attach target builder that stays', 'const target = tmuxExactSessionTarget(name)'],
  // stripComments' shapes: lexed out of step, the comment after them would be kept as literal text.
  ['a commented word after a template nested in ${…} holding a quote', "const q = `'${v.replaceAll(\"'\", `'\\\\''`)}'`\n// include_finished\nconst t = `done`"],
  ['a commented word after a backtick in a regex literal', 'const BACKTICK = /[`]/\n// include_finished\nconst t = `done`'],
  ['a commented word after a quote in a regex literal', "const QUOTE = /'/ // include_finished, isn't it"],
  // Each planted violation inside a line comment and a block comment.
  ...PLANTED.flatMap(([what, source]): Array<readonly [string, string]> => [
    [`${what}, in a line comment`, `// ${source}`],
    [`${what}, in a block comment`, `/* ${source} */`],
  ]),
]

const findingsOf = (file: string, source: string, listed: readonly NonLiteralStart[] = []): Array<Pick<Finding, 'file' | 'rule'>> =>
  auditSources([[file, source]], listed).map(({ file: f, rule }) => ({ file: f, rule }))

const plantedFile = (what: string): string => `planted/${what.replace(/[^\w]+/g, '-')}.ts`

describe('each rule finds its planted violation; negative controls are no finding', () => {
  test.each(PLANTED)('%s: one finding of its rule, naming the synthetic file', (what, source, rule) => {
    const file = plantedFile(what)
    expect(findingsOf(file, source)).toEqual([{ file, rule }])
  })

  test.each(NEGATIVE)('%s: no finding', (what, source) => {
    expect(findingsOf(plantedFile(what), source)).toEqual([])
  })
})

describe('the lexer stays in step through every real src/ file', () => {
  // A violation appended to a copy of each file is found, and the same text in a trailing
  // comment is not: a literal or comment lexed out of step would hide the one or keep the other.
  test.each<readonly [string, Rule]>([
    ['await client.delete(x)', 'client-delete'],
    ["spawn('tmux', ['ls'])", 'tmux-process-start'],
  ])('%s appended to each src/ file is its one finding; commented out, none', (planted, rule) => {
    const appended = SRC_FILES.map(([file, text]) => [file, `${text}\n${planted}\n`] as const)
    expect(auditSources(appended, NON_LITERAL_STARTS).map(({ file, rule: r }) => [file, r])).toEqual(SRC_FILES.map(([file]) => [file, rule]))
    const commented = SRC_FILES.map(([file, text]) => [file, `${text}\n// ${planted}\n/* ${planted} */\n`] as const)
    expect(auditSources(commented, NON_LITERAL_STARTS)).toEqual([])
  })
})

describe('the closed list of non-literal process starts is keyed by file, callee and command', () => {
  const file = 'planted/listed.ts'
  const source = "deps.spawnSync(process.execPath, [process.argv[1], 'stop'])"
  const entry: NonLiteralStart = { file, callee: 'deps.spawnSync', command: 'process.execPath', reason: 'planted' }

  test('a listed start is no finding', () => {
    expect(findingsOf(file, source, [entry])).toEqual([])
  })

  test.each<readonly [string, NonLiteralStart]>([
    ['another file', { ...entry, file: 'planted/other.ts' }],
    ['another callee', { ...entry, callee: 'deps.spawnDaemon' }],
    ['another command', { ...entry, command: 'tmuxPath' }],
  ])('an entry for %s: the start is unlisted and the entry stale', (_what, other) => {
    expect(findingsOf(file, source, [other])).toEqual([
      { file, rule: 'unlisted-process-start' },
      { file: other.file, rule: 'stale-process-start-entry' },
    ])
  })

  test('an entry that matches no start is stale', () => {
    expect(findingsOf(file, 'const nothing = 0', [entry])).toEqual([{ file, rule: 'stale-process-start-entry' }])
  })
})

// ---------------------------------------------------------------------------
// By-name recognition of a class the client declares
// ---------------------------------------------------------------------------

type ByNameRule = 'class-name-comparison' | 'class-name-lookup' | 'class-by-name-call' | 'base-error-named'

interface ByNameFinding {
  /** The file, relative to the repository root. */
  readonly file: string
  readonly rule: ByNameRule
  /** The class names the finding reads, sorted; empty for a base error named through a variable. */
  readonly names: readonly string[]
  /** `line: code` of the finding, for the failure message only. */
  readonly at: string
}

/**
 * The classes the installed client declares: each export of its namespace
 * that is a subclass of its `AgentDirectorError`, [export name, class]. Read
 * from the client, never listed here, so a class a later client adds is
 * audited with no change to this file.
 */
const CLIENT_CLASS_EXPORTS: ReadonlyArray<readonly [string, { readonly name: string }]> = Object.entries(agentDirectorClient as Record<string, unknown>)
  .filter((entry): entry is [string, { readonly name: string }] => typeof entry[1] === 'function' && entry[1].prototype instanceof agentDirectorClient.AgentDirectorError)

/** Every class name the audit guards: the installed client's classes. */
const CLASS_NAMES: ReadonlySet<string> = new Set(CLIENT_CLASS_EXPORTS.map(([name]) => name))

/**
 * The only by-name uses of a class the client declares that the tree keeps,
 * each a finding of `rule` reading `name` in `file`, and nothing else:
 * `ErrAmbiguousRequest` and `ErrPermissionRequestNotFound`, which
 * table does not list and ruling keeps as they are; the
 * version gate's three system-install comparisons; and the checked kill's
 * GONE-name log label. Every other class, at these files included, is decided
 * by `instanceof`. The released client declares the A-13 rows too
 * (`ErrInternal`, `ErrConfigMalformed`, the three store-open names). Only
 * the explicitly guarded unknown-envelope helper decodes their old names;
 * CSCB's `UnknownError` wrapper is not a declared client class.
 */
interface SanctionedByName {
  readonly file: string
  readonly name: string
  readonly rule: ByNameRule
  readonly reason: string
}

const SANCTIONED_BY_NAME: readonly SanctionedByName[] = [
  { file: 'src/permission-click-handler.ts', name: 'ErrAmbiguousRequest', rule: 'class-name-comparison', reason: "decide's defense-in-depth backstop and its trail class" },
  { file: 'src/agent-director-client.ts', name: 'ErrPermissionRequestNotFound', rule: 'class-name-comparison', reason: "the permission poller's sentinel matcher (isErrPermissionRequestNotFound)" },
  { file: 'tests/test-helpers/agent-director-stub.ts', name: 'ErrAmbiguousRequest', rule: 'base-error-named', reason: "the stub's base-error builder, which the click handler's comparison matches" },
  { file: 'tests/test-helpers/agent-director-stub.ts', name: 'ErrPermissionRequestNotFound', rule: 'base-error-named', reason: "the stub's base-error builder, which the sentinel matcher matches" },
  // The version gate classifies `resolveSystemBinary()`'s system-install errors
  // by name and reads their fields structurally by design, with no `instanceof`
  // and no value import from `agent-director` (its module header). Whether it
  // moves to `instanceof` is an open question; until then its three names are
  // sanctioned here, and the staleness test fails on any entry whose
  // comparison is gone.
  { file: 'src/ad-version-gate.ts', name: 'ErrSystemInstallUnreachable', rule: 'class-name-comparison', reason: "the gate's failure rendering and its thrown-failure classifier, by name by design (module header)" },
  { file: 'src/ad-version-gate.ts', name: 'ErrSystemInstallNotFound', rule: 'class-name-comparison', reason: "the gate's thrown-failure classifier, by name by design (module header)" },
  { file: 'src/ad-version-gate.ts', name: 'ErrSystemInstallTooOld', rule: 'class-name-comparison', reason: "the gate's thrown-failure classifier, by name by design (module header)" },
  // `renderSessionGone` renders a log label from a GONE name the kill outcome
  // already holds; it decides no class.
  { file: 'src/checked-kill.ts', name: 'ErrTmuxSendKeys', rule: 'class-name-lookup', reason: "renderSessionGone's log label from a name already decided; it decides no class" },
  { file: 'src/checked-kill.ts', name: 'ErrTmuxCaptureFailed', rule: 'class-name-lookup', reason: "renderSessionGone's log label from a name already decided; it decides no class" },
]

/** What an error's name is read as: these properties (`x.errName`, `x['name']`) or bare identifiers. */
const NAME_KEYS: readonly string[] = ['errName', 'unknownName', 'name']

/** The properties a builder may set on a base error to name it. */
const NAME_SET_KEYS: readonly string[] = ['name', 'errName']

/** Methods that look a key up in a collection. */
const LOOKUP_METHODS: readonly string[] = ['get', 'has', 'includes', 'indexOf', 'lastIndexOf']

/** Callees whose arguments are log text (`console.error`, `log`, `deps.warn`). */
const LOG_CALLEES: readonly string[] = ['log', 'warn', 'error', 'info', 'debug']

/** The module that re-exports the client's error classes. */
const ERRORS_FILE = 'src/agent-director-errors.ts'

/** The agent-director stub, audited beside `src/`. */
const STUB_FILE = 'tests/test-helpers/agent-director-stub.ts'

/** Identifiers found to hold a class name (`constants`) or a collection holding one (`collections`), each with the names it holds. */
interface ClassNameBindings {
  readonly constants: Map<string, ReadonlySet<string>>
  readonly collections: Map<string, ReadonlySet<string>>
}

const parseSource = (file: string, text: string): ts.SourceFile => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

/** Calls `visit` on every node under `root`, depth first. */
function forEachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node)
    ts.forEachChild(node, walk)
  }
  walk(root)
}

/** `expr` without parentheses, casts, `!`, `satisfies`, `await` and `Object.freeze(…)`. */
function unwrap(expr: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)
      || ts.isTypeAssertionExpression(expr) || ts.isAwaitExpression(expr)) {
      expr = expr.expression
    } else if (ts.isCallExpression(expr) && expr.expression.getText() === 'Object.freeze' && expr.arguments.length === 1) {
      expr = expr.arguments[0]!
    } else {
      return expr
    }
  }
}

/** The name a reference ends in: `x` for `x`, `a.x` or `a?.x`; undefined for anything else. */
function memberName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return undefined
}

/** The text of a string literal or a template with no substitution, else undefined. */
const literalOf = (node: ts.Node): string | undefined => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined)

/** The class names `expr` is: the literal, a constant holding one, or an element (by index) of a collection of them; empty for anything else. */
function namesOf(expr: ts.Expression, b: ClassNameBindings): string[] {
  const inner = unwrap(expr)
  const literal = literalOf(inner)
  if (literal !== undefined) return CLASS_NAMES.has(literal) ? [literal] : []
  const name = memberName(inner)
  if (name !== undefined) return [...(b.constants.get(name) ?? [])]
  return ts.isElementAccessExpression(inner) && ts.isNumericLiteral(inner.argumentExpression) ? collectionNames(inner.expression, b) : []
}

/** Whether `expr` reads an error's name (`NAME_KEYS`). */
function isNameRead(expr: ts.Expression): boolean {
  const inner = unwrap(expr)
  if (ts.isElementAccessExpression(inner)) return NAME_KEYS.includes(literalOf(inner.argumentExpression) ?? '')
  return NAME_KEYS.includes(memberName(inner) ?? '')
}

/**
 * The class names the collection `expr` holds: an identifier found to hold
 * them, an array literal with them (nested arrays and spreads included), an
 * object literal keyed by them (a computed key, or a plain key spelled as
 * one), or a `new Set(…)` / `new Map(…)` over them; empty for anything else.
 */
function collectionNames(expr: ts.Expression, b: ClassNameBindings): string[] {
  const inner = unwrap(expr)
  const name = memberName(inner)
  if (name !== undefined) return [...(b.collections.get(name) ?? [])]
  if (ts.isArrayLiteralExpression(inner)) {
    return inner.elements.flatMap((el) => {
      const item = ts.isSpreadElement(el) ? el.expression : el
      return [...namesOf(item, b), ...collectionNames(item, b)]
    })
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.flatMap((p) => {
      if (ts.isSpreadAssignment(p)) return collectionNames(p.expression, b)
      if (p.name === undefined) return []
      if (ts.isComputedPropertyName(p.name)) return namesOf(p.name.expression, b)
      const key = ts.isIdentifier(p.name) ? p.name.text : literalOf(p.name) ?? ''
      return CLASS_NAMES.has(key) ? [key] : []
    })
  }
  if (ts.isNewExpression(inner) && ['Set', 'Map'].includes(memberName(inner.expression) ?? '')) return (inner.arguments ?? []).flatMap((a) => collectionNames(a, b))
  return []
}

/**
 * The identifiers in `sources` declared with a class name (constants) or a
 * collection of them, followed through other declarations (`const X = Y`)
 * to a fixed point, starting from `base`.
 */
function classNameBindings(sources: readonly ts.SourceFile[], base?: ClassNameBindings): ClassNameBindings {
  const b: ClassNameBindings = { constants: new Map(base?.constants), collections: new Map(base?.collections) }
  const grow = (into: Map<string, ReadonlySet<string>>, id: string, names: readonly string[]): boolean => {
    const had = into.get(id)
    const merged = new Set([...(had ?? []), ...names])
    if (had !== undefined && merged.size === had.size) return false
    into.set(id, merged)
    return true
  }
  for (let grew = true; grew;) {
    grew = false
    for (const sf of sources) {
      forEachNode(sf, (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.initializer === undefined) return
        const held = namesOf(node.initializer, b)
        if (held.length > 0) {
          if (grow(b.constants, node.name.text, held)) grew = true
          return
        }
        const collected = collectionNames(node.initializer, b)
        if (collected.length > 0 && grow(b.collections, node.name.text, collected)) grew = true
      })
    }
  }
  return b
}

/** Whether `expr` is `new AgentDirectorError(…)` (the base class, by any import name ending in it). */
function isBaseErrorNew(expr: ts.Expression): boolean {
  const inner = unwrap(expr)
  return ts.isNewExpression(inner) && memberName(inner.expression) === 'AgentDirectorError'
}

const EQUALITY_OPERATORS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])

/**
 * Every place `files` ([repository path, text]) recognises a class the
 * client declares (`CLASS_NAMES`) by name rather than by class, the names and
 * collections found in `files` added to `base` (the tree's, so a planted
 * source can use the real constants):
 *
 * - `class-name-comparison`: `===`, `!==`, `==` or `!=` between a name read
 *   (`errName`, `unknownName`, `name`) and a class name, or a `switch` on a
 *   name read with a `case` of one.
 * - `class-name-lookup`: `get`, `has`, `includes`, `indexOf` or
 *   `lastIndexOf` with a class name, or on a collection of them with a name
 *   read; an element read at a class name, or of a collection of them at a
 *   name read; `in` with either.
 * - `class-by-name-call`: any other call with a class name as an argument (a
 *   by-name helper such as `hasAdErrorName(err, NAME)`, or a by-name builder
 *   such as `errGeneric(verb, NAME, description)`), except a log call
 *   (`LOG_CALLEES`).
 * - `base-error-named`: a base `AgentDirectorError` built with a class name,
 *   or a base error whose `name` or `errName` is then set (an assignment,
 *   `Object.defineProperty` or `Object.assign` on it).
 *
 * Allowed: a `new` of any other class with a name (the stub's builders on the class
 * bindings); names in templates and string concatenation (log labels);
 * declaring and iterating the constants and collections
 * (`PHASE1_ONLY_ERR_NAMES`, `REQUIRED_ERR_NAMES` and the catalogue check).
 * `SANCTIONED_BY_NAME`'s uses are findings here, which `unsanctioned` drops.
 */
function byNameFindings(files: ReadonlyArray<readonly [string, string]>, base?: ClassNameBindings): ByNameFinding[] {
  const sources = files.map(([file, text]) => parseSource(file, text))
  const b = classNameBindings(sources, base)
  const findings: ByNameFinding[] = []
  for (const sf of sources) {
    const file = sf.fileName
    const add = (rule: ByNameRule, node: ts.Node, names: readonly string[]): void => {
      // Native and base errors must dispatch by class. This helper alone decodes
      // the unknownName field of an explicit ErrUnknownErrorName envelope.
      let enclosing: ts.Node | undefined = node.parent
      while (enclosing && !ts.isFunctionDeclaration(enclosing)) enclosing = enclosing.parent
      const envelopeName = (expr: ts.Expression) => ts.isIdentifier(unwrap(expr)) && unwrap(expr).getText(sf) === 'unknownName'
      const unknownEnvelopeRead = ts.isBinaryExpression(node)
        ? envelopeName(node.left) || envelopeName(node.right)
        : ts.isCallExpression(node) && node.arguments.some(envelopeName)
      if (file === 'src/ad-error-class.ts' && enclosing && ts.isFunctionDeclaration(enclosing)
        && enclosing.name?.text === 'classifyUnknownName' && unknownEnvelopeRead
        && (rule === 'class-name-comparison' || rule === 'class-name-lookup')) return
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      findings.push({ file, rule, names: [...new Set(names)].sort(), at: `${line}: ${node.getText(sf).replace(/\s+/g, ' ').slice(0, 120)}` })
    }
    const baseErrors = new Set<string>()
    forEachNode(sf, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isBaseErrorNew(node.initializer)) baseErrors.add(node.name.text)
    })
    const isBaseError = (expr: ts.Expression): boolean => {
      const inner = unwrap(expr)
      return isBaseErrorNew(inner) || (ts.isIdentifier(inner) && baseErrors.has(inner.text))
    }
    const setsBaseErrorName = (target: ts.Expression): boolean => {
      const inner = unwrap(target)
      if (ts.isPropertyAccessExpression(inner)) return NAME_SET_KEYS.includes(inner.name.text) && isBaseError(inner.expression)
      return ts.isElementAccessExpression(inner) && NAME_SET_KEYS.includes(literalOf(inner.argumentExpression) ?? '') && isBaseError(inner.expression)
    }
    const namesAProperty = (arg: ts.Expression): boolean => ts.isObjectLiteralExpression(arg)
      && arg.properties.some((p) => p.name !== undefined && NAME_SET_KEYS.includes(ts.isIdentifier(p.name) ? p.name.text : literalOf(p.name) ?? ''))

    forEachNode(sf, (node) => {
      if (ts.isBinaryExpression(node)) {
        const { left, right } = node
        const op = node.operatorToken.kind
        const compared = EQUALITY_OPERATORS.has(op) ? [...(isNameRead(left) ? namesOf(right, b) : []), ...(isNameRead(right) ? namesOf(left, b) : [])] : []
        const contained = op === ts.SyntaxKind.InKeyword ? [...namesOf(left, b), ...(isNameRead(left) ? collectionNames(right, b) : [])] : []
        if (compared.length > 0) add('class-name-comparison', node, compared)
        else if (contained.length > 0) add('class-name-lookup', node, contained)
        else if (op === ts.SyntaxKind.EqualsToken && setsBaseErrorName(left)) add('base-error-named', node, [])
      } else if (ts.isSwitchStatement(node) && isNameRead(node.expression)) {
        for (const clause of node.caseBlock.clauses) {
          const names = ts.isCaseClause(clause) ? namesOf(clause.expression, b) : []
          if (names.length > 0) add('class-name-comparison', clause, names)
        }
      } else if (ts.isElementAccessExpression(node)) {
        const names = [...namesOf(node.argumentExpression, b), ...(isNameRead(node.argumentExpression) ? collectionNames(node.expression, b) : [])]
        if (names.length > 0) add('class-name-lookup', node, names)
      } else if (ts.isNewExpression(node)) {
        const names = isBaseErrorNew(node) ? (node.arguments ?? []).flatMap((a) => namesOf(a, b)) : []
        if (names.length > 0) add('base-error-named', node, names)
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression
        const args = node.arguments
        const calleeText = callee.getText(sf).replace(/\s+/g, '')
        const argNames = args.flatMap((a) => namesOf(a, b))
        const lookedUp = ts.isPropertyAccessExpression(callee) && LOOKUP_METHODS.includes(callee.name.text)
          ? [...argNames, ...(args.some((a) => isNameRead(a)) ? collectionNames(callee.expression, b) : [])]
          : []
        if (calleeText === 'Object.defineProperty' && args.length >= 2 && isBaseError(args[0]!) && NAME_SET_KEYS.includes(literalOf(args[1]!) ?? '')) {
          add('base-error-named', node, [])
        } else if (calleeText === 'Object.assign' && args.length >= 2 && isBaseError(args[0]!) && args.slice(1).some(namesAProperty)) {
          add('base-error-named', node, [])
        } else if (lookedUp.length > 0) {
          add('class-name-lookup', node, lookedUp)
        } else if (!LOG_CALLEES.includes(memberName(callee) ?? '') && argNames.length > 0) {
          add('class-by-name-call', node, argNames)
        }
      }
    })
  }
  return findings
}

/** Whether `finding` is sanctioned: every name it reads is sanctioned in its file for its rule. */
const isSanctioned = (finding: ByNameFinding): boolean => finding.names.length > 0
  && finding.names.every((name) => SANCTIONED_BY_NAME.some((s) => s.file === finding.file && s.rule === finding.rule && s.name === name))

/** `findings` without the sanctioned ones. */
const unsanctioned = (findings: readonly ByNameFinding[]): ByNameFinding[] => findings.filter((f) => !isSanctioned(f))

/** Every `src/` file (`src/<name>`) and the stub: [repository path, text]. */
const BY_NAME_TREE: ReadonlyArray<readonly [string, string]> = [
  ...SRC_FILES.map(([name, text]) => [`src/${name}`, text] as const),
  [STUB_FILE, readFileSync(join(import.meta.dir, '..', STUB_FILE), 'utf-8')],
]

/** The tree's name constants and collections, which planted sources may use. */
const TREE_BINDINGS = classNameBindings(BY_NAME_TREE.map(([file, text]) => parseSource(file, text)))

/** The tree's findings, sanctioned ones included. */
const TREE_FINDINGS = byNameFindings(BY_NAME_TREE)

const ERRORS_IMPORT = "import { ERR_SPAWN_NOT_FOUND_NAME, ERR_TMUX_KILL_FAILED_NAME, ERR_TMUX_SESSION_CONFLICT_NAME, ERR_TMUX_UNRESPONSIVE_NAME, PHASE1_ONLY_ERR_NAMES } from './agent-director-errors.ts'"

/** [what is planted, the synthetic source, the one rule it breaks]. */
const BY_NAME_PLANTED: ReadonlyArray<readonly [string, string, ByNameRule]> = [
  // Comparisons of errName, unknownName or name with a name.
  ["errName === a literal", "if (err.errName === 'ErrTmuxKillFailed') retry()", 'class-name-comparison'],
  ['a constant === errName', `${ERRORS_IMPORT}\nif (ERR_TMUX_SESSION_CONFLICT_NAME === err.errName) latch()`, 'class-name-comparison'],
  ['unknownName !== a constant', `${ERRORS_IMPORT}\nif (err.unknownName !== ERR_TMUX_UNRESPONSIVE_NAME) return`, 'class-name-comparison'],
  ['name == a literal', "if (err.name == 'ErrTmuxSessionConflict') latch()", 'class-name-comparison'],
  ['errName != a template literal', 'if (err.errName != `ErrTmuxUnresponsive`) return', 'class-name-comparison'],
  ['errName through a cast, optional chaining and a namespace constant', "import * as errors from './agent-director-errors.ts'\nif ((err as AgentDirectorError)?.errName === errors.ERR_TMUX_KILL_FAILED_NAME) retry()", 'class-name-comparison'],
  ["err['errName'] === a constant", `${ERRORS_IMPORT}\nif (err['errName'] === ERR_TMUX_KILL_FAILED_NAME) retry()`, 'class-name-comparison'],
  ['the constructor name === a literal', "if (err.constructor.name === 'ErrTmuxKillFailed') retry()", 'class-name-comparison'],
  ['a destructured errName === a constant', `${ERRORS_IMPORT}\nconst { errName } = err\nif (errName === ERR_TMUX_UNRESPONSIVE_NAME) retry()`, 'class-name-comparison'],
  ['errName === a local alias of a constant', `${ERRORS_IMPORT}\nconst KILL = ERR_TMUX_KILL_FAILED_NAME\nif (err.errName === KILL) retry()`, 'class-name-comparison'],
  ['errName === a src alias of a constant', "import { LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE } from './ad-error-class.ts'\nif (err.errName === LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE) wait()", 'class-name-comparison'],
  ['errName === an element of PHASE1_ONLY_ERR_NAMES', `${ERRORS_IMPORT}\nif (err.errName === PHASE1_ONLY_ERR_NAMES[0]) retry()`, 'class-name-comparison'],
  ['a switch on errName with a case of a constant', `${ERRORS_IMPORT}\nswitch (err.errName) {\n  case ERR_TMUX_SESSION_CONFLICT_NAME: return 'conflict'\n  default: return 'other'\n}`, 'class-name-comparison'],
  // Classes every client declares, read from the installed client's namespace.
  ["errName === ErrSpawnNotFound's literal (the kill site's look-alike)", "if (isAdErrorInstance(error, ErrSpawnNotFound) || error?.errName === 'ErrSpawnNotFound') return { kind: KILL_OUTCOME_ROW_GONE }", 'class-name-comparison'],
  ['errName === ERR_SPAWN_NOT_FOUND_NAME', `${ERRORS_IMPORT}\nif (err.errName === ERR_SPAWN_NOT_FOUND_NAME) skip()`, 'class-name-comparison'],
  ['errName === a CSCB alias of the client timeout name', "import { LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT } from './ad-error-class.ts'\nif (err.errName === LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT) wait()", 'class-name-comparison'],
  ["name === ErrInstanceIdCollision's literal", "if (err.name === 'ErrInstanceIdCollision') retryCollision()", 'class-name-comparison'],
  ["a switch on errName with a case of ErrNoSessionId", "switch (err.errName) {\n  case 'ErrNoSessionId': return reuse()\n  default: return fail()\n}", 'class-name-comparison'],
  // By-name helper calls.
  ['hasAdErrorName with a constant', `${ERRORS_IMPORT}\nif (hasAdErrorName(err, ERR_TMUX_KILL_FAILED_NAME)) retry()`, 'class-by-name-call'],
  ['a by-name helper with a literal', "if (isNamed(err, 'ErrTmuxUnresponsive')) wait()", 'class-by-name-call'],
  ['an optional by-name helper on a receiver', `${ERRORS_IMPORT}\ndeps.matchesName?.(err, ERR_TMUX_UNRESPONSIVE_NAME)`, 'class-by-name-call'],
  ['a by-name builder (errGeneric)', `${ERRORS_IMPORT}\nthrow errGeneric('spawn', ERR_TMUX_SESSION_CONFLICT_NAME, 'not this launch')`, 'class-by-name-call'],
  ['a by-name builder of ErrSpawnNotFound', `${ERRORS_IMPORT}\nthrow errGeneric('kill', ERR_SPAWN_NOT_FOUND_NAME, 'row gone')`, 'class-by-name-call'],
  // Map or set lookups keyed by a name.
  ['a map get at a constant', `${ERRORS_IMPORT}\nconst cls = CLASS_BY_NAME.get(ERR_TMUX_KILL_FAILED_NAME)`, 'class-name-lookup'],
  ['PHASE1_ONLY_ERR_NAMES.includes(errName)', `${ERRORS_IMPORT}\nif (PHASE1_ONLY_ERR_NAMES.includes(err.errName)) retry()`, 'class-name-lookup'],
  ['a Set over PHASE1_ONLY_ERR_NAMES has unknownName', `${ERRORS_IMPORT}\nif (new Set(PHASE1_ONLY_ERR_NAMES).has(err.unknownName)) retry()`, 'class-name-lookup'],
  ['an inline array of literals includes name', "if (['ErrTmuxKillFailed', 'ErrTmuxUnresponsive'].includes(err.name)) retry()", 'class-name-lookup'],
  ['a declared Set of constants has errName', `${ERRORS_IMPORT}\nconst RETRYABLE = new Set([ERR_TMUX_UNRESPONSIVE_NAME, ERR_TMUX_KILL_FAILED_NAME])\nif (RETRYABLE.has(err.errName)) retry()`, 'class-name-lookup'],
  ['a declared Set of no-transcript names has errName', "const NO_TRANSCRIPT = new Set(['ErrNoSessionId', 'ErrJsonlMissing', 'ErrJsonlNeverWritten'])\nif (NO_TRANSCRIPT.has(err.errName)) reuse()", 'class-name-lookup'],
  ['a frozen Map of constants get errName', `${ERRORS_IMPORT}\nconst KIND = Object.freeze(new Map([[ERR_TMUX_KILL_FAILED_NAME, 'kill']]))\nconst kind = KIND.get(err.errName)`, 'class-name-lookup'],
  ['a table keyed by a computed constant, read at errName', `${ERRORS_IMPORT}\nconst CLASS_OF = { [ERR_TMUX_SESSION_CONFLICT_NAME]: 'CONFLICT' } as const\nconst cls = CLASS_OF[err.errName]`, 'class-name-lookup'],
  ['a table keyed by a plain name, read at errName', "const CLASS_OF = { ErrTmuxKillFailed: 'UNAVAILABLE' }\nconst cls = CLASS_OF[err.errName]", 'class-name-lookup'],
  ['a table keyed by a plain 0.10.0 class name, read at errName', "const CLASS_OF = { ErrSystemInstallDisappeared: 'UNCLASSIFIED' }\nconst cls = CLASS_OF[err.errName]", 'class-name-lookup'],
  ['a table read at a constant', `${ERRORS_IMPORT}\nconst handle = HANDLERS[ERR_TMUX_KILL_FAILED_NAME]`, 'class-name-lookup'],
  ['errName in a table keyed by a constant', `${ERRORS_IMPORT}\nconst CLASS_OF = { [ERR_TMUX_UNRESPONSIVE_NAME]: 'UNAVAILABLE' }\nif (err.errName in CLASS_OF) retry()`, 'class-name-lookup'],
  // A base error named like a class.
  ['a builder that makes a base error and then sets its name', 'function byName(name: string, verb: string, description: string) {\n  const err = new AgentDirectorError(verb, name, description)\n  err.name = name\n  return err\n}', 'base-error-named'],
  ["a base error's name set in the bracket form", "const err = new AgentDirectorError(verb, errName, description)\nerr['name'] = errName", 'base-error-named'],
  ["a base error's name set by Object.defineProperty", "const err = new AgentDirectorError(verb, errName, description)\nObject.defineProperty(err, 'name', { value: errName })", 'base-error-named'],
  ['a base error named by Object.assign', 'return Object.assign(new AgentDirectorError(verb, errName, description), { name: errName })', 'base-error-named'],
  ['a base error built with a constant', `${ERRORS_IMPORT}\nthrow new AgentDirectorError('kill', ERR_TMUX_KILL_FAILED_NAME, 'retry kill later')`, 'base-error-named'],
  ['a base error built through a namespace with a literal', "import * as ad from 'agent-director'\nthrow new ad.AgentDirectorError('spawn', 'ErrTmuxUnresponsive', 'did not answer')", 'base-error-named'],
  ['a base error built with a 0.10.0 class name', "throw new AgentDirectorError('get', 'ErrSpawnNotFound', 'spawn not found')", 'base-error-named'],
]

/**
 * [what is planted, the real path it is planted at, the synthetic source, the
 * one rule it breaks]: by-name recognitions at the sanctioned sites' files and
 * at the kill sites that `SANCTIONED_BY_NAME` does not cover.
 */
const BY_NAME_PLANTED_AT: ReadonlyArray<readonly [string, string, string, ByNameRule]> = [
  ["ErrSpawnNotFound by name beside its class at the checked kill", 'src/checked-kill.ts',
    "if (isAdErrorInstance(error, ErrSpawnNotFound) || error?.errName === 'ErrSpawnNotFound') return { kind: KILL_OUTCOME_ROW_GONE }", 'class-name-comparison'],
  ["ErrSpawnNotFound by name beside its class at the kill retry's read", 'src/kill-retry.ts',
    "if (isAdErrorInstance(error, ErrSpawnNotFound) || error?.errName === 'ErrSpawnNotFound') return { kind: KILL_RETRY_VERDICT_FINISHED, read: KILL_ROW_FINISHED_NO_ROW }", 'class-name-comparison'],
  ['ErrAmbiguousRequest by name outside the click handler', 'src/permission-poller.ts',
    "if (err instanceof AgentDirectorError && err.errName === 'ErrAmbiguousRequest') return true", 'class-name-comparison'],
  ['ErrPermissionRequestNotFound by name outside the client module', 'src/permission-click-handler.ts',
    "if (err instanceof AgentDirectorError && err.errName === 'ErrPermissionRequestNotFound') return true", 'class-name-comparison'],
  ['another class by name in the click handler', 'src/permission-click-handler.ts',
    "if (err instanceof AgentDirectorError && err.errName === 'ErrAlreadyDecided') return 'ErrAlreadyDecided'", 'class-name-comparison'],
  ['a sanctioned name and another in one switch case list', 'src/permission-click-handler.ts',
    "switch (err.errName) {\n  case 'ErrAmbiguousRequest': return 'ambiguous'\n  case 'ErrSpawnNotFound': return 'gone'\n}", 'class-name-comparison'],
  ['a sanctioned name in a lookup, not a comparison', 'src/permission-click-handler.ts',
    "if (['ErrAmbiguousRequest'].includes(err.errName)) return true", 'class-name-lookup'],
  ['a sanctioned name in a by-name helper call', 'src/agent-director-client.ts',
    "return hasAdErrorName(err, 'ErrPermissionRequestNotFound')", 'class-by-name-call'],
  ['a base error named like a class the stub has no sanction for', STUB_FILE,
    "return new AgentDirectorError('kill', 'ErrSpawnNotFound', 'row gone')", 'base-error-named'],
  ['a sanctioned name compared in the stub, where only its base-error builder is sanctioned', STUB_FILE,
    "if (err.errName === 'ErrAmbiguousRequest') return true", 'class-name-comparison'],
  // The module that re-exports the client's classes has no exemption: the shapes of a resolver that
  // picked a class or a stand-in by name are findings there too.
  ['a by-name call inside a resolver in the re-export module', ERRORS_FILE,
    'function resolveClasses(err: unknown) { return hasAdErrorName(err, ERR_TMUX_KILL_FAILED_NAME) }', 'class-by-name-call'],
  ['a stand-in table built by name in the re-export module', ERRORS_FILE,
    'const STAND_INS = { [ERR_TMUX_KILL_FAILED_NAME]: makeStandIn(ERR_TMUX_KILL_FAILED_NAME) }', 'class-by-name-call'],
  ['a stand-in table read at a name in the re-export module', ERRORS_FILE,
    'const STAND_INS = { [ERR_TMUX_KILL_FAILED_NAME]: KillFailedStandIn }\nconst pick = (name: string) => STAND_INS[name]', 'class-name-lookup'],
]

/** [what the source holds, its repository path, the synthetic source]: none is a finding. */
const BY_NAME_ALLOWED: ReadonlyArray<readonly [string, string, string]> = [
  ['the name constants and PHASE1_ONLY_ERR_NAMES declared', 'planted/declarations.ts', [
    "export const ERR_TMUX_KILL_FAILED_NAME = 'ErrTmuxKillFailed'",
    "export const ERR_TMUX_UNRESPONSIVE_NAME = 'ErrTmuxUnresponsive'",
    "export const ERR_SPAWN_NOT_FOUND_NAME = 'ErrSpawnNotFound'",
    'export const PHASE1_ONLY_ERR_NAMES = [ERR_TMUX_KILL_FAILED_NAME, ERR_TMUX_UNRESPONSIVE_NAME] as const',
    'export type Phase1OnlyErrName = (typeof PHASE1_ONLY_ERR_NAMES)[number]',
  ].join('\n')],
  ['REQUIRED_ERR_NAMES and the catalogue check', 'planted/catalogue.ts', [
    ERRORS_IMPORT,
    "export const REQUIRED_ERR_NAMES = ['ErrInvalidFlags', ...PHASE1_ONLY_ERR_NAMES] as const",
    'for (const name of REQUIRED_ERR_NAMES) {',
    '  if (!new RegExp(`class\\\\s+${name}\\\\s`).test(distText)) missing.push(name)',
    '}',
  ].join('\n')],
  ['log labels', 'planted/log-labels.ts', [
    ERRORS_IMPORT,
    'log(`[slack] kill failed: ${ERR_TMUX_KILL_FAILED_NAME} ${message}`)',
    "console.error('[slack] unavailable:', ERR_TMUX_UNRESPONSIVE_NAME)",
    "const line = 'conflict ' + ERR_TMUX_SESSION_CONFLICT_NAME",
    'console.error(`[slack] reading the row failed: ${ERR_SPAWN_NOT_FOUND_NAME}`)',
  ].join('\n')],
  ['deciding by class', 'planted/by-class.ts', [
    "import { ErrTmuxKillFailed, ErrTmuxSessionConflict } from './agent-director-errors.ts'",
    'if (isAdErrorInstance(err, ErrTmuxKillFailed)) retry()',
    'if (err instanceof ErrTmuxSessionConflict) latch()',
    'if (isAdErrorInstance(error, ErrSpawnNotFound)) return { kind: KILL_OUTCOME_ROW_GONE }',
  ].join('\n')],
  ["the stub's builders on the class bindings", 'planted/stub-builders.ts', [
    ERRORS_IMPORT,
    "return new ErrTmuxKillFailed('kill', ERR_TMUX_KILL_FAILED_NAME, text[description])",
    'return new ErrTmuxUnresponsive(verb, ERR_TMUX_UNRESPONSIVE_NAME, description)',
    "return new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'spawn not found')",
  ].join('\n')],
  ['comparisons and base errors for names that are no client class', 'planted/other-names.ts', [
    "if (err.errName === 'ErrFromALaterBinary') return",
    "if (err.unknownName === 'ErrFromALaterBinary') return",
    'if (err.errName === ERR_SPAWN_CAP_REACHED_NAME) return capHint()',
    "return new AgentDirectorError('decide', 'ErrFromALaterBinary', 'internal error')",
  ].join('\n')],
  ['the CSCB UnknownError wrapper', 'src/ad-error-class.ts', [
    "const CSCB_UNKNOWN_ERROR_NAME = 'UnknownError'",
    "const errName = readProp(value, 'errName')",
    'if (errName === CSCB_UNKNOWN_ERROR_NAME) return { errorClass: AD_ERROR_CLASS_UNAVAILABLE }',
  ].join('\n')],
  ['the sanctioned ErrAmbiguousRequest comparisons in the click handler', 'src/permission-click-handler.ts', [
    "if (err instanceof AgentDirectorError && err.errName === 'ErrAmbiguousRequest') return 'ErrAmbiguousRequest'",
    "if (err instanceof AgentDirectorError && err.errName === 'ErrAmbiguousRequest') {",
    '  return true',
    '}',
  ].join('\n')],
  ['the sanctioned ErrPermissionRequestNotFound comparison in the client module', 'src/agent-director-client.ts',
    "return err instanceof AgentDirectorError && err.errName === 'ErrPermissionRequestNotFound'"],
  ["the stub's sanctioned base-error builders", STUB_FILE, [
    "return new AgentDirectorError('decide', 'ErrAmbiguousRequest', 'ambiguous request')",
    "return new AgentDirectorError('get-permission', 'ErrPermissionRequestNotFound', 'permission request not found')",
  ].join('\n')],
  ['an error rebuilt from its own class with its own name', 'planted/rebuild.ts', [
    'const Made = err.constructor as new (verb: string, errName: string, description: string) => E',
    'const restored = new Made(err.verb, err.errName, `${err.errDescription}; ${sentence}`)',
    'restored.name = err.name',
  ].join('\n')],
  ['a table of labelled rows found by its label', 'planted/forms.ts', [
    "const FORMS = [['ErrTmuxKillFailed', () => errTmuxKillFailed()], ['ErrCallTimeout', () => errCallTimeout()]] as const",
    'const form = FORMS.find(([l]) => l === label)',
  ].join('\n')],
  ['the names in strings and comments', 'planted/text.ts', [
    "// if (err.errName === 'ErrTmuxKillFailed') retry()",
    '/* hasAdErrorName(err, ERR_TMUX_KILL_FAILED_NAME) */',
    "const doc = \"err.errName === 'ErrTmuxSessionConflict'\"",
    "// if (error?.errName === 'ErrSpawnNotFound') return { kind: KILL_OUTCOME_ROW_GONE }",
  ].join('\n')],
]

/** The client's declared subclasses of `AgentDirectorError`, read from its shipped declarations, which the namespace read must match. */
const DECLARED_CLASS_NAMES: readonly string[] = [
  ...readFileSync(join(import.meta.dir, '..', 'node_modules', 'agent-director', 'dist', 'errors.d.ts'), 'utf-8')
    .matchAll(/^export declare class (\w+) extends \w+/gm),
].map((m) => m[1]!).filter((name) => name !== 'AgentDirectorError')

describe('every class the client declares is decided by class in src/ and the stub, never by name', () => {
  test('the class names are read from the installed client: each of its declared error classes, by its own name, the three Phase-1-only classes among them', () => {
    expect(CLIENT_CLASS_EXPORTS.map(([name]) => name).sort()).toEqual([...DECLARED_CLASS_NAMES].sort())
    for (const [name, cls] of CLIENT_CLASS_EXPORTS) expect(cls.name).toBe(name)
    expect(CLASS_NAMES.has('AgentDirectorError')).toBe(false)
    expect(DECLARED_CLASS_NAMES).toEqual(expect.arrayContaining([...PHASE1_ONLY_ERR_NAMES]))
  })

  test('the real src/ and the stub have no finding but the sanctioned uses', () => {
    expect(BY_NAME_TREE.map(([file]) => file)).toEqual(expect.arrayContaining([ERRORS_FILE, 'src/ad-error-class.ts', 'src/checked-kill.ts', 'src/kill-retry.ts', STUB_FILE]))
    expect(unsanctioned(TREE_FINDINGS)).toEqual([])
  })

  test.each(SANCTIONED_BY_NAME.map((s) => [`${s.rule} of ${s.name} in ${s.file}`, s] as const))('the sanctioned %s names a class the installed client declares and still matches a site there', (_label, s) => {
    expect(CLIENT_CLASS_EXPORTS.map(([name]) => name)).toContain(s.name)
    expect(TREE_FINDINGS.some((f) => f.file === s.file && f.rule === s.rule && f.names.includes(s.name))).toBe(true)
  })

  test('the audit finds the real name constants and collections', () => {
    expect([...TREE_BINDINGS.constants.keys()]).toEqual(expect.arrayContaining(['ERR_TMUX_KILL_FAILED_NAME', 'ERR_TMUX_UNRESPONSIVE_NAME', 'ERR_TMUX_SESSION_CONFLICT_NAME', 'ERR_SPAWN_NOT_FOUND_NAME']))
    expect([...TREE_BINDINGS.collections.keys()]).toEqual(expect.arrayContaining(['PHASE1_ONLY_ERR_NAMES', 'REQUIRED_ERR_NAMES']))
  })

  test.each(BY_NAME_PLANTED)('%s: one finding of its rule, naming the synthetic file', (what, source, rule) => {
    const file = plantedFile(what)
    expect(unsanctioned(byNameFindings([[file, source]], TREE_BINDINGS)).map(({ file: f, rule: r }) => ({ file: f, rule: r }))).toEqual([{ file, rule }])
  })

  test.each(BY_NAME_PLANTED_AT)('%s (planted at %s): one finding of its rule, which no sanction drops', (_what, file, source, rule) => {
    expect(unsanctioned(byNameFindings([[file, source]], TREE_BINDINGS)).map(({ file: f, rule: r }) => ({ file: f, rule: r }))).toEqual([{ file, rule }])
  })

  test.each(BY_NAME_ALLOWED)('%s: no finding', (_what, file, source) => {
    expect(unsanctioned(byNameFindings([[file, source]], TREE_BINDINGS))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The three Phase-1-only classes are the pinned client's own
// ---------------------------------------------------------------------------

/** The three Phase-1-only class names, as the audits below take them. */
const PHASE1_NAMES: readonly string[] = PHASE1_ONLY_ERR_NAMES

/**
 * The Phase-1-only names `sf` does not re-export as plain static named
 * re-exports of agent-director: an element `X` (no `as`, not type-only) of an
 * `export { … } from 'agent-director'` declaration that is not type-only.
 * Anything else that would export the name (a local binding, an aliased or
 * type-only re-export, a re-export from another module, `export *`) leaves
 * it missing.
 */
function phase1ReExportFindings(sf: ts.SourceFile): string[] {
  const reExported = new Set<string>()
  forEachNode(sf, (node) => {
    if (!ts.isExportDeclaration(node) || node.isTypeOnly || node.moduleSpecifier === undefined) return
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== AGENT_DIRECTOR_MODULE) return
    const clause = node.exportClause
    if (clause === undefined || !ts.isNamedExports(clause)) return
    for (const el of clause.elements) if (!el.isTypeOnly && el.propertyName === undefined) reExported.add(el.name.text)
  })
  return PHASE1_NAMES.filter((name) => !reExported.has(name)).map((name) => `no plain re-export of ${name} from agent-director`)
}

/**
 * Where `sf` reads a Phase-1-only class from agent-director other than by a
 * named import or re-export (see the header): every read
 * `agentDirectorValueReads` finds of the three or cannot name, its named
 * import and re-export specifiers aside, and the namespace or a copy of it
 * passed to a call.
 */
function phase1ReadFindings(sf: ts.SourceFile): string[] {
  return [
    ...agentDirectorValueReads(sf, PHASE1_NAMES)
      .filter((read) => !ts.isImportSpecifier(read.node) && !ts.isExportSpecifier(read.node))
      .map((read) => finding(sf, read.node, read.what)),
    ...agentDirectorNamespaceArguments(sf).map((arg) => finding(sf, arg, 'the agent-director namespace passed to a call')),
  ]
}

/** Whether `node` is `this.name` or `this['name']`. */
function isThisName(node: ts.Expression): boolean {
  const inner = unwrap(node)
  if (ts.isPropertyAccessExpression(inner)) return inner.expression.kind === ts.SyntaxKind.ThisKeyword && inner.name.text === 'name'
  return ts.isElementAccessExpression(inner) && inner.expression.kind === ts.SyntaxKind.ThisKeyword && literalOf(inner.argumentExpression) === 'name'
}

/** The class `node` sits in, nearest first, or undefined. */
function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let at = node.parent; at !== undefined; at = at.parent) if (ts.isClassLike(at)) return at
  return undefined
}

/** Whether `id` names a parameter of a function `site` sits in. */
function isParameterAt(site: ts.Node, id: string): boolean {
  for (let at = site.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionLike(at) && at.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id)) return true
  }
  return false
}

/**
 * What a `name` given to a class at `site` reads as: the Phase-1-only names
 * it is (a literal or a constant holding one), none for another literal or
 * constant, or `unreadable` (a parameter, or anything else).
 */
function givenNames(value: ts.Expression, site: ts.Node, b: ClassNameBindings): string[] | 'unreadable' {
  const inner = unwrap(value)
  const literal = literalOf(inner)
  if (literal !== undefined) return PHASE1_NAMES.includes(literal) ? [literal] : []
  if (ts.isIdentifier(inner) && isParameterAt(site, inner.text)) return 'unreadable'
  const held = memberName(inner) === undefined ? undefined : b.constants.get(memberName(inner)!)
  if (held !== undefined) return [...held].filter((name) => PHASE1_NAMES.includes(name))
  return 'unreadable'
}

/**
 * Every class in `sf` that extends `AgentDirectorError` or a client class
 * (by any import or namespace name ending in it) and is named one of the
 * three Phase-1-only classes: by its own name, the variable, property or
 * computed key it is bound to, or a `name` it is given (`this.name = …` or
 * `this['name'] = …` in its body, `Object.defineProperty(<it or this>,
 * 'name', …)`), where a name the audit cannot read counts as one. `b` holds
 * the name constants.
 */
function phase1StandInFindings(sf: ts.SourceFile, b: ClassNameBindings): string[] {
  const findings: string[] = []
  const bases = new Set(['AgentDirectorError', ...CLASS_NAMES])
  const classes: Array<{ readonly node: ts.ClassLikeDeclaration; readonly bound: string[] }> = []
  forEachNode(sf, (node) => {
    if (!ts.isClassLike(node)) return
    const heritage = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
    if (heritage === undefined || !bases.has(memberName(unwrap(heritage)) ?? '')) return
    const bound: string[] = node.name !== undefined ? [node.name.text] : []
    let outer: ts.Node = node
    while (outer.parent !== undefined && (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent))) outer = outer.parent
    const context = outer.parent
    if (context !== undefined && ts.isVariableDeclaration(context) && ts.isIdentifier(context.name)) bound.push(context.name.text)
    else if (context !== undefined && ts.isPropertyAssignment(context)) {
      if (ts.isComputedPropertyName(context.name)) bound.push(...namesOf(context.name.expression, b))
      else bound.push(literalOf(context.name) ?? (ts.isIdentifier(context.name) ? context.name.text : ''))
    } else if (context !== undefined && ts.isBinaryExpression(context) && context.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      bound.push(memberName(unwrap(context.left)) ?? '')
    }
    classes.push({ node, bound })
  })
  for (const { node, bound } of classes) {
    const named = new Set(bound.filter((name) => PHASE1_NAMES.includes(name)))
    let unreadable = false
    const give = (value: ts.Expression | undefined, site: ts.Node): void => {
      if (value === undefined) return
      const names = givenNames(value, site, b)
      if (names === 'unreadable') unreadable = true
      else for (const name of names) named.add(name)
    }
    const isThisClass = (target: ts.Expression, site: ts.Node): boolean => {
      const inner = unwrap(target)
      if (inner.kind === ts.SyntaxKind.ThisKeyword) return enclosingClass(site) === node
      if (inner === node) return true
      return ts.isIdentifier(inner) && bound.includes(inner.text)
    }
    forEachNode(sf, (site) => {
      if (ts.isBinaryExpression(site) && site.operatorToken.kind === ts.SyntaxKind.EqualsToken && isThisName(site.left) && enclosingClass(site) === node) {
        give(site.right, site)
      } else if (ts.isCallExpression(site) && site.expression.getText(sf).replace(/\s+/g, '') === 'Object.defineProperty' && site.arguments.length >= 3
        && literalOf(site.arguments[1]!) === 'name' && isThisClass(site.arguments[0]!, site)) {
        const descriptor = unwrap(site.arguments[2]!)
        const value = ts.isObjectLiteralExpression(descriptor)
          ? descriptor.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propertyKey(p.name) === 'value')?.initializer
          : undefined
        if (value === undefined) unreadable = true
        else give(value, site)
      }
    })
    if (named.size > 0 || unreadable) {
      const as = named.size > 0 ? [...named].sort().join(', ') : 'a name the audit cannot read'
      findings.push(finding(sf, node, `a class extending AgentDirectorError named ${as}`))
    }
  }
  return findings
}

/** The text of a plain property key (an identifier or string). */
function propertyKey(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) ? name.text : literalOf(name)
}

/** Every `.ts` file under `src/` and `tests/test-helpers/`: [repository path, text]. */
const PHASE1_AUDIT_TREE: ReadonlyArray<readonly [string, string]> = [
  ...SRC_FILES.map(([name, text]) => [`src/${name}`, text] as const),
  ...(readdirSync(join(import.meta.dir, 'test-helpers'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => [`tests/test-helpers/${name}`, readFileSync(join(import.meta.dir, 'test-helpers', name), 'utf-8')] as const),
]

/** `audit` over every file of `files`, each finding prefixed with its path. */
function auditPhase1(files: ReadonlyArray<readonly [string, string]>, audit: (sf: ts.SourceFile) => string[]): string[] {
  return files.flatMap(([file, text]) => audit(parseSource(file, text)).map((f) => `${file}:${f}`))
}

/** A plain re-export of every Phase-1-only name but `without`, as one declaration. */
const reExportsWithout = (without: string): string => `export { AgentDirectorError, ${PHASE1_NAMES.filter((n) => n !== without).join(', ')} } from 'agent-director'`

describe('src/agent-director-errors.ts re-exports the three Phase-1-only classes by name from agent-director', () => {
  const [kill, unresponsive, conflict] = PHASE1_NAMES as [string, string, string]

  test('the real module re-exports each of them plainly', () => {
    expect(phase1ReExportFindings(parseSource(ERRORS_FILE, BY_NAME_TREE.find(([file]) => file === ERRORS_FILE)![1]))).toEqual([])
  })

  test.each<readonly [string, string, string]>([
    ['a re-export through a local alias of a named import', kill, `import { ${kill} as Imported } from 'agent-director'\nexport { Imported as ${kill} }`],
    ['a named import exported as a local binding', unresponsive, `import { ${unresponsive} } from 'agent-director'\nexport { ${unresponsive} }`],
    ['a local constant read through the namespace and exported', conflict, `${AD_NS}\nexport const ${conflict} = ad.${conflict}`],
    ['a local stand-in class exported under the name', kill, `export class ${kill} extends AgentDirectorError {}`],
    ['a type-only re-export', unresponsive, `export type { ${unresponsive} } from 'agent-director'`],
    ['an inline type-only re-export', conflict, `export { type ${conflict} } from 'agent-director'`],
    ['an aliased re-export under another name', kill, `export { ${kill} as KillFailed } from 'agent-director'`],
    ['another class re-exported under the name', unresponsive, `export { ErrTmuxNotAvailable as ${unresponsive} } from 'agent-director'`],
    ['a re-export from another module', conflict, `export { ${conflict} } from './phase1-stand-ins.ts'`],
    ['a re-export of the whole module', kill, "export * from 'agent-director'"],
  ])('%s leaves %s with no plain re-export', (_label, name, planted) => {
    expect(phase1ReExportFindings(parseSource(ERRORS_FILE, `${reExportsWithout(name)}\n${planted}`))).toEqual([`no plain re-export of ${name} from agent-director`])
  })

  test.each<readonly [string, string]>([
    ['the three in one declaration beside other names', `export { AgentDirectorError, ErrTmuxSendKeys, ${PHASE1_NAMES.join(', ')} } from 'agent-director'`],
    ['the three across two declarations, another name aliased beside them', `export { ${kill}, ErrTmuxNotAvailable as NotAvailable } from 'agent-director'\nexport { ${unresponsive}, ${conflict} } from 'agent-director'`],
  ])('%s: no finding', (_label, source) => {
    expect(phase1ReExportFindings(parseSource(ERRORS_FILE, source))).toEqual([])
  })
})

describe('no file in src/ or tests/test-helpers/ reads a Phase-1-only class from agent-director but by a named import or re-export', () => {
  const flagged: ReadonlyArray<readonly [string, string]> = [
    ['a namespace property read', `${AD_NS}\nconst killFailed = ad.ErrTmuxKillFailed`],
    ['a guarded read through a typed optional cast', `${AD_NS}\nconst killFailed = (ad as unknown as { readonly ErrTmuxKillFailed?: unknown }).ErrTmuxKillFailed ?? StandIn`],
    ['a namespace element read', `${AD_NS}\nconst unresponsive = ad['ErrTmuxUnresponsive']`],
    ['a computed namespace element read', `${AD_NS}\nconst key = 'ErrTmuxSessionConflict'\nconst conflict = ad[key]`],
    ['a read through a cast copy of the namespace', `${AD_NS}\nconst ns = ad as unknown as OptionalClasses\nns.ErrTmuxSessionConflict`],
    ['a read through a spread copy of the namespace', `${AD_NS}\nconst REAL = { ...ad }\nREAL.ErrTmuxKillFailed`],
    ['destructuring of the namespace', `${AD_NS}\nconst { ErrTmuxUnresponsive } = ad`],
    ['destructuring of the namespace through a cast', `${AD_NS}\nconst { ErrTmuxKillFailed } = ad as unknown as OptionalClasses`],
    ['a destructuring assignment from the namespace', `${AD_NS}\nlet ErrTmuxSessionConflict\n({ ErrTmuxSessionConflict } = ad)`],
    ['a default import read', "import ad from 'agent-director'\nad.ErrTmuxSessionConflict"],
    ['an import-equals require read', "import ad = require('agent-director')\nad.ErrTmuxKillFailed"],
    ['a read on a dynamic import', "const Conflict = (await import('agent-director')).ErrTmuxSessionConflict"],
    ['a destructured dynamic import', "const { ErrTmuxSessionConflict } = await import('agent-director')"],
    ['a destructured require', "const { ErrTmuxKillFailed: KillFailed } = require('agent-director')"],
    ['a dynamic import used through then()', "import('agent-director').then((ad) => ad.ErrTmuxKillFailed)"],
    ['the namespace passed to a resolver through a cast', `${AD_NS}\nconst classes = resolveClasses(ad as unknown as OptionalClasses)`],
    ['a dynamic import passed to a call', "const classes = resolveClasses(await import('agent-director'))"],
    ['a copy of the namespace passed to a call', `${AD_NS}\nconst REAL = { ...ad }\nconst entries = Object.entries(REAL)`],
  ]

  test.each(flagged)('flags %s', (_label, source) => {
    expect(phase1ReadFindings(parseSource('planted/read.ts', source)).length).toBeGreaterThan(0)
  })

  const allowed: ReadonlyArray<readonly [string, string]> = [
    ['the plain re-exports', `export { ${PHASE1_NAMES.join(', ')} } from 'agent-director'`],
    ['a named import', "import { ErrTmuxKillFailed, ErrTmuxSessionConflict as Conflict } from 'agent-director'"],
    ['the re-exports from src/agent-director-errors.ts', "import { ErrTmuxKillFailed } from './agent-director-errors.ts'\nif (err instanceof ErrTmuxKillFailed) retry()"],
    ['other names through the namespace', `${AD_NS}\nad.ErrTmuxNotAvailable\nconst { ErrSpawnNotFound } = ad`],
    ['a type-only import and an import type in a type', "import type { ErrTmuxUnresponsive } from 'agent-director'\nlet cls: typeof import('agent-director').ErrTmuxKillFailed | undefined"],
    ['text in strings, templates and comments', "// ad.ErrTmuxKillFailed\nconst s = \"(await import('agent-director')).ErrTmuxSessionConflict\"\nconst t = `ad.ErrTmuxUnresponsive`"],
  ]

  test.each(allowed)('allows %s', (_label, source) => {
    expect(phase1ReadFindings(parseSource('planted/read.ts', source))).toEqual([])
  })

  test('the current tree: no finding in src/ or tests/test-helpers/', () => {
    expect(PHASE1_AUDIT_TREE.map(([file]) => file)).toEqual(expect.arrayContaining([ERRORS_FILE, STUB_FILE]))
    expect(auditPhase1(PHASE1_AUDIT_TREE, phase1ReadFindings)).toEqual([])
  })
})

describe('no file in src/ or tests/test-helpers/ declares a stand-in for a Phase-1-only class', () => {
  const ERRORS_IMPORT_NAMES = "import { ERR_SPAWN_CAP_REACHED_NAME, ERR_TMUX_KILL_FAILED_NAME, ERR_TMUX_UNRESPONSIVE_NAME } from './agent-director-errors.ts'"
  const standInFindings = (source: string): string[] => phase1StandInFindings(parseSource('planted/stand-in.ts', source), TREE_BINDINGS)

  const flagged: ReadonlyArray<readonly [string, string]> = [
    ['a class declared under the name', 'export class ErrTmuxKillFailed extends AgentDirectorError {}'],
    ['a class extending the base through a namespace', "import * as ad from 'agent-director'\nexport class ErrTmuxUnresponsive extends ad.AgentDirectorError {}"],
    ['a subclass of another client class under the name', 'class ErrTmuxSessionConflict extends ErrTmuxSendKeys {}'],
    ['a class expression bound to the name', 'export const ErrTmuxSessionConflict = class extends AgentDirectorError {}'],
    ['a class expression bound to the name through a cast', 'export const ErrTmuxKillFailed = (class extends AgentDirectorError {}) as AdErrorClassConstructor'],
    ['a class expression keyed by the name', 'const STAND_INS = { ErrTmuxUnresponsive: class extends AgentDirectorError {} }'],
    ['a class expression keyed by a name constant', `${ERRORS_IMPORT_NAMES}\nconst STAND_INS = { [ERR_TMUX_KILL_FAILED_NAME]: class extends AgentDirectorError {} }`],
    ['a class whose constructor sets this.name to the name', "class Unresponsive extends AgentDirectorError {\n  constructor(v: string, e: string, d: string) { super(v, e, d); this.name = 'ErrTmuxUnresponsive' }\n}"],
    ['a class renamed by Object.defineProperty with a name constant', `${ERRORS_IMPORT_NAMES}\nconst StandIn = class extends AgentDirectorError {}\nObject.defineProperty(StandIn, 'name', { value: ERR_TMUX_KILL_FAILED_NAME })`],
    ['a stand-in factory naming its class from a parameter', [
      'function makeStandIn(name: string) {',
      '  const StandIn = class extends AgentDirectorError { constructor(v: string, e: string, d: string) { super(v, e, d); this.name = name } }',
      "  Object.defineProperty(StandIn, 'name', { value: name })",
      '  return StandIn',
      '}',
    ].join('\n')],
  ]

  test.each(flagged)('flags %s', (_label, source) => {
    expect(standInFindings(source)).toHaveLength(1)
  })

  const allowed: ReadonlyArray<readonly [string, string]> = [
    ["CSCB's own subclass under its own name", `${ERRORS_IMPORT_NAMES}\nexport class ErrSpawnCapReached extends AgentDirectorError {\n  constructor(description: string) { super('spawn', ERR_SPAWN_CAP_REACHED_NAME, description) }\n}`],
    ['a subclass that sets another literal name', "class CapReached extends AgentDirectorError {\n  constructor(d: string) { super('spawn', 'SpawnCapReached', d); this.name = 'SpawnCapReached' }\n}"],
    ["a class of the name that is no agent-director error", 'class ErrTmuxKillFailed extends Map<string, number> {}'],
    ['an instance renamed outside any class', "const restored = new Made(err.verb, err.errName, description)\nrestored.name = err.name"],
    ['the re-exported classes used by class', "import { ErrTmuxKillFailed } from './agent-director-errors.ts'\nconst err = new ErrTmuxKillFailed('kill', ERR_TMUX_KILL_FAILED_NAME, description)"],
    ['a stand-in in strings and comments', "// class ErrTmuxKillFailed extends AgentDirectorError {}\nconst s = 'class ErrTmuxUnresponsive extends AgentDirectorError {}'"],
  ]

  test.each(allowed)('allows %s', (_label, source) => {
    expect(standInFindings(source)).toEqual([])
  })

  test('the current tree: no finding in src/ or tests/test-helpers/, which declare agent-director error subclasses', () => {
    expect(PHASE1_AUDIT_TREE.map(([file]) => file)).toEqual(expect.arrayContaining([ERRORS_FILE, STUB_FILE]))
    expect(auditPhase1(PHASE1_AUDIT_TREE, (sf) => phase1StandInFindings(sf, TREE_BINDINGS))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// src/ad-phase1-types.ts declares no field
// ---------------------------------------------------------------------------

/** The module of CSCB's own Phase 1 value types. */
const PHASE1_TYPES_FILE = 'src/ad-phase1-types.ts'

/**
 * Where `sf` declares a field or holds anything but types: an interface, an
 * object type literal or a mapped type (each declares fields over or beside
 * the client's), a statement other than a type alias or a type-only import
 * from agent-director (runtime code, or a value or non-client import).
 */
function phase1TypesFindings(sf: ts.SourceFile): string[] {
  const findings: string[] = []
  for (const statement of sf.statements) {
    if (ts.isTypeAliasDeclaration(statement)) continue
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === AGENT_DIRECTOR_MODULE) continue
    findings.push(finding(sf, statement, `a statement other than a type alias or a type-only agent-director import: ${ts.SyntaxKind[statement.kind]}`))
  }
  forEachNode(sf, (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node) || ts.isMappedTypeNode(node)) {
      findings.push(finding(sf, node, `a field declaration: ${ts.SyntaxKind[node.kind]}`))
    }
  })
  return findings
}

describe('src/ad-phase1-types.ts declares no field; the client declares them all', () => {
  const findings = (source: string): string[] => phase1TypesFindings(parseSource(PHASE1_TYPES_FILE, source))

  test('the real module: no finding', () => {
    expect(findings(readFileSync(join(SRC_DIR, 'ad-phase1-types.ts'), 'utf-8'))).toEqual([])
  })

  test.each<readonly [string, string]>([
    ['a field added to a client type where the client lacks it', "import type { KillResult } from 'agent-director'\nexport type K = KillResult & Omit<{ kill_sent?: boolean }, keyof KillResult>"],
    ['a field redeclared over a client type', "import type { SpawnResult } from 'agent-director'\nexport type S = SpawnResult & { pre_trust?: 'ok' | 'skipped' | 'failed' }"],
    ['an interface extending a client type', "import type { ListResult, ListRow } from 'agent-director'\nexport interface L extends ListResult { spawns: ListRow[] }"],
    ['a mapped type over a client type', "import type { GetResult } from 'agent-director'\nexport type G = { [K in keyof GetResult]?: GetResult[K] }"],
    ['a value import of the client', "import { SpawnResult } from 'agent-director'\nexport type P = SpawnResult['pre_trust']"],
    ['runtime code', "export const PRE_TRUST_VALUES = ['ok', 'skipped', 'failed'] as const"],
  ])('flags %s', (_label, source) => {
    expect(findings(source).length).toBeGreaterThan(0)
  })

  test.each<readonly [string, string]>([
    ['a union of literal values', "export type LivenessNote = 'provenance_conflict' | 'tmux_server_changed'"],
    ["a client field's own type, read through a type-only import", "import type { SpawnResult } from 'agent-director'\nexport type PreTrust = SpawnResult['pre_trust']"],
  ])('allows %s', (_label, source) => {
    expect(findings(source)).toEqual([])
  })
})

// Keep the envelope exception bound to its typed guard and field, so a future
// native/base errName dispatch cannot silently inherit the exception.
describe('released client unknown-envelope classification audit', () => {
  test('classifyUnknownName is called only behind the ErrUnknownErrorName class guard', () => {
    const source = parseSource('src/ad-error-class.ts', readFileSync(join(SRC_DIR, 'ad-error-class.ts'), 'utf-8'))
    const calls: ts.CallExpression[] = []
    forEachNode(source, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'classifyUnknownName') calls.push(node)
    })
    expect(calls).toHaveLength(1)
    let guard: ts.Node | undefined = calls[0]?.parent
    while (guard && !ts.isIfStatement(guard)) guard = guard.parent
    expect(guard && ts.isIfStatement(guard) ? guard.expression.getText(source) : '').toBe('isAdErrorInstance(value, ErrUnknownErrorName)')
    expect(calls[0]!.arguments[0]!.getText(source)).toBe("readProp(value, 'unknownName')")
  })

  test.each(['err.errName', 'err.name', "err['errName']"])("the unknown helper exemption still finds a native/base %s dispatch", (field) => {
    const code = `function classifyUnknownName(unknownName: unknown, err: AgentDirectorError) { if (${field} === 'ErrInternal') return 'CONFIG' }`
    expect(unsanctioned(byNameFindings([['src/ad-error-class.ts', code]]))).toHaveLength(1)
  })
})

// evaluate only extracted helper declarations with inert shell stubs.
// Never source the integration harness or start a real AD/tmux/worker process.
describe('deliberate pre-0.12 integration contracts', () => {
  const scenario = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
  const helper = (name: string, source = scenario): string => {
    const match = source.match(new RegExp(`^${name}\\(\\) \\{\n[\\s\\S]*?^\\}`, 'm'))
    expect(match).not.toBeNull()
    return match![0]
  }
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cscb-old-release-contract-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })
  const shell = (code: string, tools: string[] = []): string => {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', code], {
      encoding: 'utf8', timeout: 5000,
      env: hostSafeChildEnv(home, { tools }),
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    return result.stdout.trim()
  }
  test.each(['0.10.0', '0.11.0', '0.11.9', '0.12.0'])('install-stage contract for %s selects argv, SQL and result keys together', (version) => {
    const legacy = version.startsWith('0.10.') || version.startsWith('0.11.')
    const result = shell(`${helper('_scenario_ad_contract')}
_scenario_ad_contract '${version}'
printf '%s|%s|%s|%s|%s' "$SCENARIO_AD_ROOT" "$SCENARIO_AD_ID_FLAG" "$SCENARIO_AD_ID_COLUMN" "$SCENARIO_AD_SESSION_KEY" "$SCENARIO_AD_ARGS_KEY"`)
    expect(result).toBe(legacy
      ? `${home}/.agent-director|--claude-instance-id|claude_instance_id|claude_session_id|claude_args`
      : `${home}/.config/agent-director|--instance-id|instance_id|session_id|agent_args`)
  })
  // run the actual pre-upgrade proofs against the old row
  // shape; current-field fallbacks must not hide missing or injected argv.
  test.each([
    ['old row', { claude_session_id: 'old-session', claude_args: [], labels: {} }, true],
    ['appended prompt', { claude_session_id: 'old-session', claude_args: ['--append-system-prompt-file', '/prompt'], agent_args: [], labels: {} }, false],
    ['missing old args', { claude_session_id: 'old-session', agent_args: [], labels: {} }, false],
    ['malformed old args', { claude_session_id: 'old-session', claude_args: 'unreadable', labels: {} }, false],
    ['marked old row', { claude_session_id: 'old-session', claude_args: [], labels: { tag_prompt: '1' } }, false],
    ['current session only', { session_id: 'current-session', claude_args: [], labels: {} }, false],
    ['empty old session', { claude_session_id: '', claude_args: [], labels: {} }, false],
  ] as const)('test-13 earlier-release provenance: %s', (_label, row, accepted) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-13-fmk-switch-over.sh'), 'utf8')
    const start = source.indexOf('    row_get "E4 earlier-release provenance"')
    const end = source.indexOf('    E4_MEMORY[', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    writeFileSync(join(home, 'row.json'), JSON.stringify(row))
    const output = shell(`${helper('_scenario_ad_contract')}
_scenario_ad_contract 0.10.0
AD_OUT="$HOME/row.json"
id=old-persona
declare -A E4_OLD_SESSION
row_get() { :; }
fail() { exit 1; }
(${source.slice(start, end)}
printf 'SESSION=%s\\n' "\${E4_OLD_SESSION[$id]}")
printf 'RESULT=%s' "$?"`, ['jq'])
    expect(output).toBe(accepted ? 'SESSION=old-session\nRESULT=0' : 'RESULT=1')
  })

  const worker = readFileSync(join(import.meta.dir, 'integration/fixtures/stub-claude.sh'), 'utf8')
  // inspect only extracted byte-writing declarations, never
  // execute the integration worker, source the harness, or launch AD/tmux.
  test.each(['at-once', 'transcript-on-first-message'])('%s retains literal LF until CR writes one main-user receipt and clears the box', mode => {
    const text = '<channel source="slack">\n  first line\nsecond line\n</channel>\n'
    const output = shell(`${['ensure_transcript', 'append_user_receipt', 'handle_line', 'handle_key'].map(name => helper(name, worker)).join('\n')}
MODE='${mode}'
MODE_TRANSCRIPT_ON_FIRST_MESSAGE=transcript-on-first-message
MODE_SILENT=silent
MODE_LINGER_ON_EXIT=linger-on-exit
MODE_EXIT_ON_PAUSE=exit-on-pause
SENTINEL=__CSCB_TEST_EXIT__
REPORTED=1
AWAITING_ENTER=0
composer=''
SESSION_ID=fixture-session
PROJ_DIR="$HOME/project"
TRANSCRIPT="$PROJ_DIR/$SESSION_ID.jsonl"
ensure_transcript
if [[ "$MODE" == "$MODE_TRANSCRIPT_ON_FIRST_MESSAGE" ]]; then
    [[ ! -e "$TRANSCRIPT" ]] || exit 7
else
    [[ -f "$TRANSCRIPT" ]] || exit 7
fi
draw_composer() { :; }
handle_key x
handle_key $'\\025'
handle_key x
handle_key $'\\177'
typed='${text}'
while IFS= read -r -N 1 key; do
    handle_key "$key"
done < <(printf '%s' "$typed")
[[ "$composer" == "$typed" ]] || exit 8
if [[ -f "$TRANSCRIPT" ]]; then
    [[ "$(jq -s '[.[] | select(.type == "user")] | length' "$TRANSCRIPT")" == 0 ]] || exit 8
fi
handle_key $'\\r'
[[ -z "$composer" ]] || exit 9
cat "$TRANSCRIPT"`, ['mkdir', 'jq', 'cat', 'date'])
    const records = output.split('\n').map(line => JSON.parse(line))
    expect(records).toHaveLength(2) // initial summary, exactly one submission
    expect(records[1]).toMatchObject({ type: 'user', isSidechain: false, origin: { kind: 'human' }, sessionId: 'fixture-session' })
    expect(Number.isFinite(Date.parse(records[1].timestamp))).toBe(true)
    expect(parseDeliveryTranscriptRecord('claude', records[1])).toMatchObject({ kind: 'take-in', text })
    assertNoLeak(output)
  })

  test('first-message mode ignores blank/slash commands, reconnects, and recognises a sentinel in submitted text', () => {
    const output = shell(`${helper('handle_line', worker)}
MODE=transcript-on-first-message
MODE_TRANSCRIPT_ON_FIRST_MESSAGE=transcript-on-first-message
MODE_SILENT=silent
MODE_LINGER_ON_EXIT=linger-on-exit
MODE_EXIT_ON_PAUSE=exit-on-pause
SENTINEL=__CSCB_TEST_EXIT__
REPORTED=1
AWAITING_ENTER=0
append_user_receipt() { printf 'receipt:<%s>\\n' "$1"; }
reconnect_mcp_session() { printf 'reconnect\\n'; }
fire_session_end() { printf 'end\\n'; }
handle_line '   '
handle_line '/exit'
handle_line '/mcp reconnect slack-channel-router'
handle_line $'first\\nmessage'
handle_line $'leftover\\n__CSCB_TEST_EXIT__'
exit 9`)
    expect(output).toBe('reconnect\nreceipt:<first\nmessage>\nend')
  })

  // exit-on-pause ends on pause's `/exit` as Claude Code does: SessionEnd
  // before the MCP session closes, then exit 0; at-once ignores the line and
  // linger-on-exit lingers. Before report-in, every mode ignores it.
  test.each([
    ['exit-on-pause', 'end\nclose'],
    ['at-once', 'continued'],
    ['linger-on-exit', 'linger'],
  ])('a reported-in %s stub answers the /exit line pause types', (mode, answer) => {
    const output = shell(`${helper('handle_line', worker)}
${helper('exit_on_pause', worker)}
MODE='${mode}'
MODE_TRANSCRIPT_ON_FIRST_MESSAGE=transcript-on-first-message
MODE_SILENT=silent
MODE_LINGER_ON_EXIT=linger-on-exit
MODE_EXIT_ON_PAUSE=exit-on-pause
PAUSE_EXIT_LINE=/exit
SENTINEL=__CSCB_TEST_EXIT__
AWAITING_ENTER=0
append_user_receipt() { printf 'receipt:<%s>\\n' "$1"; }
reconnect_mcp_session() { printf 'reconnect\\n'; }
fire_session_end() { printf 'end\\n'; }
close_mcp_session() { printf 'close\\n'; }
linger_after_exit() { printf 'linger\\n'; exit 0; }
REPORTED=0
handle_line '/exit'
printf 'ignored before report-in\\n'
REPORTED=1
handle_line '/exit'
printf 'continued\\n'`)
    expect(output).toBe(`ignored before report-in\n${answer}`)
  })

  test.each([
    ['0.10 hook', '.agent-director', '17', '29', '17'],
    ['0.11 hook', '.agent-director', '23', '31', '23'],
    ['0.12 hook', '.config/agent-director', '37', '41', '41'],
    ['old binary swapped into migrated hook', '.config/agent-director', '43', '47', '47'],
    ['0.10 hook with absent config', '.agent-director', null, '53', '60'],
    ['0.11 hook with absent config', '.agent-director', null, '59', '60'],
    ['0.10 hook with invalid config', '.agent-director', 'invalid', '61', '60'],
    ['0.11 hook with invalid config', '.agent-director', '0', '67', '60'],
    ['current hook with absent config', '.config/agent-director', '71', null, '60'],
    ['current hook with invalid config', '.config/agent-director', '73', '-1', '60'],
  ])('pending grace follows the %s installed path', (_label, install, oldGrace, currentGrace, expected) => {
    const configs = [['.agent-director', oldGrace], ['.config/agent-director', currentGrace]] as const
    // Create config-only fixtures after the child environment has been checked.
    const setup = configs.filter(([, grace]) => grace !== null).map(([directory, grace]) =>
      `mkdir -p "$HOME/${directory}"\nprintf '[tmux]\\npending_grace_seconds = ${grace}\\n' > "$HOME/${directory}/config.toml"`).join('\n')
    // The hook path is data only: neither directory contains an executable.
    const output = shell(`${setup}
${helper('read_grace', worker)}
DEFAULT_PENDING_GRACE_S=60
STATUS_BIN="$HOME/${install}/bin/agent-director"
GRACE_S=999
read_grace
printf '%s' "$GRACE_S"`, ['awk', 'mkdir'])
    assertNoLeak({ output, configs: configs.filter(([, grace]) => grace !== null).map(([directory]) => writtenFile(join(home, directory, 'config.toml'))) })
    expect(output).toBe(expected!)
  })
  const selfCheck = readFileSync(join(import.meta.dir, 'integration/test-0-fmk-harness-self-check.sh'), 'utf8')
  test.each([
    'complete', 'one-enter', 'no-results', 'missing-origin', 'duplicate-text', 'foreign-parent', 'changed-instance',
    'early-enter', 'pane-read', 'bypass', 'changed-launch', 'missing-result', 'premature-ok',
    'failed-final', 'wrong-row', 'wrong-caller', 'wrong-result-instance', 'wrong-event',
    'server-as-caller', 'reordered-results', 'duplicate-result', 'before-invocation', 'after-next-invocation',
    'wrong-invocation', 'allow-pending-result', 'wrong-refusal', 'missing-invocation', 'millisecond-rounding',
  ])('uncertain reconnect recovery keeps originating intent and AD evidence: %s', (mode) => {
    const text = '--instance-id cscb_control --text /mcp\\ reconnect\\ slack-channel-router --no-enter'
    const enter = '--instance-id cscb_control --key Enter'
    const rows = [
      ['1', '1.000000', '42', 'send-keys', 'cscb_control', text, '101'],
      ['2', '2.000000', '42', 'send-keys', 'cscb_control', enter, '102'],
      ['3', '3.000000', '42', 'send-keys', 'cscb_control', enter, '103'],
    ]
    const records = rows.map((row, i) => ({ event: 'ad.send_keys.called', instance_id: 'cscb_control', caller_pid: Number(row[6]),
      ts: `1970-01-01T00:00:0${i + 1}.010Z`, source: 'ad_send_keys', caller_process: 'agent-director',
      row_state: 'waiting', allow_pending: false, outcome: i === 2 ? 'ok' : 'ErrTmuxUnresponsive' }))
    if (mode === 'one-enter') { rows.splice(1, 1); records.splice(1, 1) }
    if (mode === 'no-results') { rows.splice(1, 1); records.splice(0) }
    if (mode === 'missing-origin') { rows.shift(); records.shift() }
    if (mode === 'duplicate-text') rows[1]![5] = text
    if (mode === 'foreign-parent') rows[1]![2] = '43'
    if (mode === 'changed-instance') rows[1]![4] = 'cscb_other'
    if (mode === 'early-enter') rows[1]![1] = '1.999999'
    if (mode === 'pane-read') rows.splice(1, 0, ['2', '1.500000', '42', 'read-pane', 'cscb_control', '--n-lines 1'])
    if (mode === 'bypass') rows[1]![5] += ' --allow-pending'
    if (mode === 'changed-launch') rows.splice(1, 0, ['2', '1.500000', '42', 'resume', 'cscb_control', '--instance-id cscb_control'])
    if (mode === 'missing-result') records.pop()
    if (mode === 'premature-ok') records[0]!.outcome = 'ok'
    if (mode === 'failed-final') records[2]!.outcome = 'ErrTmuxUnresponsive'
    if (mode === 'wrong-row') records[1]!.row_state = 'working'
    if (mode === 'wrong-caller') records[1]!.caller_pid = 43
    if (mode === 'wrong-result-instance') records[1]!.instance_id = 'cscb_other'
    if (mode === 'wrong-event') records[1]!.event = 'ad.pause.called'
    if (mode === 'server-as-caller') records[1]!.caller_pid = 42
    if (mode === 'reordered-results') records.reverse()
    if (mode === 'duplicate-result') records.splice(1, 0, { ...records[1]! })
    if (mode === 'before-invocation') records[1]!.ts = '1970-01-01T00:00:01.999Z'
    if (mode === 'after-next-invocation') records[1]!.ts = '1970-01-01T00:00:03.001Z'
    if (mode === 'wrong-invocation') records[1]!.caller_pid = 103
    if (mode === 'allow-pending-result') records[1]!.allow_pending = true
    if (mode === 'wrong-refusal') records[1]!.outcome = 'ErrDialogMaybeOpen'
    if (mode === 'missing-invocation') rows[1]!.pop()
    // AD truncates its event clock to milliseconds; the shim records microseconds.
    if (mode === 'millisecond-rounding') { rows[1]![1] = '2.000999'; records[1]!.ts = '1970-01-01T00:00:02.000Z' }
    writeFileSync(join(home, 'rows'), rows.map(row => row.join('\t')).join('\n'))
    writeFileSync(join(home, 'outcomes'), records.map(record => JSON.stringify(record)).join('\n'))
    const output = shell(`${['_scenario_eval_words', '_scenario_to_us', '_scenario_reconnect_outcomes', '_scenario_assert_reconnect_rows'].map(name => helper(name)).join('\n')}
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
(_scenario_assert_reconnect_rows fixture 42 1000 "$(cat "$HOME/rows")" "$(cat "$HOME/outcomes")")
printf 'RESULT=%s' "$?"`, ['cat', 'jq'])
    expect(output).toContain(['complete', 'one-enter', 'millisecond-rounding'].includes(mode) ? 'RESULT=0' : 'RESULT=1')
  })
  test.each([
    'complete', 'changed-launch-during-refusal', 'foreign-parent-during-refusal',
    'guard-bypass-during-refusal', 'missing-origin', 'missing-success', 'success-before-mark',
  ])('test-18 actual selector keeps post-mark refusals through the successful Enter: %s', mode => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-18-fmk-wedged.sh'), 'utf8')
    // Extract the selector the scenario actually calls, not a second copy of
    // its awk/jq. A refused Enter after mark=2 precedes the successful one.
    expect(source).toContain('t18_reconnect_window "${step}: ${p}" "${SERVER_PID}" "${unwedge_mark}" "${calls}" "${outcomes}"')
    expect(source).toContain('"${T18_RECONNECT_CALLS}" "${T18_RECONNECT_OUTCOMES}"')
    const text = '--instance-id cscb_control --text /mcp\\ reconnect\\ slack-channel-router --no-enter'
    const enter = '--instance-id cscb_control --key Enter'
    const rows = [
      ['1', '1.000000', '42', 'send-keys', 'cscb_control', text, '101'],
      ['2', '2.000000', '42', 'send-keys', 'cscb_control', enter, '102'],
      ['3', '2.500000', '42', 'get', 'cscb_control', '--instance-id cscb_control', '103'],
      ['4', '3.000000', '42', 'send-keys', 'cscb_control', enter, '104'],
      ['5', '3.500000', '42', 'get', 'cscb_control', '--instance-id cscb_control', '105'],
      ['6', '4.000000', '42', 'send-keys', 'cscb_control', enter, '106'],
      // Later activity must not leak into either selected stream.
      ['7', '4.500000', '42', 'read-pane', 'cscb_control', '--n-lines 1', '107'],
      ['8', '5.000000', '42', 'send-keys', 'cscb_control', text, '108'],
    ]
    const records = [1, 2, 3, 4, 5].map((second, i) => ({ event: 'ad.send_keys.called',
      ts: `1970-01-01T00:00:0${second}.010Z`, instance_id: 'cscb_control', caller_pid: [101, 102, 104, 106, 108][i],
      row_state: 'waiting', allow_pending: false, outcome: i >= 3 ? 'ok' : 'ErrTmuxUnresponsive' }))
    if (mode === 'changed-launch-during-refusal') rows[4]![3] = 'resume'
    if (mode === 'foreign-parent-during-refusal') rows[3]![2] = '43'
    if (mode === 'guard-bypass-during-refusal') rows[3]![5] += ' --allow-pending'
    if (mode === 'missing-origin') rows.shift()
    if (mode === 'missing-success') records.splice(3)
    writeFileSync(join(home, 'rows'), rows.map(row => row.join('\t')).join('\n'))
    writeFileSync(join(home, 'outcomes'), records.map(record => JSON.stringify(record)).join('\n'))
    const output = shell(`${helper('t18_reconnect_window', source)}
${['_scenario_eval_words', '_scenario_to_us', '_scenario_reconnect_outcomes', '_scenario_assert_reconnect_rows'].map(name => helper(name)).join('\n')}
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
(
t18_reconnect_window fixture 42 ${mode === 'success-before-mark' ? 6 : 2} "$(cat "$HOME/rows")" "$(cat "$HOME/outcomes")"
_scenario_assert_reconnect_rows fixture 42 1000 "$T18_RECONNECT_CALLS" "$T18_RECONNECT_OUTCOMES"
printf 'KEYS=%s OUTCOMES=%s LAST=%s\\n' \
    "$(awk -F '\\t' '$4 == "send-keys" { n++ } END { print n }' <<< "$T18_RECONNECT_CALLS")" \
    "$(jq -s length <<< "$T18_RECONNECT_OUTCOMES")" \
    "$(awk -F '\\t' 'END { print $1 }' <<< "$T18_RECONNECT_CALLS")"
)
printf 'RESULT=%s' "$?"`, ['cat', 'jq', 'awk'])
    expect(output).toContain(mode === 'complete' ? 'KEYS=4 OUTCOMES=4 LAST=6\nRESULT=0' : 'RESULT=1')
  })
  test.each([
    'complete', 'unrelated-child-noise', 'wrong-parent', 'other-instance', 'unrelated-child',
    'wrong-operation', 'reordered-results', 'wrong-outcome', 'missing-result', 'old-caller-filter',
  ])('test-18 polls and verifies exact CLI invocations from shim/trail records: %s', mode => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-18-fmk-wedged.sh'), 'utf8')
    const text = '--instance-id cscb_control --text /mcp\\ reconnect\\ slack-channel-router --no-enter'
    const enter = '--instance-id cscb_control --key Enter'
    // Real shim columns: kind, epoch, CLI PID, parent PID, parent argv, CLI argv.
    // The shared client's get overlaps the persona client's refused key, so
    // unrelated reads cannot be used as an upper time bound for key results.
    const log = [
      ['call', '1.000005', '101', '42', 'bun server.ts', `--store-path /fixture/state send-keys ${text}`],
      ['call', '2.000005', '102', '42', 'bun server.ts', `--store-path /fixture/state send-keys ${enter}`],
      ['call', '2.500005', '109', '42', 'bun server.ts', 'get --instance-id cscb_control'],
      ['call', '3.000005', '103', mode === 'wrong-parent' ? '43' : '42', 'bun server.ts', `send-keys ${enter}`],
    ]
    const records = [101, 102, 103].map((pid, i) => ({
      event: 'ad.send_keys.called', instance_id: 'cscb_control', caller_pid: pid,
      caller_process: 'agent-director', source: 'ad_send_keys',
      ts: `1970-01-01T00:00:0${i + 1}.${i === 1 ? '800' : '010'}Z`,
      row_state: 'waiting', allow_pending: false, guard_evaluation: 'not-applicable',
      outcome: i === 2 ? 'ok' : 'ErrTmuxUnresponsive',
    }))
    if (mode === 'other-instance') records[2]!.instance_id = 'cscb_other'
    if (mode === 'unrelated-child') records[2]!.caller_pid = 109
    if (mode === 'wrong-operation') log[3]![5] = 'get --instance-id cscb_control'
    if (mode === 'reordered-results') records.reverse()
    if (mode === 'wrong-outcome') records[1]!.outcome = 'ErrDialogMaybeOpen'
    if (mode === 'missing-result') records.splice(1, 1)
    if (mode === 'unrelated-child-noise') records.splice(1, 0, { ...records[2]!, caller_pid: 109, ts: '1970-01-01T00:00:02.600Z' })
    writeFileSync(join(home, 'shim.log'), log.map(row => row.join('\t')).join('\n'))
    writeFileSync(join(home, 'ad-trail.jsonl'), records.map(record => JSON.stringify(record)).join('\n'))
    writeFileSync(join(home, 'processes'), 'proc\tserver\t42\t1\t0.000000\tbun server.ts\n')
    const correlate = helper('_scenario_reconnect_outcomes')
    const oldFilter = correlate.replace('.value.caller_pid == ($call[6] | tonumber)', '.value.caller_pid == ($server | tonumber)')
    expect(oldFilter).not.toBe(correlate)
    const declarations = [
      '_scenario_record_load', '_scenario_role_at', '_scenario_query_prep', '_scenario_shim_diagnostic', '_scenario_read_log',
      '_scenario_to_us', '_scenario_us_text', '_scenario_split_line', '_scenario_eval_words',
      '_scenario_decode_words', '_scenario_ad_verb', '_scenario_ad_id', '_scenario_in_window',
      '_scenario_check_mark', '_scenario_cscb_ad_rows', 'ad_cscb_calls', 'ad_trail_events',
      '_scenario_assert_reconnect_rows',
    ].map(name => helper(name)).join('\n')
    const output = shell(`${declarations}
${mode === 'old-caller-filter' ? oldFilter : correlate}
${helper('t18_reconnect_submitted', source)}
${helper('t18_reconnect_window', source)}
require_ci_image() { :; }
require_scenario_home() { :; }
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
SCENARIO_FMK=1
SCENARIO_CSCB_RECORD="$HOME/processes"
_SCENARIO_REAL_CSCB_RECORD="$HOME/unused"
SCENARIO_AD_SHIM_LOG="$HOME/shim.log"
SCENARIO_AD_ROOT="$HOME"
SERVER_PID=42
(
t18_reconnect_submitted cscb_control 2.9 || exit 1
calls="$(ad_cscb_calls cscb_control - - with-pid)"
# All default consumers keep the original six-column record contract.
[[ "$(ad_cscb_calls cscb_control | awk -F '\\t' 'NF != 6 { bad++ } END { print bad+0 }')" == 0 ]] || exit 2
t18_reconnect_window fixture 42 2 "$calls" "$(ad_trail_events ad.send_keys.called cscb_control)"
_scenario_assert_reconnect_rows fixture 42 1000 "$T18_RECONNECT_CALLS" "$T18_RECONNECT_OUTCOMES"
printf 'PIDS=%s\\n' "$(jq -sr 'map(.caller_pid | tostring) | join(",")' <<< "$T18_RECONNECT_OUTCOMES")"
)
printf 'RESULT=%s' "$?"`, ['jq', 'awk'])
    expect(output).toContain(['complete', 'unrelated-child-noise'].includes(mode) ? 'PIDS=101,102,103\nRESULT=0' : 'RESULT=1')
  })

  test.each(['complete', 'missing-session', 'missing-pane', 'tmux-failure', 'undefined-helper'])('test-18 executes its fixture identity reader: %s', mode => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-18-fmk-wedged.sh'), 'utf8')
    writeFileSync(join(home, 'row.json'), JSON.stringify({ session_id: 'conversation', tmux_session_name: mode === 'missing-session' ? null : 'fixture', tmux_socket: '/fixture/socket', jsonl_path: '/fixture/transcript' }))
    const reader = helper('t18_reconnect_identity', source)
    const output = shell(`${['_scenario_tmux_check', '_scenario_tmux', '_scenario_session_target'].map(name => helper(name)).join('\n')}
${helper('t18_row_get', source)}
${mode === 'undefined-helper' ? reader.replace('_scenario_tmux display-message', 'tmux_session_value display-message') : reader}
SCENARIO_ROOT="$HOME"
SCENARIO_FMK=1
TMUX_TMPDIR="$HOME/tmux"
SCENARIO_REAL_TMUX=fixture_tmux
AD_OUT="$HOME/row.json"
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
ad_capture() { [[ "$*" == 'get --instance-id cscb_fixture' ]] || exit 9; AD_RC=0; }
fixture_tmux() {
    [[ "$*" == 'display-message -p -t =fixture: #{session_id} #{pane_id} #{pane_pid}' ]] || exit 9
    ${mode === 'tmux-failure' ? 'return 1' : `printf '%s\\n' '${mode === 'missing-pane' ? '$4 %3' : '$4 %3 123'}'`}
}
(t18_reconnect_identity cscb_fixture fixture) 2>&1
printf 'RESULT=%s' "$?"`, ['jq'])
    expect(output).toContain(mode === 'complete' ? '["conversation","fixture","/fixture/socket","/fixture/transcript","$4 %3 123"]\nRESULT=0' : 'RESULT=1')
    if (mode === 'undefined-helper') expect(output).toContain('command not found')
  })

  test.each([
    'sweep-missing', 'hook-ended', 'null-note-after-missing', 'out-of-order-events',
    'wrong-id', 'before-previous-launch', 'after-next-launch', 'at-previous-launch', 'at-next-launch',
    'note-only', 'still-pending', 'live-after-missing', 'no-cscb-read', 'status-read', 'missing-sweep-reader',
  ])('test-26 requires terminal AD evidence and a CSCB read between launches: %s', mode => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-26-fmk-timing-settings.sh'), 'utf8')
    expect(helper('leg_call_timeout_low', source)).toContain('expect_finished_before_launch "${step}: ${CALL_VERB} at +$(seconds_between "${T_CALL}" "${t}")s" "${ID[${x}]}" "${prev}" "${t}"')
    const tick = { event: 'ad.find_missing.tick', instance_id: 'cscb_fixture', ts: '1970-01-01T00:00:15.123456789Z', prior_state: 'pending', new_state: 'missing' as string | null }
    const events = [tick]
    if (mode === 'hook-ended') { tick.event = 'ad.spawn.state_transition'; tick.new_state = 'ended' }
    if (mode === 'wrong-id') tick.instance_id = 'cscb_other'
    if (mode === 'before-previous-launch') tick.ts = '1970-01-01T00:00:09Z'
    if (mode === 'after-next-launch') tick.ts = '1970-01-01T00:00:21Z'
    if (mode === 'at-previous-launch') tick.ts = '1970-01-01T00:00:10Z'
    if (mode === 'at-next-launch') tick.ts = '1970-01-01T00:00:20Z'
    if (mode === 'note-only') tick.new_state = null
    if (mode === 'still-pending') tick.new_state = 'pending'
    if (mode === 'null-note-after-missing') events.push({ ...tick, ts: '1970-01-01T00:00:16Z', new_state: null })
    // Concatenating the two event streams without chronological sorting
    // would incorrectly let this older sweep hide the later live hook.
    if (mode === 'live-after-missing') events.push({ ...tick, event: 'ad.spawn.state_transition', ts: '1970-01-01T00:00:16Z', new_state: 'waiting' })
    if (mode === 'out-of-order-events') events.unshift({ ...tick, event: 'ad.spawn.state_transition', ts: '1970-01-01T00:00:14Z', new_state: 'pending' })
    writeFileSync(join(home, 'ad-trail.jsonl'), events.map(event => JSON.stringify(event)).join('\n'))
    const reader = helper('expect_finished_before_launch', source)
    const output = shell(`${helper('ad_trail_events')}
${mode === 'missing-sweep-reader' ? reader.replace(/^.*transitions\+=.*ad\.find_missing\.tick.*\n/m, '') : reader}
SCENARIO_AD_ROOT="$HOME"
require_ci_image() { :; }
require_scenario_home() { :; }
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
cscb_calls_between() {
    [[ "$1 $2 $4 $5" == '10 20 --instance-id cscb_fixture' ]] || exit 9
    [[ "$3" == ${mode === 'status-read' ? 'status' : 'get'} ]] && echo ${mode === 'no-cscb-read' ? '0' : '1'} || echo 0
}
(expect_finished_before_launch fixture cscb_fixture 10 20)
printf 'RESULT=%s' "$?"`, ['jq'])
    const accepted = ['sweep-missing', 'hook-ended', 'null-note-after-missing', 'out-of-order-events', 'status-read'].includes(mode)
    expect(output).toContain(accepted ? 'RESULT=0' : 'RESULT=1')
    if (mode === 'no-cscb-read') expect(output).toContain('no CSCB read')
  })

  test.each(['matching-session', 'wrong-session', 'wrong-id', 'unapplied-hook', 'automatic-keys'])('test-26 recovery requires the applied SessionStart of its recovered session: %s', mode => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-26-fmk-timing-settings.sh'), 'utf8')
    writeFileSync(join(home, 'row.json'), JSON.stringify({ state: 'waiting', session_id: 'recovered-session' }))
    writeFileSync(join(home, 'ad-trail.jsonl'), JSON.stringify({ event: 'ad.hook.fired', instance_id: mode === 'wrong-id' ? 'cscb_other' : 'cscb_fixture', event_name: 'SessionStart', session_id: mode === 'wrong-session' ? 'earlier-session' : 'recovered-session', upsert_outcome: mode === 'unapplied-hook' ? 'no_change' : 'updated' }))
    const output = shell(`${helper('ad_trail_events')}
${helper('hooks_brought_up', source)}
SCENARIO_AD_ROOT="$HOME"
SCENARIO_TAG=fixture
REPORT_WAIT_S=1
AD_OUT="$HOME/row.json"
declare -A ID=([t1]=cscb_fixture)
require_ci_image() { :; }
require_scenario_home() { :; }
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
wait_until() { [[ "$3 $4 $5" == 'row_state_is cscb_fixture waiting' ]] || exit 9; }
ad_capture() { [[ "$*" == 'get --instance-id cscb_fixture' ]] || exit 9; AD_RC=0; }
now_s() { echo 20; }
cscb_calls_between() { [[ "$*" == '10 20 send-keys --instance-id cscb_fixture' ]] || exit 9; echo ${mode === 'automatic-keys' ? 1 : 0}; }
(hooks_brought_up fixture t1 10)
printf 'RESULT=%s' "$?"`, ['jq'])
    expect(output).toContain(mode === 'matching-session' ? 'RESULT=0' : 'RESULT=1')
  })
  const shimHelpers = ['_scenario_ad_contract', '_scenario_is_shim', '_scenario_check_shim_at', 'check_ad_shim'].map((name) => helper(name)).join('\n')
  const fixturePrelude = `${shimHelpers}
${helper('expect_fails_in_home', selfCheck)}
require_ci_image() { :; }
require_scenario_home() { :; }
fail() { printf 'FAIL: %s: %s\\n' "$TEST_NAME" "$*" >&2; exit 1; }
TEST_NAME=test-fixture
SCENARIO_ROOT="$HOME"
SCENARIO_AD_SHIM_MARKER='# inert fixture shim'
SCENARIO_AD_SHIM_SRC="$HOME/shim-source"
SCENARIO_RELEASE_BIN="$HOME/inert-binary"
printf '%s\\n' "$SCENARIO_AD_SHIM_MARKER" 'exit 97' > "$SCENARIO_AD_SHIM_SRC"
printf '%s\\n' 'exit 98' > "$SCENARIO_RELEASE_BIN"`
  test('shim self-check checks and rejects corruption in its alternate HOME', () => {
    const output = shell(`${fixturePrelude}
${helper('leg_shim_check', selfCheck)}
${helper('_scenario_check_shim_at').replace('_scenario_check_shim_at()', 'check_fixture_shim()')}
_scenario_check_shim_at() { printf '%s\\n' "$1"; check_fixture_shim "$@"; }
_scenario_ad_contract release
mkdir -p "$SCENARIO_AD_ROOT/bin"
cp "$SCENARIO_AD_SHIM_SRC" "$SCENARIO_AD_BIN"
cp "$SCENARIO_RELEASE_BIN" "$SCENARIO_AD_BIN.real"
chmod 0755 "$SCENARIO_AD_BIN" "$SCENARIO_AD_BIN.real"
leg_shim_check
printf '%s' "$SCENARIO_AD_ROOT"`, ['grep', 'sed', 'mkdir', 'cp', 'chmod', 'rm', 'ln'])
    expect(output).toBe(`${home}/home-shim-check/.config/agent-director/bin/agent-director\n${home}/.config/agent-director`)
  })
  test.each(['0.10.0', '0.11.0', '0.12.0'])('negative HOME fixture keeps the %s stage and leaves the parent contract intact', (version) => {
    const output = shell(`${fixturePrelude}
_scenario_ad_contract '${version}'
original_root="$SCENARIO_AD_ROOT"
original_flag="$SCENARIO_AD_ID_FLAG"
original_bin="$SCENARIO_AD_BIN"
original_log="$SCENARIO_AD_SHIM_LOG"
_SCENARIO_REAL_AD_SHIM_LOG="$original_log"
mkdir -p "$SCENARIO_AD_ROOT/bin"
cp "$SCENARIO_AD_SHIM_SRC" "$SCENARIO_AD_BIN"
cp "$SCENARIO_RELEASE_BIN" "$SCENARIO_AD_BIN.real"
chmod 0755 "$SCENARIO_AD_BIN" "$SCENARIO_AD_BIN.real"
fixture_home="$HOME/alternate"
fixture_root="$fixture_home/\${SCENARIO_AD_ROOT#"$HOME/"}"
mkdir -p "$fixture_root/bin"
cp "$SCENARIO_RELEASE_BIN" "$fixture_root/bin/agent-director.real"
chmod 0755 "$fixture_root/bin/agent-director.real"
ln -s "$SCENARIO_AD_SHIM_SRC" "$fixture_root/bin/agent-director"
expect_fails_in_home symlink "$fixture_home" 'is a symlink, not the shim' check_ad_shim
grep -qF "$fixture_root/bin/agent-director is a symlink" "$SCENARIO_ROOT/expect-fails.out" || exit 2
rm "$fixture_root/bin/agent-director"
cp "$SCENARIO_RELEASE_BIN" "$fixture_root/bin/agent-director"
chmod 0755 "$fixture_root/bin/agent-director"
expect_fails_in_home marker "$fixture_home" "does not carry the shim's marker" check_ad_shim
grep -qF "$fixture_root/bin/agent-director does not carry" "$SCENARIO_ROOT/expect-fails.out" || exit 3
[[ "$SCENARIO_AD_ROOT" == "$original_root" && "$SCENARIO_AD_ID_FLAG" == "$original_flag" ]] || exit 4
[[ "$SCENARIO_AD_BIN" == "$original_bin" && "$SCENARIO_AD_SHIM_LOG" == "$original_log" && "$_SCENARIO_REAL_AD_SHIM_LOG" == "$original_log" ]] || exit 5
printf '%s' "$SCENARIO_AD_ROOT"`, ['grep', 'sed', 'mkdir', 'cp', 'chmod', 'rm', 'ln'])
    expect(output).toBe(`${home}/${version === '0.12.0' ? '.config/agent-director' : '.agent-director'}`)
  })
  test('old seeder reaches capture with the guarded legacy argv and no agent flag', () => {
    const output = shell(`${helper('seed_010_row')}

require_ci_image() { :; }
require_scenario_home() { :; }
_scenario_tmux_check() { :; }
_scenario_require_010() { printf 'guard\n'; }
_scenario_check_instance_id() { :; }
_scenario_tmux() { return 1; }
_scenario_stub_mode_of() { printf 'silent'; }
ad_capture() { printf '<%s>' "$@"; exit 0; }
STUB_MODE_AT_ONCE=at-once
seed_010_row test-old old-session "$HOME" service=cscb`)
    expect(output).toBe(`guard\n<spawn><--cwd><${home}><--claude-instance-id><test-old><--tmux-session-name><old-session><--label><service=cscb>`)
    expect(output).not.toContain('<--agent>')
  })
  test.each(['0.10.0', '0.11.0', '0.12.0'])('row query for %s uses the installed schema column', (version) => {
    const output = shell(`${helper('_scenario_ad_contract')}
${helper('_scenario_row_json')}
_scenario_store_read() { printf '%s' "$2"; }
_scenario_ad_contract '${version}'
_scenario_row_json row test-id`)
    expect(output).toBe(`SELECT * FROM spawns WHERE ${version === '0.12.0' ? 'instance_id' : 'claude_instance_id'} = 'test-id'`)
  })
  test.each([
    ['--claude-instance-id test-id'], ['--claude-instance-id=test-id'],
    ['--instance-id test-id'], ['--instance-id=test-id'],
  ])('mixed upgrade call logs decode %s exactly', (args) => {
    const result = shell(`${helper('_scenario_ad_id')}\n_L_ARGS=(${args})\n_scenario_ad_id\nprintf '%s' "$_L_ID"`)
    expect(result).toBe('test-id')
  })
  test.each(['test0', 'test14'].flatMap((script) => ['pass', 'live-row', 'live-worker', 'live-session', 'metadata-loss', 'state-loss', 'cwd-loss'].map((mode) => [script, mode])))('%s seed migration %s: quiesce before install and preserve terminal rows with no host executables', (script, mode) => {
    const upgradeCheck = readFileSync(join(import.meta.dir, 'integration/test-14-fmk-kill-fails.sh'), 'utf8')
    const count = script === 'test14' ? 4 : 3
    const code = `${helper('_scenario_ad_contract')}
${(script === 'test14' ? ['t14_upgrade_row_quiescent', 't14_upgrade_seeded_rows'] : ['nested_seed_row_quiescent', 'nested_quiesce_seed_row', 'nested_migrate_seed_rows', 'nested_expect_row']).map((name) => helper(name, script === 'test14' ? upgradeCheck : selfCheck)).join('\n')}
SCENARIO_REAL_TMUX=fixture_tmux
SCENARIO_WORKER_END_S=2
SCENARIO_RELEASE_BIN=inert
SCENARIO_ROOT="$HOME"
AD_OUT="$HOME/row.json"
AD_ERR="$HOME/err"
MODE='${mode}'
UA_ID=t0-010-row
UB_ID=cscb_ops_team_C0T0AAA01
P_ID=cscb_C0T0BBB02
Q_ID=cscb_q
phase=old
polls=0
kills=0
_scenario_ad_contract 0.10.0
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
pid_alive() { [[ "$MODE" == live-worker ]]; }
fixture_tmux() { if [[ "$1" == display-message ]]; then printf 101; return 0; fi; [[ "$MODE" == live-session ]]; }
wait_until() {
    local bound="$1"; shift 2
    [[ "$bound" == 2 ]] || exit 9
    for attempt in 1 2 3; do
        polls=$((polls + 1))
        "$@" && return 0
    done
    fail bounded-quiescence
}
ad_capture() {
    AD_RC=0
    printf '%s %s %s\\n' "$phase" "$1" "\${2:-}" >> "$HOME/calls"
    case "$1" in
      kill) [[ "$2" == "$SCENARIO_AD_ID_FLAG" ]] || exit 10; kills=$((kills + 1));;
      find-missing) :;;
      get)
        local id="$3" session labels state=ended cwd="/fixture/$3"
        case "$id" in
          t0-010-row) session=t0_010_row; labels='{"team":"t0"}';;
          cscb_ops_team_C0T0AAA01) session=slack_bot_ops_team_C0T0AAA01; labels='{"service":"cscb","channel":"C0T0AAA01"}';;
          cscb_C0T0BBB02) session=slack_bot_C0T0BBB02; labels='{"service":"cscb","channel":"C0T0BBB02"}'; state=missing;;
          cscb_q) session=slack_bot_q; labels='{}';;
        esac
        [[ "$MODE" != live-row ]] || state=waiting
        if [[ "$phase" == release ]]; then
          [[ "$MODE" != metadata-loss ]] || labels='{}'
          [[ "$MODE" != state-loss ]] || state=waiting
          [[ "$MODE" != cwd-loss ]] || cwd=/corrupted
        fi
        printf '{"%s":"%s","tmux_session_name":"%s","labels":%s,"state":"%s","cwd":"%s"}\\n' "$SCENARIO_AD_ID_COLUMN" "$id" "$session" "$labels" "$state" "$cwd" > "$AD_OUT";;
      *) exit 11;;
    esac
}
install_ad_release() {
    [[ "$kills" == ${count} && "$polls" == ${count} ]] || exit 12
    printf 'INSTALL\\n'
    phase=release
    _scenario_ad_contract release
}
check_ad_shim() { :; }
expect_shim_in_place() { :; }
ad_store_id() { printf 0123456789abcdef; }
(${script === 'test14' ? 't14_upgrade_seeded_rows' : 'nested_migrate_seed_rows 101 102 103'})
printf 'RESULT=%s\\n' "$?"
while IFS= read -r line; do printf '%s\\n' "$line"; done < "$HOME/calls"`
    const output = shell(code, ['jq', 'head', 'tr', 'cmp'])
    assertNoLeak({ output })
    if (mode === 'pass') {
      expect(output).toContain('INSTALL')
      if (script === 'test0') expect(output).toContain('CHECK: seeded rows quiescent before install\nINSTALL\nCHECK: rows survive the release\'s install')
      expect(output).toContain('RESULT=0')
      expect(output.match(/old kill /g)).toHaveLength(count)
      expect(output.match(/old get /g)).toHaveLength(script === 'test14' ? 8 : 3)
      expect(output.match(/release get /g)).toHaveLength(count)
      expect(output).toContain('old kill --claude-instance-id')
      expect(output).toContain('release get --instance-id')
    } else {
      expect(output).toContain('RESULT=1')
      if (mode.startsWith('live-')) {
        expect(output).toContain('REFUSED: bounded-quiescence')
        expect(output).not.toContain('INSTALL')
        expect(output.match(/old find-missing /g)).toHaveLength(3)
      } else {
        expect(output).toContain('INSTALL')
        expect(output).not.toContain("CHECK: rows survive the release's install")
      }
    }
    expect(output).not.toMatch(/--agent|expire|delete/)
  })
  test.each(['reports', 'never-reports'])('reinstall %s: await an AD report before kill', (mode) => {
    const output = shell(`${helper('leg_reinstall', selfCheck)}
${helper('nested_seed_row_quiescent', selfCheck)}
${helper('nested_quiesce_seed_row', selfCheck)}
${helper('nested_seed_row_reported', selfCheck)}
SCENARIO_AD_ID_FLAG=--instance-id
SCENARIO_REAL_TMUX=fixture_tmux
SCENARIO_WORKER_END_S=10
SCENARIO_SEED_REPORT_S=90
T0_ROW_ID=t0-self-check
T0_SESSION=t0-self-check
AD_OUT="$HOME/row.json"
AD_ERR="$HOME/err"
state=pending
polls=0
killed=0
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
fixture_tmux() { [[ "$1" != display-message ]] || { printf 101; return 0; }; (( killed == 0 )); }
pid_alive() { (( killed == 0 )); }
ad_capture() {
  AD_RC=0
  case "$1" in
    get) printf '{"state":"%s","cwd":"/fixture"}' "$state" > "$AD_OUT";;
    kill) printf 'KILL:%s\\n' "$state"; killed=1;;
    find-missing) [[ "$state" != waiting ]] || state=missing;;
    *) exit 9;;
  esac
}
wait_until() {
  local bound="$1"; shift 2
  for attempt in 1 2 3; do
    polls=$((polls + 1))
    if [[ '${mode}' == reports && "$polls" == 2 ]]; then state=waiting; fi
    "$@" && return 0
  done
  fail "bounded wait $bound"
}
install_ad_release() { [[ "$state" == missing && "$killed" == 1 ]] || exit 10; printf 'INSTALL\\n'; exit 0; }
(leg_reinstall)
printf 'RESULT=%s' "$?"`, ['jq', 'head'])
    if (mode === 'reports') {
      expect(output).toBe('KILL:waiting\nINSTALL\nRESULT=0')
    } else {
      expect(output).toContain('REFUSED: bounded wait 90')
      expect(output).toContain('RESULT=1')
      expect(output).not.toContain('KILL:')
      expect(output).not.toContain('INSTALL')
    }
  })
  test('test-14 harness seeds report in without an approver and P becomes silent only after upgrade', () => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-14-fmk-kill-fails.sh'), 'utf8')
    const seed = source.slice(source.indexOf('U_CONFIG='), source.indexOf('\n# No worker may cross'))
    const output = shell(`
SCENARIO_TAG=inert
SCENARIO_ROOT="$HOME"
SVC_LABEL=service=cscb
PERSONA_LABEL=persona
STUB_MODE_SILENT=silent
STUB_MODE_AT_ONCE=at-once
declare -A modes
persona_key() { printf '%s' "$1"; }
t14_value() { printf -v "$1" p; }
make_workdir() { printf '/fixture/%s' "$1"; }
stub_mode() { modes[$1]="$2"; }
seed_prepersona_fleet() {
  [[ "\${modes[$UA_WORK]}" == at-once && "\${modes[$UB_WORK]}" == at-once ]] || exit 7
  printf '%s a a-session a-sid a-pane\\n%s b b-session b-sid b-pane\\n' "$UA_CHANNEL" "$UB_CHANNEL"
}
seed_010_row() { [[ "\${modes[$3]}" == at-once ]] || exit 7; }
fail() { exit 1; }
(set -e
${seed}
[[ "\${modes[$P_WORK]}" == at-once ]])
printf 'RESULT=%s' "$?"`, ['jq', 'grep'])
    expect(output).toBe('RESULT=0')
    const upgrade = source.indexOf('\nt14_upgrade_seeded_rows\n')
    const rebuild = source.indexOf('for fixture in A B P Q; do', upgrade)
    const silent = source.indexOf('stub_mode "${P_ROW_WORK}" "${STUB_MODE_SILENT}"', upgrade)
    expect(silent).toBeGreaterThan(upgrade)
    expect(silent).toBeLessThan(rebuild)
  })
  test('released malformed-config printer decodes the native error and preserves CONFIG onset', async () => {
    const source = readFileSync(join(import.meta.dir, 'integration/fixtures/fmk-texts.ts'), 'utf8')
    const start = source.indexOf('const CONFIG_MALFORMED_ERR_NAME')
    const end = source.indexOf('/** `adConfigMalformedOnset', start)
    const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const decode = new Function('fail', 'PRINTER_FAIL_EXIT', `${compiled}\nreturn configMalformedError;`)(
      (_code: number, reason: string) => { throw new Error(reason) }, 1,
    )
    const err = await decode('adConfigMalformedOnset', 'invalid timer', { importAgentDirectorClient: async () => agentDirectorClient })
    expect(err).toBeInstanceOf(agentDirectorClient.ErrConfigMalformed)
    expect(classifyAdError(err)).toEqual({ errorClass: AD_ERROR_CLASS_CONFIG, reportedName: 'ErrConfigMalformed', message: 'invalid timer' })
    expect(adConfigMalformedOnset(err)).toContain('invalid timer')
    await expect(decode('adConfigMalformedOnset', 'bad', { importAgentDirectorClient: async () => ({}) })).rejects.toThrow('native malformed-config')
  })
  test.each([
    ['J', 't19_leg_removed_readded', 'the re-add'],
    ['K', 't19_leg_credentials_changed', 'the change'],
  ] as const)('test-19 %s reviews a fresh channel choice at the identity reset', (prefix, legName, step) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-19-fmk-reuse.sh'), 'utf8')
    const leg = helper(legName, source)
    // The config function contains a JSON heredoc with its own closing brace.
    const configBuilder = source.match(/^t19_config\(\) \{\n[\s\S]*?^EOF\n\}/m)
    expect(configBuilder).not.toBeNull()
    const apply = leg.indexOf(`    t19_apply_config "\${step}: ${step}"`)
    const editStart = leg.lastIndexOf('    t19_mark\n', apply)
    expect(apply).toBeGreaterThan(-1)
    expect(editStart).toBeGreaterThan(-1)
    // Run only the config builders and the actual operator-edit fragment.
    // No harness sourcing, lifecycle function, AD/tmux or server is run.
    const configs = shell(`set -eu
${helper('t19_persona_json', source)}
${configBuilder![0]}
${prefix}_NAME=fixture
${prefix}_CREDS="$HOME/first.json"
${prefix}_CREDS_TWO="$HOME/second.json"
${prefix}_WORK="$HOME/work"
${prefix}_CFG="$HOME/claude"
${prefix}_CHANNEL=C0TEST001
SCENARIO_PORT=12345
step=fixture
write_config() { jq -c .; }
t19_mark() { MARK_TIME=0; }
t19_apply_config() { shift 4; t19_config true "$@"; }
t19_config true ${prefix}
${prefix === 'J' ? 't19_config true' : ''}
${leg.slice(editStart, leg.indexOf('\n', apply))}`, ['jq'])
      .split('\n').map(line => JSON.parse(line) as PersonaConfigInput)
    expect(configs).toHaveLength(prefix === 'J' ? 3 : 2)
    let authority = makeSharedAuthority(home, configs[0]!)
    const original = authority.config().personas[0]!
    const oldLife = authority.incarnation(original.key)
    expect(original.channels).toEqual([{ id: 'C0TEST001', delivery: 'all' }])
    expect(original.dm.enabled).toBe(false)
    if (prefix === 'J') {
      expect(authority.applyReviewed(configBytes(configs[1]), authority.revision).kind).toBe('applied')
      authority = createSharedChannelAuthority(authority.path, readSharedState(home)!)
      expect(authority.config().personas).toEqual([])
    }
    const edited = configs.at(-1)!
    const copied = structuredClone(edited)
    copied.personas[0]!.channels = structuredClone(configs[0]!.personas[0]!.channels)
    expect(authority.previewReviewed(configBytes(copied)).personas[0]!.channels).toEqual([])
    const bytes = configBytes(edited)
    const preview = authority.previewReviewed(bytes).personas[0]!
    expect(preview.channels).toEqual([{ id: 'C0TEST001', delivery: 'mentions' }])
    expect(preview.dm.enabled).toBe(false)
    expect(preview.permission_prompts).toBe(original.permission_prompts)
    expect(preview.working_directory).toBe(original.working_directory)
    expect(preview.credentials_file).toBe(join(home, prefix === 'J' ? 'first.json' : 'second.json'))
    expect(authority.applyReviewed(bytes, authority.revision).kind).toBe('applied')
    expect(authority.incarnation(original.key)).not.toBe(oldLife)
    expect(authority.config().personas).toEqual([preview])
    expect(authority.sourceBytes()).toEqual(bytes)
    assertNoLeak(authority.snapshot())
  })
  test.each([
    ['valid', { session_id: 'new', prior_sessions: [{ session_id: 'old', jsonl_path: '/archived' }] }, true],
    ['resumed old', { session_id: 'old', prior_sessions: [{ session_id: 'old' }] }, false],
    ['lost archive', { session_id: 'new', prior_sessions: [] }, false],
    ['duplicate archive', { session_id: 'new', prior_sessions: [{ session_id: 'old' }, { session_id: 'old' }] }, false],
    ['wrong archive', { session_id: 'new', prior_sessions: [{ session_id: 'other' }] }, false],
    ['no current', { session_id: null, prior_sessions: [{ session_id: 'old' }] }, false],
  ] as const)('same-agent fresh reuse %s preserves archive without resuming it', (_label, row, accepted) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-19-fmk-reuse.sh'), 'utf8')
    writeFileSync(join(home, 'row.json'), JSON.stringify(row))
    const output = shell(`${helper('t19_check_reuse_history', source)}
AD_OUT="$HOME/row.json"
TEST_NAME=inert
fail() { exit 1; }
(t19_check_reuse_history fixture old) 2>/dev/null
printf '%s' "$?"`, ['jq', 'sed'])
    expect(output).toBe(accepted ? '0' : '1')
  })
  test.each([299999, 300000, 300001])('abandoned-session age %s respects the real B boundary', (age) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-16-fmk-conflict.sh'), 'utf8')
    const output = shell(`${helper('s19_abandoned_session_ready', source)}
AD_STARTING_MS=300000
now_ms() { printf '%s' '${1000000 + age}'; }
s19_abandoned_session_ready 1000
printf '%s' "$?"`)
    expect(output).toBe(age < 300000 ? '1' : '0')
  })
  test('abandoned launch remains unavailable before B; native conflict after B uses own-id handling', () => {
    const description = 'instance p: this id\'s own abandoned launch: session "slack_bot_p" ($4); nothing was done'
    expect(classifyAdError(agentDirectorClient.errorFromEnvelope('spawn', 'ErrTmuxUnresponsive', description)).errorClass).toBe(AD_ERROR_CLASS_UNAVAILABLE)
    const conflict = agentDirectorClient.errorFromEnvelope('spawn', 'ErrTmuxSessionConflict', description)
    expect(classifyAdError(conflict).errorClass).toBe(AD_ERROR_CLASS_CONFLICT)
    expect(recogniseConflictCase(conflict.errDescription)).toBe(LATCH_CASE_OWN_ID)
  })
  test.each([
    ['own-id probe', 'read-pane', 'read-pane', '--n-lines 1', true],
    ['wrong own-id reuse', 'read-pane', 'spawn', '--reuse-finished', false],
    ['wrong probe width', 'read-pane', 'read-pane', '--n-lines 2', false],
    ['direct reuse control', 'reuse-spawn', 'spawn', '--reuse-finished', true],
    ['incomplete probe', 'read-pane', '', '', true],
  ])('latched round %s has the specified status/call shape', (_label, call, verb, args, accepted) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-16-fmk-conflict.sh'), 'utf8')
    const output = shell(`${helper('round_call_is', source)}
${helper('latch_rounds', source)}
CALL_PROBE=read-pane
CALL_RESUME=resume
CALL_PLAIN_SPAWN=plain-spawn
CALL_REUSE_SPAWN=reuse-spawn
us_of() { printf '%s' "$1"; }
ad_cscb_calls() {
  printf '1\\t100\\t9\\tstatus\\trow\\t--instance-id row\\n'
  ${verb ? `printf '2\\t110\\t9\\t${verb}\\trow\\t${args}\\n'` : ':'}
}
fail() { printf 'REFUSED'; exit 1; }
(latch_rounds fixture row '${call}' 0) 2>/dev/null
printf '\\nRESULT=%s' "$?"`, ['sed'])
    expect(output).toBe(accepted ? `${verb ? '1 100 2 110' : '1 100 - -'}\n\nRESULT=0` : 'REFUSED\nRESULT=1')
    if (call === 'read-pane') {
      expect(source).toMatch(/declare -A S19_CALL=[\s\S]*?\[\$\{PEND_KEY\}\]="\$\{CALL_PROBE\}"/)
    }
  })
  test.each([
    ['retained history', 'rotated', null, true],
    ['never written without history', 'never_written', null, false],
    ['recorded current transcript', 'present', '/current.jsonl', false],
  ] as const)('unmessaged reuse %s checks the real transcript status', (_label, status, path, accepted) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-19-fmk-reuse.sh'), 'utf8')
    writeFileSync(join(home, 'row.json'), JSON.stringify({ session_id: 'new', prior_sessions: [{ session_id: 'old' }], transcript_status: status, jsonl_path: path }))
    const output = shell(`${helper('t19_check_reuse_history', source)}
${helper('t19_check_unmessaged_reuse', source)}
AD_OUT="$HOME/row.json"
fail() { exit 1; }
(t19_check_unmessaged_reuse fixture old) 2>/dev/null
printf '%s' "$?"`, ['jq', 'sed'])
    expect(output).toBe(accepted ? '0' : '1')
    const step6 = source.slice(source.indexOf('    # 6. The harness'), source.indexOf('# Scenario 12: helpers', source.indexOf('    # 6. The harness')))
    expect(step6).toContain('--arg n "${JSONL_MISSING}"')
    expect(step6).not.toContain('${NEVER_WRITTEN}')
  })
  test.each(['native recovery', 'omitted sweep'])('own-id clear matcher %s preserves the full round call chain', (mode) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-16-fmk-conflict.sh'), 'utf8')
    const printed = (call: string, answer: string) => latchRecheckRoundLine('"pendleft" (key=pendleft)', LATCH_CASE_OWN_ID, 'step-2', call, answer)
    const chain = 'read-pane+find-missing+reuse-spawn'
    writeFileSync(join(home, 'native-template'), printed(chain, 'ANSWER') + '\n')
    writeFileSync(join(home, 'old-template'), printed('read-pane+reuse-spawn', 'ANSWER') + '\n')
    writeFileSync(join(home, 'actual-line'), printed(mode === 'native recovery' ? chain : 'read-pane+reuse-spawn', 'probe-cleared (gone); cleared (spawned)') + '\n')
    const output = shell(`${helper('s19_clear', source)}
PEND_KEY=p
CALL_PROBE=read-pane
CALL_REUSE_SPAWN=reuse-spawn
INTERVAL_S=120
SETTLE_S=30
declare -A PERSONA_ID=([p]=row) PERSONA_NAME=([p]=pendleft) S19_SESSION=([p]=slack_bot_p)
declare -A S19_CASE=([p]=own-id) S19_STEP=([p]=step-2)
declare -A S19_ROUND_HEAD=([p]=unused) S19_ROUND_BASE=([p]=0) S19_ROUNDS=([p]=1)
fail() { printf REFUSED; exit 1; }
fmk_text() {
  local line
  case "$5" in
    read-pane+find-missing+reuse-spawn) IFS= read -r line < "$HOME/native-template";;
    read-pane+reuse-spawn) IFS= read -r line < "$HOME/old-template";;
    *) fail;;
  esac
  printf '%s' "$line"
}
wait_for_count() {
  local actual
  IFS= read -r actual < "$HOME/actual-line"
  [[ "$actual" == *"$1"* && "$2" == 1 && "$3" == 180 ]] || fail
  printf MATCH; exit 0
}
(s19_clear p fixture)
printf '\\nRESULT=%s' "$?"`)
    expect(output).toBe(mode === 'native recovery' ? 'MATCH\nRESULT=0' : 'REFUSED\nRESULT=1')
  })
  test('released AD gone-session capture error is GONE and clears an own-id probe', () => {
    const err = agentDirectorClient.errorFromEnvelope('read-pane', 'ErrTmuxCaptureFailed', 'tmux: capture-pane failed: instance fix7-probe: the row\'s session is not there: no tmux session of this launch was found (recorded name "cscb-fix7-probe"); nothing was read')
    const failure = paneReadFailureOf(err)
    expect(failure.kind).toBe(PANE_READ_GONE)
    expect(decideLatchRecheckProbe(LATCH_CASE_OWN_ID, { kind: PANE_READ_GONE })).toBe(RECHECK_VERDICT_CLEARED)
  })
  test.each(['native', 'legacy unknown', 'wrong classification', 'counted', 'wrong description'])('forced unusable-name reuse %s checks the native error and refusal behavior', (mode) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-27-fmk-unusable-name.sh'), 'utf8')
    const body = helper('step_forced_reuse', source)
    const start = body.indexOf('    for want in ')
    const end = body.indexOf("    # The driver's record entry", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const description = 'instance cscb_unusable: tmux session "slack_bot_unusable.x": the recorded tmux session name contains a character tmux stores differently (\'.\'); no tmux call was made'
    const err = agentDirectorClient.errorFromEnvelope('spawn', 'ErrInternal', mode === 'wrong description' ? 'unrelated internal failure' : description)
    expect(err).toBeInstanceOf(agentDirectorClient.ErrInternal)
    const classification = classifyAdError(err)
    expect(classification.errorClass).toBe(mode === 'wrong description' ? AD_ERROR_CLASS_UNCLASSIFIED : AD_ERROR_CLASS_UNUSABLE_NAME)
    const line = `DRIVER: FORCED reuse-spawn called=true action=latched counted=${mode === 'counted'} latched=true error=${mode === 'legacy unknown' ? 'ErrUnknownErrorName' : err.errName} class=${mode === 'wrong classification' ? 'UNCLASSIFIED' : classification.errorClass}${mode === 'legacy unknown' ? ' unknown_name=ErrInternal' : ''} description=${JSON.stringify(err.errDescription)} result={}`
    writeFileSync(join(home, 'outcome'), line + '\n')
    const output = shell(`
IFS= read -r line < "$HOME/outcome"
CLASS_UNUSABLE=UNUSABLE_NAME
UNUSABLE_PHRASE='the recorded tmux session name'
U_UNUSABLE=slack_bot_unusable.x
step=fixture
fail() { printf REFUSED; exit 1; }
(${body.slice(start, end)})
printf '\\nRESULT=%s' "$?"`, ['jq'])
    expect(output).toBe(mode === 'native' ? 'RESULT=0' : 'REFUSED\nRESULT=1')
  })
  test.each(['0.13', '0.14.0', '0.15.0'].flatMap((layout) => [true, false].map((linked) => [layout, linked] as const)))('scratch layout %s with AD link=%s seeds only historical directories', (layout, linked) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-30-state-dir-upgrade.sh'), 'utf8')
    const output = shell(`${['enter_layout', 'seed_layout', 'seed_into'].map((name) => helper(name, source)).join('\n')}
SCENARIO_ROOT="$HOME"
REAL_HOME="$HOME/container"
SEED="$HOME/seed"
CREDENTIALS_NAME=credentials-alpha.json
mkdir -p "$REAL_HOME" "$SEED/prompts"
${linked ? 'mkdir -p "$REAL_HOME/.config/agent-director"' : ':'}
for name in config.json credentials-alpha.json crontab server.log server.pid; do printf fixture > "$SEED/$name"; done
printf prompt > "$SEED/prompts/daily.md"
fail() { printf 'REFUSED: %s' "$*"; exit 1; }
enter_layout '${layout}'
[[ ! -e "$N" && ! -L "$N" ]] || exit 7
seed_layout '${layout}'
[[ ! -e "$N" && ! -L "$N" ]] || exit 8
printf seeded`, ['mkdir', 'ln', 'cp'])
    expect(output).toBe('seeded')
    const scratchHome = join(home, `home-${layout}`)
    const old = join(scratchHome, '.claude/channels/slack')
    const xdg = join(scratchHome, '.config/cscb')
    expect(existsSync(join(scratchHome, '.config/claude-slack-channel-bots'))).toBe(false)
    const ad = join(scratchHome, '.config/agent-director')
    expect(existsSync(ad)).toBe(linked)
    if (linked) expect(readlinkSync(ad)).toBe(join(home, 'container/.config/agent-director'))
    const allFiles = ['config.json', 'credentials-alpha.json', 'crontab', 'prompts', 'server.log', 'server.pid'].sort()
    expect(readdirSync(old).sort()).toEqual(allFiles)
    if (layout === '0.13') {
      expect(existsSync(xdg)).toBe(false)
      expect(lstatSync(old).isDirectory()).toBe(true)
      expect(lstatSync(join(old, 'crontab')).isFile()).toBe(true)
    } else if (layout === '0.14.0') {
      expect(readdirSync(xdg).sort()).toEqual(['crontab', 'prompts'])
      expect(readlinkSync(join(old, 'crontab'))).toBe(join(xdg, 'crontab'))
      expect(readlinkSync(join(old, 'prompts'))).toBe(join(xdg, 'prompts'))
    } else {
      expect(readdirSync(xdg).sort()).toEqual(allFiles)
      expect(readlinkSync(old)).toBe(xdg)
    }
  })
  test('scratch AD parent creation failure is reported before attempting the link', () => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-30-state-dir-upgrade.sh'), 'utf8')
    const output = shell(`${helper('enter_layout', source)}
SCENARIO_ROOT="$HOME"
REAL_HOME="$HOME/container"
mkdir -p "$REAL_HOME/.config/agent-director" "$SCENARIO_ROOT/home-0.13"
printf blocked > "$SCENARIO_ROOT/home-0.13/.config"
fail() { printf 'REFUSED: %s' "$*"; exit 1; }
(enter_layout 0.13) 2>/dev/null
printf '\\nRESULT=%s' "$?"`, ['mkdir', 'ln'])
    expect(output).toBe(`REFUSED: setup: could not create ${home}/home-0.13/.config\nRESULT=1`)
  })
  test.each(['target', 'other', 'empty'])('rebuilt A must exercise its targeted kill fault: %s log', (mode) => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-14-fmk-kill-fails.sh'), 'utf8')
    const call = mode === 'empty' ? '' : `call\t100\t1\t2\t3\tkill-session -t =${mode === 'target' ? 'ua' : 'unrelated'}\n`
    writeFileSync(join(home, 'tmux.log'), call)
    const output = shell(`${helper('t14_note_kills_at', source)}
SCENARIO_TMUX_SHIM_LOG="$HOME/tmux.log"
MARK_TIME=90
TEST_NAME=inert
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
(t14_note_kills_at fault ua)
printf 'RESULT=%s' "$?"`, ['awk'])
    expect(output).toContain(mode === 'target' ? 'RESULT=0' : 'RESULT=1')
    if (mode !== 'target') expect(output).toContain('the fail-kill fault was not exercised')
  })
  test('released fixture rebuilding explicitly reuses migrated terminal rows', () => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-14-fmk-kill-fails.sh'), 'utf8')
    const start = source.indexOf('for fixture in A B P Q; do')
    const end = source.indexOf("\n# P's intentionally injected", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const loop = source.slice(start, end)
    const run = (body: string): string => shell(`
UA_ID=a; UB_ID=b; P_ID=p; Q_ID=q
UA_SESSION=a; UB_SESSION=b; P_SESSION=p; Q_SESSION=q
UA_WORK="$HOME"; UB_WORK="$HOME"; P_ROW_WORK="$HOME"; Q_WORK="$HOME"
UA_CHANNEL=C_A; UB_CHANNEL=C_B; SVC_LABEL=service=cscb; PERSONA_LABEL=persona; P_KEY=p; Q_KEY=q
AD_ERR="$HOME/err"
printf ErrSpawnExists > "$AD_ERR"
fail() { printf 'REFUSED: %s\\n' "$*"; exit 1; }
ad_capture() {
  AD_RC=1
  for arg in "$@"; do [[ "$arg" != --reuse-finished ]] || AD_RC=0; done
  if (( AD_RC == 0 )); then printf 'REUSED\\n'; fi
}
(${body})
printf 'RESULT=%s' "$?"`, ['head'])
    expect(run(loop).match(/REUSED/g)).toHaveLength(4)
    expect(run(loop.replace('--reuse-finished', ''))).toContain('RESULT=1')
    const reinstall = helper('leg_reinstall', selfCheck)
    expect(reinstall).toContain('--no-pre-trust --reuse-finished --label "t0=edited"')
  })
  test('test-20 passing prerelease meets both native and numeric floors', () => {
    const source = readFileSync(join(import.meta.dir, 'integration/test-20-fmk-old-binary.sh'), 'utf8')
    const assignment = source.match(/^IFS=\. read -r floor_major floor_minor floor_patch[^\n]*\nPASSING_VERSION=[^\n]*/m)
    expect(assignment).not.toBeNull()
    const passing = shell(`FLOOR='${PHASE1_FLOOR_VERSION}'\n${assignment![0]}\nprintf '%s' "$PASSING_VERSION"`)
    expect(compareAdVersions(`${PHASE1_FLOOR_VERSION}-rc.1`, CLIENT_MIN_VERSION)).toBe(-1)
    expect(compareAdVersions(passing, CLIENT_MIN_VERSION)).toBe(1)
    expect(meetsPhase1Floor(passing)).toBe(true)
    for (const leg of ['8a', '8c', '8e']) {
      expect(source).toMatch(new RegExp(`expect_one_floor_entry "${leg}"[^\n]*"\\$\\{TOO_OLD_LABEL\\}"`))
    }
    expect(source).toContain('buildBelowPhase1FloorMessage "${DEV_SENTINEL}"')
  })
  test.each(['startup', 'runtime'] as const)('test-20 native %s message printer uses the real builder and client minimum', async (finder) => {
    const source = readFileSync(join(import.meta.dir, 'integration/fixtures/fmk-texts.ts'), 'utf8')
    const declarations = source.slice(source.indexOf('const clientMinimumVersion: Entry'), source.indexOf('/** `formatPersonaNotice'))
    const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const functions: Record<string, unknown> = {
      readClientMinVersion: () => CLIENT_MIN_VERSION,
      buildSystemInstallTooOldMessage,
      renderInstallSkillInstructions,
    }
    const printer = new Function('packageFunction', 'packageString', 'expectArguments', 'usageFail', 'builtString', 'FOUND_BY_EXPORTS', `${compiled}\nreturn systemInstallTooOldMessage;`)(
      async (_context: unknown, _file: string, name: string) => {
        expect(functions[name]).toBeTypeOf('function')
        return functions[name]
      },
      async (_context: unknown, _file: string, name: string) => name === 'FOUND_BY_STARTUP_CHECK' ? FOUND_BY_STARTUP_CHECK : FOUND_BY_RUNTIME_RECHECK,
      (_entry: string, args: string[], expected: string[]) => expect(args).toHaveLength(expected.length),
      (message: string) => { throw new Error(message) },
      (_entry: string, value: unknown) => { expect(value).toBeTypeOf('string'); return value },
      { startup: 'FOUND_BY_STARTUP_CHECK', runtime: 'FOUND_BY_RUNTIME_RECHECK' },
    ) as { print: (args: string[], context: object) => Promise<string> }
    const foundBy = finder === 'startup' ? FOUND_BY_STARTUP_CHECK : FOUND_BY_RUNTIME_RECHECK
    const expected = buildSystemInstallTooOldMessage({ foundVersion: '0.10.0', binaryPath: '/fixture/bin/agent-director', requiredVersion: CLIENT_MIN_VERSION }, foundBy)
      + (finder === 'startup' ? renderInstallSkillInstructions() : '')
    expect(await printer.print(['0.10.0', '/fixture/bin/agent-director', finder], {})).toBe(expected.replace(/\r?\n/g, ' ').replace(/\r/g, ' '))
  })
  test('swapping a below-floor binary never changes the installed stage contract', () => {
    expect(helper('swap_ad_binary')).not.toContain('_scenario_ad_contract')
    const install = helper('install_ad_release')
    expect(install.indexOf('_scenario_ad_contract release')).toBeGreaterThan(install.indexOf('if [[ "${rc}" -ne 0 ]]'))
    expect(install.indexOf('_scenario_ad_contract release')).toBeLessThan(install.indexOf('reshim_ad'))
  })
  test('legacy seeder verifies version and schema before spawn; a rename regression is detected', () => {
    const guard = helper('_scenario_require_010')
    expect(guard).toContain('"${ver}" == "${SCENARIO_AD_010_VERSION}"')
    expect(guard).toContain("WHERE name = 'claude_instance_id'")
    const seed = helper('seed_010_row')
    expect(seed.indexOf('_scenario_require_010')).toBeLessThan(seed.indexOf('ad_capture spawn'))
    expect(seed).toContain('spawn --cwd "${dir}" --claude-instance-id "${id}"')
    const renamed = seed.replace('--claude-instance-id', '--instance-id').replace('spawn --cwd', 'spawn --agent claude --cwd')
    expect(renamed).not.toContain('spawn --cwd "${dir}" --claude-instance-id "${id}"')
  })
})

/** Old tokens are permitted only inside specific old-release/mixed-log helper
 * bodies, with a deliberate legacy comment and the expected number of lines.
 * Neither a whole file nor the integration tree gets an exemption. */
const LEGACY_HELPER_CONTRACTS: Record<string, Record<string, number>> = {
  'lib/scenario.sh': { _scenario_ad_contract: 5, _scenario_require_010: 2, _scenario_row_left_pending: 1, seed_010_row: 2, _scenario_ad_id: 2, ad_trail_events: 1 },
  'fixtures/stub-claude.sh': { read_grace: 1, refire_tick: 1 },
  'test-0-fmk-harness-self-check.sh': { leg_guard_refusals: 4 },
}
const LEGACY_TOKEN = /claude_instance_id|claude-instance-id|claude_session_id|claude_args|AGENT_DIRECTOR_CLAUDE_INSTANCE_ID|\.agent-director(?:\/|["'])/
function legacyIntegrationFindings(file: string, source: string): string[] {
  const allowed = LEGACY_HELPER_CONTRACTS[file] ?? {}
  const permitted = new Set<number>()
  const problems: string[] = []
  for (const [name, count] of Object.entries(allowed)) {
    const re = new RegExp(`^${name}\\(\\) \\{\n[\\s\\S]*?^\\}`, 'm')
    const match = re.exec(source)
    if (!match) { problems.push(`${file}: missing legacy helper ${name}`); continue }
    const start = source.slice(0, match.index).split('\n').length - 1
    const comment = source.slice(Math.max(0, source.lastIndexOf('\n}', match.index) + 2), match.index) + match[0]
    if (!/Deliberate pre-0\.12/.test(comment)) problems.push(`${file}: ${name} lacks its deliberate legacy comment`)
    const hits = match[0].split('\n').flatMap((line, offset) => !/^\s*#/.test(line) && LEGACY_TOKEN.test(line) ? [start + offset] : [])
    if (hits.length !== count) problems.push(`${file}: ${name} has ${hits.length} legacy lines, expected ${count}`)
    for (const line of hits) permitted.add(line)
  }
  source.split('\n').forEach((line, index) => {
    if (!/^\s*#/.test(line) && LEGACY_TOKEN.test(line) && !permitted.has(index)) problems.push(`${file}:${index + 1}: legacy token outside an old-release contract`)
  })
  return problems
}
describe('old-name audit exempts only deliberate old-release contracts', () => {
  const base = join(import.meta.dir, 'integration')
  const files = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)])
  test('the integration tree has no old token outside its documented helper contracts', () => {
    expect(files(base).flatMap((file) => legacyIntegrationFindings(file.slice(base.length + 1), readFileSync(file, 'utf8')))).toEqual([])
  })
  test.each(['other.sh', 'lib/other.sh', 'fixtures/driver.ts', 'test-13-fmk-switch-over.sh'])('an old call in %s has no exemption', (file) => {
    expect(legacyIntegrationFindings(file, 'ad spawn --claude-instance-id x')).toHaveLength(1)
  })
  test('an extra legacy call inside a sanctioned helper is refused', () => {
    const source = readFileSync(join(base, 'lib/scenario.sh'), 'utf8')
    const planted = source.replace('seed_010_row() {', 'seed_010_row() {\n    ad get --claude-instance-id planted')
    expect(legacyIntegrationFindings('lib/scenario.sh', planted)).toContain('lib/scenario.sh: seed_010_row has 3 legacy lines, expected 2')
  })
  test('an extra old config read inside the worker grace helper is refused', () => {
    const source = readFileSync(join(base, 'fixtures/stub-claude.sh'), 'utf8')
    const planted = source.replace('read_grace() {', 'read_grace() {\n    cat "$HOME/.agent-director/config.toml"')
    expect(legacyIntegrationFindings('fixtures/stub-claude.sh', planted)).toContain('fixtures/stub-claude.sh: read_grace has 2 legacy lines, expected 1')
    const outside = `${source}\ncat "$HOME/.agent-director/config.toml"\n`
    expect(legacyIntegrationFindings('fixtures/stub-claude.sh', outside)).toEqual([`fixtures/stub-claude.sh:${source.split('\n').length + 1}: legacy token outside an old-release contract`])
  })
})

describe('test-17 loses only a successful, targeted AD launch response', () => {
  const fixtureDir = join(import.meta.dir, 'integration/fixtures')
  const shim = readFileSync(join(fixtureDir, 'agent-director-shim.sh'), 'utf8')
  const scenario = readFileSync(join(import.meta.dir, 'integration/test-17-fmk-launch-pending.sh'), 'utf8')
  const declaration = (name: string) => scenario.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))![0]
  const leg = declaration('leg_launch_timeouts')
  const selectionStart = leg.indexOf('    # Step 3:')
  const selection = leg.slice(selectionStart, leg.indexOf('    log0=', selectionStart))
  // Execute the complete shim against an inert binary replacement. No AD,
  // tmux, native agent or scenario is run.
  const envelope = readFileSync(join(fixtureDir, 'agent-director-unresponsive.json'), 'utf8')
  let root: string, real: string, log: string, faults: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pending-launch-response-'))
    real = join(root, 'agent-director.real'); log = join(root, 'agent-director-shim.log'); faults = join(root, 'agent-director-shim.faults')
    writeFileSync(join(root, 'inert-shim'), shim, { mode: 0o755 })
    writeFileSync(join(root, 'agent-director-unresponsive.json'), envelope)
    writeFileSync(`${real}.status`, '0\n')
    writeFileSync(real, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$0.calls"\nprintf "real-stdout\\n"\nprintf "real-stderr\\n" >&2\nread -r rc < "$0.status"\nexit "$rc"\n', { mode: 0o755 })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  function configure(useSlowCreate = false) {
    const script = [
      'set -euo pipefail', 'SCENARIO_AD_SHIM_LOG="$1"', 'LT_ROLES=(spawn reuse resume)',
      'declare -A LT_ID=([spawn]=fixture_spawn [reuse]=fixture_reuse [resume]=fixture_resume)',
      'require_ci_image() { :; }', 'require_scenario_home() { :; }', 'fail() { exit 97; }',
      'tmux_shim_mode() { :; }', declaration('lt_launch_reply_faults'),
      useSlowCreate ? selection.replace('    lt_launch_reply_faults', '    tmux_shim_mode slow-create 15') : selection,
    ].join('\n')
    const result = spawnSync('bash', ['-c', script, 'inert-selection', log], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'flock'] }), encoding: 'utf8', timeout: 5000,
    })
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0)
    assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
  }
  function invoke(args: string[], rc = 0) {
    writeFileSync(`${real}.status`, `${rc}\n`)
    const result = spawnSync('bash', ['-p', join(root, 'inert-shim'), ...args], {
      env: hostSafeChildEnv(root, { tools: ['bash'] }), encoding: 'utf8', timeout: 5000,
    })
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull()
    assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  function actualFaults() { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(line => line.startsWith('fault\t')) : [] }
  function decodedReply(reply: ReturnType<typeof invoke>, verb: 'spawn' | 'resume') {
    expect(reply.status).toBe(1)
    expect(reply.stdout).toBe('')
    const parsed = JSON.parse(reply.stderr)
    return agentDirectorClient.errorFromEnvelope(verb, parsed.err_name, parsed.err_description)
  }
  function expectLaunchTimeout(reply: ReturnType<typeof invoke>, verb: 'spawn' | 'resume') {
    const error = decodedReply(reply, verb)
    expect(classifyAdError(error).errorClass).toBe(AD_ERROR_CLASS_UNAVAILABLE)
    expect(launchTimeoutFormOf(error, verb)).toBe(LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE)
    expect(error.errDescription).toContain(LAUNCH_TIMEOUT_PHRASE)
    expect(error.errDescription).not.toContain('the keys may have been delivered')
    return error
  }

  test.each([
    ['plain spawn', ['spawn', '--instance-id', 'fixture_spawn']],
    ['reuse spawn', ['spawn', '--instance-id', 'fixture_reuse', '--reuse-finished']],
    ['resume', ['resume', '--instance-id', 'fixture_resume']],
    ['client global arguments', ['--store-path', '/inert/store', 'spawn', '--instance-id', 'fixture_spawn']],
    ['equals global and instance arguments', ['--store-path=/inert/store', 'spawn', '--instance-id=fixture_spawn']],
  ])('%s executes the launch once, replaces only its successful reply, then exhausts the fault', (_name, args) => {
    configure()
    expectLaunchTimeout(invoke(args as string[]), args.includes('resume') ? 'resume' : 'spawn')
    expect(actualFaults()).toHaveLength(1)
    const words = args as string[]
    const id = words.find(word => word.startsWith('--instance-id='))?.split('=')[1]
      ?? words[words.indexOf('--instance-id') + 1]
    expect(actualFaults()[0]!.split('\t')[5]).toBe(`${words.includes('resume') ? 'resume' : 'spawn'} instance=${id} launch-reply-timeout 1`)
    expect(readFileSync(`${real}.calls`, 'utf8').trim().split('\n')).toEqual([(args as string[]).join(' ')])
    expect(invoke(args as string[])).toEqual({ status: 0, stdout: 'real-stdout\n', stderr: 'real-stderr\n' })
    expect(actualFaults()).toHaveLength(1)
    expect(readdirSync(root).filter(name => name.includes('.reply.'))).toEqual([])
  })

  test.each([
    ['reuse collision', 'spawn', 'fixture_reuse', 23],
    ['resume error', 'resume', 'fixture_resume', 24],
    ['plain launch error', 'spawn', 'fixture_spawn', 25],
  ])('%s preserves both streams and status, reserving the timeout for the next successful launch', (_name, verb, id, rc) => {
    configure()
    const args = [verb as string, '--instance-id', id as string]
    const rulesBefore = readFileSync(faults, 'utf8')
    expect(invoke(args, rc as number)).toEqual({ status: rc, stdout: 'real-stdout\n', stderr: 'real-stderr\n' })
    expect(actualFaults()).toEqual([])
    expect(readFileSync(faults, 'utf8')).toBe(rulesBefore)
    expectLaunchTimeout(invoke(args), verb as 'spawn' | 'resume')
    expect(actualFaults()).toHaveLength(1)
  })

  test.each([
    ['other persona', ['spawn', '--instance-id', 'fixture_other']],
    ['prefix-only persona', ['spawn', '--instance-id', 'fixture_spawn_extra']],
    ['target only in a label', ['spawn', '--instance-id', 'fixture_other', '--label', 'fixture_spawn']],
    ['other verb', ['get', '--instance-id', 'fixture_spawn']],
    ['wrong launch kind', ['resume', '--instance-id', 'fixture_spawn']],
    ['resume persona’s initial plain spawn', ['spawn', '--instance-id', 'fixture_resume']],
  ])('%s passes through without consuming another persona’s fault', (_name, args) => {
    configure()
    const rulesBefore = readFileSync(faults, 'utf8')
    expect(invoke(args as string[])).toEqual({ status: 0, stdout: 'real-stdout\n', stderr: 'real-stderr\n' })
    expect(actualFaults()).toEqual([])
    expect(readFileSync(faults, 'utf8')).toBe(rulesBefore)
  })

  test('the actual leg configures all three scoped launch faults and retains the report delay and fixed deadline', () => {
    configure()
    expect(readFileSync(faults, 'utf8')).toBe('spawn instance=fixture_spawn launch-reply-timeout 1\nspawn instance=fixture_reuse launch-reply-timeout 1\nresume instance=fixture_resume launch-reply-timeout 1\n')
    // Mutating the actual leg back to slow-create loses the timeout oracle.
    rmSync(faults)
    configure(true)
    expect(invoke(['spawn', '--instance-id', 'fixture_spawn'])).toEqual({ status: 0, stdout: 'real-stdout\n', stderr: 'real-stderr\n' })
    expect(scenario).toContain('LT_REPORT_WAIT_S=60')
    expect(scenario).toContain('LT_REPORT_DELAY_S=$(( ${#LT_ROLES[@]} * ((CREATE_TIMEOUT_MS + 999) / 1000) + LT_HOLD_SLACK_S ))')
    expect(leg).toContain('deadline=$(( $(_scenario_now_ms) + (LAUNCH_END_WAIT_S + LT_REPORT_WAIT_S) * 1000 ))')
  })

  test('the older unknown-typed action fails the collision pass-through control', () => {
    configure()
    writeFileSync(faults, readFileSync(faults, 'utf8').replaceAll('launch-reply-timeout', 'unknown-typed'))
    expect(invoke(['spawn', '--instance-id', 'fixture_reuse'], 23)).toEqual({ status: 1, stdout: '', stderr: envelope })
    expect(actualFaults()).toHaveLength(1)
  })

  test.each(['spawn', 'reuse', 'resume'] as const)('%s reply ends the production launch window and owns its pending row', async role => {
    configure()
    const verb = role === 'resume' ? 'resume' : 'spawn'
    const error = expectLaunchTimeout(invoke([verb, '--instance-id', `fixture_${role}`]), verb)
    const h = makeRecoveryHarness({ harnessNow: true })
    const persona = h.config.personas[0]!, key = persona.key
    const startMs = Date.parse('2026-01-01T00:00:00Z'), takesMs = 3_000
    let launched = false
    try {
      await h.clock.advanceTo(startMs)
      if (role !== 'spawn') h.script(collided(h, persona, {
        state: 'ended', session_id: 'saved-session',
        ...(role === 'reuse' ? { cwd: h.home } : {}),
      }))
      const timedCall = async () => {
        launched = true
        await h.clock.advance(takesMs)
        return error
      }
      h.script({
        ...(verb === 'resume' ? { resumeFn: timedCall } : { spawnFn: params => {
          if (role === 'reuse' && !params.reuse_finished) return undefined
          return timedCall()
        } }),
        getFn: () => launched ? personaRow(h, key, { state: 'pending', launch_started_at: new Date(startMs + 1).toISOString() }) : undefined,
      })
      expect(await h.launch(key)).toEqual({ key, action: 'retrying' })
      expect(launchCallWindowOf(key)).toEqual({ verb, startMs, endMs: startMs + takesMs, end: LAUNCH_CALL_END_LAUNCH_TIMEOUT })
      expect(thisLaunchRowOf(key)).toEqual({ launchStartMs: startMs + 1, window: { verb, startMs, endMs: startMs + takesMs, end: LAUNCH_CALL_END_LAUNCH_TIMEOUT } })
      expect(h.stub.calls.readPaneCalls).toEqual([])
      expect(h.stub.calls.sendKeysCalls).toEqual([])
      expect(h.stub.calls.killCalls).toEqual([])
      expect(h.stub.calls.deleteCalls).toEqual([])
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  })

  test('the old send-keys envelope fails the launch-timeout oracle on the executable shim', () => {
    configure()
    const broken = shim.replace(/            printf '\{"err_name":"ErrTmuxUnresponsive"[^\n]+/, '            /usr/bin/cat "${log%/*}/agent-director-unresponsive.json" >&2 || exit 70')
    expect(broken).not.toBe(shim)
    writeFileSync(join(root, 'inert-shim'), broken)
    const reply = invoke(['spawn', '--instance-id', 'fixture_spawn'])
    const error = decodedReply(reply, 'spawn')
    expect(classifyAdError(error).errorClass).toBe(AD_ERROR_CLASS_UNAVAILABLE)
    expect(launchTimeoutFormOf(error, 'spawn')).toBeUndefined()
    expect(() => expectLaunchTimeout(reply, 'spawn')).toThrow()
  })

  test.each(['send-keys instance=fixture_spawn', 'spawn *'])('launch timeout fault refuses an unsafe scope: %s', rule => {
    writeFileSync(faults, `${rule} launch-reply-timeout 1\n`)
    expect(invoke(['spawn', '--instance-id', 'fixture_spawn']).status).toBe(70)
    expect(existsSync(`${real}.calls`)).toBe(false)
    expect(actualFaults()).toEqual([])
  })
})

describe('integration configuration and discovery prerequisites', () => {
  const source = readFileSync(join(import.meta.dir, 'integration/test-29-invited-channels.sh'), 'utf8')
  const builder = source.slice(source.indexOf('write_persona_config() {'), source.indexOf('\n\n# --- Start'))
  const helpers = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
  const declaration = (text: string, name: string) => {
    const found = text.match(new RegExp(`^${name}\\(\\) \{\n[\\s\\S]*?^\}`, 'm'))
    if (!found) throw new Error(`missing declaration ${name}`)
    return found[0]
  }
  const channels = source.slice(source.indexOf('A1="$(scenario_id'), source.indexOf('ALPHA_BOT_USER='))
  const ids = Object.fromEntries([...channels.matchAll(/^(\w+)="\$\(scenario_id ([CG]) ([\w-]+)\)"/gm)]
    .map(([, name, kind, label]) => [name, kind + createHash('sha256').update(`fixture\n${label}`).digest('hex').slice(0, 20).toUpperCase()]))
  const control = [
    declaration(helpers, 'slack_stub_inventory_body'), declaration(helpers, 'slack_stub_inventory_page'),
    `_scenario_stub_control_patch() { shift; jq -cn "$@" '{label:$l,memberships:[$page[0].channels[].id]}'; }`,
    'inventory() {',
    ...source.slice(source.indexOf('slack_stub_controls "'), source.indexOf('# --- Configurations')).split('\n')
      .filter(line => line.startsWith('slack_stub_inventory_page ') || /^(ALPHA|BRAVO)_MEMBERS=\(/.test(line)),
    '}', "inventory | jq -s '{tokens:.}'",
  ].join('\n')
  function build(mode: string, body = builder, root?: string) {
    const home = root ?? mkdtempSync(join(tmpdir(), 'membership-config-contract-'))
    try {
      const state = readSharedState(home)
      writeFileSync(join(home, 'audit-personas.json'), JSON.stringify(state?.personas ?? {}))
      return spawnSync('/bin/bash', ['--noprofile', '--norc', '-uc', `
SCENARIO_TAG=fixture TEST_NAME=fixture
require_ci_image() { :; }
fail() { printf '%s' "$1" >&2; exit 1; }
${declaration(helpers, 'scenario_id')}
${channels}
ALPHA_KEY=alpha BRAVO_KEY=bravo
shared_persona_facts() { jq -c --arg key "$1" '.[$key]' "$FIXTURE_ROOT/audit-personas.json"; }
shared_channel_saved() { jq -r --arg key "$1" --arg channel "$2" '.[$key].assignments[$channel].delivery // empty' "$FIXTURE_ROOT/audit-personas.json"; }
SWITCH_KEY=channel_mode
ALPHA=alpha BRAVO=bravo ALPHA_CREDS=/tmp/alpha-creds BRAVO_CREDS=/tmp/bravo-creds
ALPHA_CREDS="\${FIXTURE_ROOT}/alpha-creds" BRAVO_CREDS="\${FIXTURE_ROOT}/bravo-creds"
ALPHA_DIR="\${FIXTURE_ROOT}/alpha-work" BRAVO_DIR="\${FIXTURE_ROOT}/bravo-work" CONTACT=U0CONTACT SCENARIO_PORT=3100 MCP_CONFIG="\${FIXTURE_ROOT}/mcp.json"
ALPHA_SUFFIX=alpha BRAVO_SUFFIX=bravo ALPHA_LABEL=alpha BRAVO_LABEL=bravo
ALPHA_BOT_USER=U0MEMBER0 ALPHA_BOT_ID=B0MEMBER0 BRAVO_BOT_USER=U0MEMBER1 BRAVO_BOT_ID=B0MEMBER1
STUB_CONTROL="\${FIXTURE_ROOT}/control.json" CONFIG="\${FIXTURE_ROOT}/config.json" LAST="\${FIXTURE_ROOT}/config.json.last-applied"
write_config() { cat; }
write_file() { cat; }
fail() { printf '%s' "$1" >&2; exit 1; }
${body}
write_persona_config '${mode}'`], { encoding: 'utf8', timeout: 5000, env: hostSafeChildEnv(home, { tools: ['cat', 'jq', 'sha256sum', 'tr', 'sort'], extras: { FIXTURE_ROOT: home } }) })
    } finally { if (!root) rmSync(home, { recursive: true, force: true }) }
  }
  test.each(['declarative', 'fungible', 'switch-off'])('test29 %s builder executes with nounset and retains distinct intended channel values', mode => {
    const result = build(mode)
    assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
    expect(result.status).toBe(0); expect(result.stderr).toBe('')
    const config = JSON.parse(result.stdout)
    expect(config.channel_mode).toBe(mode === 'declarative' ? undefined : mode === 'fungible' ? 'open' : 'strict')
    for (const persona of config.personas) {
      const channelIds = persona.channels.map((entry: { id: string }) => entry.id)
      expect(new Set(channelIds).size).toBe(channelIds.length)
      expect(channelIds.every((id: string) => /^[CG][A-Z0-9]+$/.test(id))).toBe(true)
      if (mode !== 'declarative') {
        // U1 was discovered off in phase A; both personas explicitly share it after the mode change.
        expect(persona.channels).toContainEqual({ id: ids.U1!, delivery: 'all' })
        expect(persona.channels).toContainEqual({ id: ids.F1!, delivery: 'mentions' })
      }
    }
  })
  test('regression control: the original undefined S1 aborts the actual extracted builder', () => {
    const result = build('fungible', builder.replaceAll('${U1}', '${S1}'))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('S1: unbound variable')
  })
  test('test29 U0 shell oracles require both current-membership drops, no dedupe and a later eligible delivery', async () => {
    const { makeMembershipHarness, membershipPage } = await import('./test-helpers/shared-channels.ts')
    const { makeManagedRouting } = await import('./test-helpers/persona-routing-managed.ts')
    const { resetRoutingState } = await import('./test-helpers/persona-routing-harness.ts')
    const { makeAppMention, makeChannelMessage } = await import('./test-helpers/slack-stub.ts')
    const { createChannelDeliveryStore } = await import('../src/channel-delivery.ts')
    const { createPersonaEventRouter } = await import('../src/persona-event-router.ts')
    const { renderPersonaRef } = await import('../src/persona-identity.ts')
    const { formatPersonaDiagnostic, UNCLAIMED_CHANNEL, unclaimedChannelCause } = await import('../src/persona-diagnostics.ts')
    const home = mkdtempSync(join(tmpdir(), 'test29-membership-drop-'))
    resetRoutingState()
    const f = makeMembershipHarness(home, { names: ['alpha', 'bravo'] })
    const managed = makeManagedRouting(f.h, home, { membership: f.membership, getChannelDelivery: () => createChannelDeliveryStore(f.authority) })
    const routerLines: string[] = []
    f.h.onEvent = createPersonaEventRouter({ membership: f.membership, routing: managed.routing, clientFor: f.h.clientFor, getPersona: f.h.getPersona, log: line => routerLines.push(line) })
    try {
      const initial = build('declarative', builder, home), inventory = build('declarative', `${control}\nwrite_persona_config() { :; }`, home)
      expect(initial.status).toBe(0); expect(inventory.status).toBe(0)
      expect(f.authority.applyReviewed(Buffer.from(initial.stdout), f.authority.revision).kind).toBe('applied')
      for (const token of JSON.parse(inventory.stdout).tokens as Array<{ label: string; memberships: string[] }>) {
        f.h.stub(f.h.p(token.label)).script.inventory.push(membershipPage(token.memberships))
      }
      await f.start(); await f.scan(); await managed.ready
      const channel = ids.U0!, eligible = ids.A2!
      const stub = f.h.stub(f.h.p('alpha'))
      const text = `  <@${stub.identity.botUserId}> original\r\n\r\nmention  `
      const message = makeChannelMessage({ channel, text, ts: '1700000001.000001' })
      expect(f.membership.read('alpha', channel, 'strict')).toEqual({ kind: 'ineligible', reason: 'absent' })
      const authorityBefore = f.authority.snapshot()
      for (const event of [makeAppMention({ channel, text, ts: message.ts }), message]) {
        await stub.socket.deliver(event)
        expect(managed.queued('alpha')).toEqual([])
        expect(managed.queued('bravo')).toEqual([])
        expect(managed.queue.lookupSlackKey('alpha', { chat_id: channel, ts: String(message.ts) })).toBeUndefined()
      }
      expect(stub.socket.acks).toHaveLength(2)
      const drops = [...managed.logs]
      expect(drops).toHaveLength(2)
      const positive = makeChannelMessage({ channel: eligible, text, ts: '1700000001.000002' })
      await stub.socket.deliver(positive)
      expect(stub.socket.acks).toHaveLength(3)
      expect(managed.queued('alpha').map(({ accepted: { channel, key, text, via } }) => ({ channel, key, text, via }))).toEqual([
        { channel: eligible, key: { chat_id: eligible, ts: String(positive.ts) }, text, via: 'mention' },
      ])
      expect(managed.queued('bravo')).toEqual([])
      expect(managed.logs).toEqual(drops)
      expect(f.authority.snapshot()).toEqual(authorityBefore)

      // Run the scenario's own wait/count assertions over production evidence.
      // Only pure matcher declarations are extracted; no harness is sourced.
      const helpers = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
      const assertions = source.split('\n').filter(line => /^(wait_since|expect_since) "\$\{A_U0_MARK\}"/.test(line))
      expect(assertions).toHaveLength(2)
      const declaration = (body: string, name: string) => {
        const match = body.match(new RegExp(`^${name}\\(\\) \\{\n[\\s\\S]*?^\\}`, 'm'))
        if (!match) throw new Error(`Missing test29 drop declaration: ${name}`)
        return match[0]
      }
      const script = [
        'set -euo pipefail', 'A_U0_MARK=0 EVENT_WAIT_S=15',
        'fail() { printf "%s\\n" "$1" >&2; exit 1; }',
        'wait_until() { shift 2; "$@"; }', // evidence is settled; no wall-clock wait
        ...['matcher', 'matcher_text', '_scenario_scan', 'count_in'].map(name => declaration(helpers, name)),
        ...['plain_drop', 'count_since', 'count_since_at_least', 'wait_since', 'expect_since'].map(name => declaration(source, name)),
        ...source.split('\n').filter(line => /^DROP_[A-Z_]+=/.test(line)),
        ...assertions,
      ].join('\n')
      const legacy = formatPersonaDiagnostic({ class: UNCLAIMED_CHANNEL, key: 'alpha', name: 'alpha', index: 0, cause: unclaimedChannelCause(channel) })
      const check = (lines: string[]) => {
        writeFileSync(join(home, 'server.log'), lines.join('\n') + '\n')
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', timeout: 5000,
          env: hostSafeChildEnv(home, { tools: ['awk', 'tail'], extras: {
            SCENARIO_ROOT: home, SLACK_STATE_DIR: home, SCENARIO_SEP: '\x1f',
            ALPHA_REF: renderPersonaRef('alpha', 'alpha'), U0: channel, U0_UNCLAIMED: legacy,
          } }),
        })
        assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
        return result.status
      }
      expect(check(drops)).toBe(0)
      for (const invalid of [[], drops.slice(0, 1), [...drops, drops[0]!], [legacy, legacy],
        drops.map(line => line.replaceAll(channel, eligible)), drops.map(line => line.replaceAll('alpha', 'bravo'))]) {
        expect(check(invalid)).not.toBe(0)
      }
      // Missing evidence is a hold, distinct from the established absence above.
      const queues = structuredClone(['alpha', 'bravo'].map(key => managed.queued(key)))
      f.membership.invalidate('alpha')
      await stub.socket.deliver(message)
      expect(stub.socket.acks).toHaveLength(3)
      expect(managed.logs).toEqual(drops)
      expect(['alpha', 'bravo'].map(key => managed.queued(key))).toEqual(queues)
      assertNoLeak({ captured: f.captured(), logs: managed.logs, routerLines, initial, inventory, log: writtenFile(join(home, 'server.log')) })
      expect(JSON.stringify(managed.logs)).not.toContain('original')
    } finally {
      await managed.close(); await f.close(); resetRoutingState()
      expect(f.h.clock.pendingCount()).toBe(0)
      rmSync(home, { recursive: true, force: true })
    }
  })
  test('test29 actual discovery and phase-A oracle agree, retain an unlisted control and preserve choices across both mode switches', async () => {
    const { makeMembershipHarness, membershipPage } = await import('./test-helpers/shared-channels.ts')
    const home = mkdtempSync(join(tmpdir(), 'phase-a-inventory-')), f = makeMembershipHarness(home, { names: ['alpha', 'bravo'] })
    const check = source.slice(source.indexOf('check_phase_a_inventory() {'), source.indexOf('\ncheck_phase_a_inventory ||'))
    const checkBody = `${check}\nwrite_persona_config() { check_phase_a_inventory; }`
    try {
      const initial = build('declarative', builder, home), inventory = build('declarative', `${control}\nwrite_persona_config() { :; }`, home)
      expect(initial.status).toBe(0); expect(inventory.status).toBe(0)
      assertNoLeak({ initial, inventory })
      writeFileSync(join(home, 'config.json'), initial.stdout)
      expect(f.authority.applyReviewed(Buffer.from(initial.stdout), f.authority.revision).kind).toBe('applied')
      const tokens = JSON.parse(inventory.stdout).tokens as Array<{ label: string; memberships: string[] }>
      for (const token of tokens) {
        expect(token.memberships).not.toContain(ids.U0!)
        f.h.stub(f.h.p(token.label)).script.inventory.push(membershipPage(token.memberships))
      }
      await f.start(); await f.scan()
      for (const key of ['alpha', 'bravo']) {
        expect(f.scanner.status(key).state).toBe('complete')
        expect(f.authority.snapshot().personas[key]!.assignments[ids.U1!]?.delivery).toBe('off')
        expect(f.authority.snapshot().personas[key]!.assignments[ids.U0!]).toBeUndefined()
      }
      expect(build('declarative', checkBody, home).status).toBe(0)
      const strict = f.authority.snapshot()
      expect(f.assign(ids.U1!, 'mentions').kind).toBe('applied')
      expect(build('declarative', checkBody, home).status).not.toBe(0)
      expect(f.assign(ids.U1!, 'off').kind).toBe('applied')
      expect(build('declarative', checkBody, home).status).toBe(0)
      expect(f.assign(ids.U0!, 'off').kind).toBe('applied')
      expect(build('declarative', checkBody, home).status).not.toBe(0)
      // Resume the untouched strict authority, then use the actual builders.
      const authority = createSharedChannelAuthority(f.authority.path, strict)
      for (const mode of ['fungible', 'switch-off']) {
        const next = build(mode, builder, home)
        expect(next.status).toBe(0)
        expect(authority.applyReviewed(Buffer.from(next.stdout), authority.revision).kind).toBe('applied')
        for (const key of ['alpha', 'bravo']) {
          expect(authority.snapshot().personas[key]!.assignments[ids.U0!]).toBeUndefined()
          expect(authority.snapshot().personas[key]!.assignments[ids.U1!]?.delivery).toBe('all')
          expect(authority.snapshot().personas[key]!.assignments[ids.F1!]?.delivery).toBe(mode === 'fungible' ? 'mentions' : 'all')
        }
        expect(authority.snapshot().personas.alpha!.assignments[ids.F2!]?.delivery).toBe('off')
        expect(authority.snapshot().personas.bravo!.assignments[ids.F2!]?.delivery).toBe('mentions')
        if (mode === 'fungible') for (const key of ['alpha', 'bravo']) {
          expect(authority.assign(key, authority.incarnation(key)!, ids.F1!, 'all', authority.revision).kind).toBe('applied')
        }
      }
      assertNoLeak(f.captured())
    } finally { await f.close(); expect(f.h.clock.pendingCount()).toBe(0); rmSync(home, { recursive: true, force: true }) }
  })
})

describe('test29 negotiated schema protocol', () => {
  const scenario = readFileSync(join(import.meta.dir, 'integration/test-29-invited-channels.sh'), 'utf8')
  const helpers = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
  const stub = readFileSync(join(import.meta.dir, 'integration/fixtures/stub-mcp-session.ts'), 'utf8')
  const schemaCheck = scenario.slice(scenario.indexOf('SCHEMA_RESULT='), scenario.indexOf('\nexpect_tool "phase A:'))
  // Execute the actual declarations and dispatch body, never the image-only
  // entry points. Only the poll wait and client transport are injected.
  function dispatcher(client: object, source = stub) {
    const declarations = source.slice(source.indexOf('/** One request from the request file'), source.indexOf('\nasync function main('))
    const call = source.slice(source.indexOf('  const call = async (request:'), source.indexOf('\n  /** One poll:'))
    expect(declarations).not.toBe(''); expect(call).not.toBe('')
    const js = ts.transpileModule(`${declarations}\n${call}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    return new Function('client', `let inFlight, result; const describe = String;
      const answer = (id, line) => { result = { id, ...line }; };
      ${js}
      return async line => { const request = parseRequest(line);
        if ('invalid' in request) throw new Error(request.invalid);
        result = undefined; await call(request); return result; };`)(client) as (line: string, root?: string) => Promise<Record<string, unknown>>
  }
  // The same parser and dispatch with the client's own arguments-file reader
  // and limits, over the exchange's stub directory and working-directory key.
  function fileDispatcher(client: object, source = stub) {
    const declarations = source.slice(source.indexOf('/** One request from the request file'), source.indexOf('\nasync function main('))
    const call = source.slice(source.indexOf('  const call = async (request:'), source.indexOf('\n  /** One poll:'))
    const limits = ['ARGUMENTS_PREFIX', 'ARGUMENTS_SUFFIX', 'ARGUMENTS_FILE_MAX_BYTES'].map(name => source.match(new RegExp(`^const ${name} = .+$`, 'm'))![0])
    const js = ts.transpileModule(`${limits.join('\n')}\n${declarations}\n${call}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const workKey = (root: string) => createHash('sha256').update(realpathSync(join(root, 'work')), 'utf8').digest('hex')
    return new Function('client', 'lstatSync', 'readFileSync', 'join', 'workKey', `let inFlight, result; const describe = String;
      const answer = (id, line) => { result = { id, ...line }; };
      ${js}
      return async (line, root) => { const request = parseRequest(line, argumentsFileReader(join(root, 'stub'), workKey(root)));
        if ('invalid' in request) throw new Error(request.invalid);
        result = undefined; await call(request); return result; };`)(client, lstatSync, readFileSync, join, workKey) as (line: string, root?: string) => Promise<Record<string, unknown>>
  }
  async function exchange(command: string, dispatch: ReturnType<typeof dispatcher>, extras: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'schema-protocol-'))
    mkdirSync(join(root, 'stub')); mkdirSync(join(root, 'work'))
    writeFileSync(join(root, 'stub/stub-mcp-session.ts'), '')
    const declarations = helpers.slice(helpers.indexOf('SCENARIO_STUB_DELIVERIES_PREFIX='), helpers.indexOf('\n# fmk mode setup'))
    const child = Bun.spawn(['/bin/bash', '--noprofile', '--norc', '-euc', `
SCENARIO_ROOT="$FIXTURE_ROOT" SCENARIO_STUB_DIR="$FIXTURE_ROOT/stub"
SCENARIO_STUB_MCP_SRC=stub-mcp-session.ts SCENARIO_TAG=fixture SCENARIO_POLL_S=0
ALPHA_DIR="$FIXTURE_ROOT/work"
fail() { printf '%s\\n' "$1" >&2; exit 1; }
require_ci_image() { printf 'checked\\n' >> "$FIXTURE_ROOT/guards"; }
_scenario_now_ms() { printf 0; }
sleep() {
    local path response
    for path in "$SCENARIO_STUB_DIR"/stub-mcp-requests.*.jsonl; do cat "$path" >&2; done
    IFS= read -r response || exit 1
    printf '%s\\n' "$response" >> "\${path/stub-mcp-requests./stub-mcp-results.}"
}
${declarations}
${command}`], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 5000,
      env: hostSafeChildEnv(root, { tools: ['cat', 'jq', 'realpath', 'sha256sum', 'cut', 'grep'], extras: { FIXTURE_ROOT: root, ...extras } }),
    })
    // Every file the exchange wrote, arguments files included, by name and content.
    const written = () => Object.fromEntries(readdirSync(join(root, 'stub')).filter(p => p !== 'stub-mcp-session.ts')
      .map(p => [p, readFileSync(join(root, 'stub', p), 'utf8')]))
    // Captures, partial output and any caught error are leak-checked with the
    // written files on every path, failures included, before the root goes.
    const requests: unknown[] = [], responses: unknown[] = [], errors: string[] = [], caught: unknown[] = []
    const output = new Response(child.stdout).text()
    let pending = '', stdout = ''
    try {
      // The injected wait hands the already persisted request to this process;
      // the real stub parser/dispatch returns its correlated result via stdin.
      for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) {
        pending += chunk
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1)
          if (!line.startsWith('{')) { errors.push(line); continue }
          requests.push(JSON.parse(line))
          const result = await dispatch(line, root)
          responses.push(result)
          child.stdin.write(JSON.stringify(result) + '\n'); await child.stdin.flush()
        }
      }
      expect(pending).toBe('')
      const status = await child.exited
      stdout = await output
      const files = written()
      return { status, stdout, errors, requests, responses, recordCount: Object.keys(files).filter(p => p.endsWith('.jsonl')).length, files }
    } catch (error) {
      caught.push(error)
      throw error
    } finally {
      try {
        try { child.stdin.end() } catch (error) { caught.push(error) }
        child.kill(); await child.exited
        stdout = await output.catch(error => { caught.push(error); return stdout })
        assertNoLeak({ requests, responses, errors, pending, stdout, caught, files: written() })
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
  }

  test.each(['strict', 'open'] as const)('%s runs test29 schema assertion through the shell request, stub parser and negotiated SDK listing', async channel_mode => {
    const { makeReloadHarness } = await import('./test-helpers/reload-harness.ts')
    const h = makeReloadHarness()
    try {
      const alpha = h.persona('alpha'); h.materialize(alpha)
      h.writeConfig({ channel_mode, personas: [alpha] })
      const run = await h.start({ realLifecycle: true }); run.registerSession('alpha')
      let listings = 0, calls = 0
      const dispatch = dispatcher({
        listTools: () => { listings++; return run.listTools('alpha') },
        callTool: () => { calls++; throw new Error('schema discovery must not call a tool') },
      })
      const result = await exchange(schemaCheck, dispatch)
      expect(result.errors).toEqual([]); expect(result.status).toBe(0)
      expect(listings).toBe(1); expect(calls).toBe(0)
      expect(result.requests).toHaveLength(1)
      expect(result.requests[0]).toEqual({ id: expect.any(String), method: 'tools/list' })
      expect(result.responses[0]).toMatchObject({ id: (result.requests[0] as { id: string }).id, isError: false })

      // Keep the schema oracle sensitive to actual negotiated omissions. These
      // controls change only the SDK result, never replace it with a local schema.
      for (const omission of ['tool', 'attempt_id', 'intent', 'delivery'] as const) {
        const broken = dispatcher({ listTools: async () => {
          const listing = structuredClone(await run.listTools('alpha'))
          if (omission === 'tool') listing.tools = listing.tools.filter(t => t.name !== 'set_channel_delivery')
          else {
            const schema = listing.tools.find(t => t.name === 'set_channel_delivery')!.inputSchema
            if (omission === 'delivery') (schema.properties!.delivery as { enum: string[] }).enum.pop()
            else schema.required = schema.required!.filter(field => field !== omission)
          }
          return listing
        } })
        const rejected = await exchange(schemaCheck, broken)
        expect(rejected.status).toBe(1)
        expect(rejected.errors).toEqual([omission === 'tool' ? 'missing negotiated tool' : 'negotiated attempt schema differs'])
      }
      assertNoLeak(run.captured({ result }))
    } finally { await h.cleanup() }
  })

  test.each(['tools/list', 'bad/name', '', 'x'.repeat(129)])('tool calls still reject invalid tool name %s before writing a request', async tool => {
    const result = await exchange('stub_session_call "$ALPHA_DIR" "$CALL_TOOL" "{}"', dispatcher({}), { CALL_TOOL: tool })
    expect(result.status).toBe(1); expect(result.errors.join('\n')).toContain('is not a tool name')
    expect(result.requests).toEqual([]); expect(result.responses).toEqual([]); expect(result.recordCount).toBe(0)
  })

  test('the original test29 tools/list-as-tool invocation remains rejected by the retained validator', async () => {
    const original = schemaCheck.replace('stub_session_list_tools "${ALPHA_DIR}"', 'stub_session_call "${ALPHA_DIR}" tools/list \'{}\'')
    expect(original).not.toBe(schemaCheck)
    const result = await exchange(original, dispatcher({}))
    expect(result.status).toBe(1); expect(result.errors.join('\n')).toContain("'tools/list' is not a tool name")
    expect(result.requests).toEqual([]); expect(result.recordCount).toBe(0)
  })

  test('tool-call records retain assignment and retry arguments and correlated results through the real stub dispatch', async () => {
    const { deliveryAttempt, retryAttempt, SHARED_CHANNEL_IDS } = await import('./test-helpers/shared-channels.ts')
    const { SET_CHANNEL_DELIVERY_TOOL } = await import('../src/channel-delivery.ts')
    const assignment = deliveryAttempt('retained-protocol-attempt', SHARED_CHANNEL_IDS.primary, 'off')
    const calls: unknown[] = []
    const dispatch = dispatcher({ callTool: async (request: unknown) => {
      calls.push(request); return { isError: false, content: [{ type: 'text', text: 'fixture result' }] }
    } })
    for (const args of [assignment, retryAttempt(assignment)]) {
      const result = await exchange('stub_session_call "$ALPHA_DIR" "$CALL_TOOL" "$CALL_ARGS"', dispatch,
        { CALL_TOOL: SET_CHANNEL_DELIVERY_TOOL, CALL_ARGS: JSON.stringify(args) })
      expect(result.status).toBe(0); expect(result.errors).toEqual([])
      expect(result.requests).toEqual([{ id: expect.any(String), method: 'tools/call', tool: SET_CHANNEL_DELIVERY_TOOL, arguments: args }])
      expect(JSON.parse(result.stdout)).toEqual({ id: (result.requests[0] as { id: string }).id, isError: false, text: 'fixture result' })
    }
    expect(calls).toEqual([assignment, retryAttempt(assignment)].map(args => ({ name: SET_CHANNEL_DELIVERY_TOOL, arguments: args })))
    assertNoLeak(calls)
  })

  test('listing errors fail the schema assertion instead of becoming an empty successful listing', async () => {
    const result = await exchange(schemaCheck, dispatcher({ listTools: async () => { throw new Error('fixture listing failure') } }))
    expect(result.status).toBe(1); expect(result.errors).toEqual(['missing negotiated tool'])
    expect(result.responses).toEqual([{ id: expect.any(String), isError: true, text: '', error: 'Error: fixture listing failure' }])
  })

  // test-46 Phase 19's reply: two parts that exceed the default reply chunk
  // limit together, too long for one request line.
  const longReply = { chat_id: 'C0CHUNK0001', text: `${'abcdefgh'.repeat(375)}\n${'ijklmnop'.repeat(375)}` }
  test('an oversized inline tool request is still refused before anything is written, and the refusal never quotes its arguments', async () => {
    const args = { ...longReply, text: `${longReply.text} ${fakeToken(BOT_TOKEN_PREFIX, 'inline-refusal')}` }
    const result = await exchange('stub_session_call "$ALPHA_DIR" reply "$CALL_ARGS"', dispatcher({}), { CALL_ARGS: JSON.stringify(args) })
    expect(result.status).toBe(1)
    expect(result.errors).toEqual([expect.stringMatching(/ reply: the request line takes \d+ bytes; at most 3999 reach the file in one write$/)])
    expect(result.requests).toEqual([]); expect(result.files).toEqual({})
  })

  test('test-46 Phase 19\'s 6,001-character reply reaches the tool whole through its arguments file, on a request line within the bound', async () => {
    expect(longReply.text).toHaveLength(6001)
    const calls: unknown[] = []
    const dispatch = fileDispatcher({ callTool: async (request: unknown) => {
      calls.push(request); return { isError: false, content: [{ type: 'text', text: 'fixture result' }] }
    } })
    const result = await exchange('stub_session_call "$ALPHA_DIR" reply "$CALL_ARGS" arguments-file', dispatch, { CALL_ARGS: JSON.stringify(longReply) })
    expect(result.status).toBe(0); expect(result.errors).toEqual([])
    expect(result.requests).toEqual([{ id: expect.any(String), method: 'tools/call', tool: 'reply', arguments_file: expect.any(String) }])
    const request = result.requests[0] as { id: string; arguments_file: string }
    expect(request.arguments_file).toMatch(new RegExp(`^stub-mcp-arguments\\.[0-9a-f]{64}\\.${request.id.replace(/[.]/g, '\\.')}\\.json$`))
    expect(JSON.stringify(request).length + 1).toBeLessThan(4000)
    expect(result.files[request.arguments_file]).toBe(`${JSON.stringify(longReply)}\n`)
    expect(calls).toEqual([{ name: 'reply', arguments: longReply }])
    expect(JSON.parse(result.stdout)).toEqual({ id: request.id, isError: false, text: 'fixture result' })
  })

  test.each([
    ['not a JSON object', '"$CALL_ARGS"', ': the arguments are not a JSON object'],
    ['over the arguments-file bound', '"$(jq -cn --arg t "$CALL_ARGS" \'{text: ($t + ("x" * 70000))}\')"', ': the arguments take 70'],
  ])('a request is refused before anything is written when its arguments for a file are %s, and the refusal never quotes them', async (_name, args, reason) => {
    const plant = fakeToken(BOT_TOKEN_PREFIX, 'file-refusal')
    const result = await exchange(`stub_session_call "$ALPHA_DIR" reply ${args} arguments-file`, fileDispatcher({}),
      { CALL_ARGS: args === '"$CALL_ARGS"' ? JSON.stringify([plant]) : plant })
    expect(result.status).toBe(1); expect(result.errors).toEqual([expect.stringContaining(reason)])
    expect(result.requests).toEqual([]); expect(result.files).toEqual({})
  })

  test('the client reads only the request\'s own arguments file, as a regular file within the bound, and its refusals never quote the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'arguments-file-'))
    const refusals: string[] = []
    try {
      mkdirSync(join(root, 'stub')); mkdirSync(join(root, 'work'))
      const key = createHash('sha256').update(realpathSync(join(root, 'work')), 'utf8').digest('hex')
      const secret = fakeToken(BOT_TOKEN_PREFIX, 'arguments-file')
      const name = (id: string) => `stub-mcp-arguments.${key}.${id}.json`
      const line = (id: string, fields: Record<string, unknown> = { arguments_file: name(id) }) => JSON.stringify({ id, method: 'tools/call', tool: 'reply', ...fields })
      writeFileSync(join(root, 'stub', name('other')), JSON.stringify({ text: secret }))
      writeFileSync(join(root, 'stub', name('notjson')), `{"text":"${secret}"`)
      writeFileSync(join(root, 'stub', name('array')), JSON.stringify([secret]))
      writeFileSync(join(root, 'stub', name('large')), JSON.stringify({ text: `${secret}${'x'.repeat(65_536)}` }))
      symlinkSync(join(root, 'stub', name('other')), join(root, 'stub', name('link')))
      writeFileSync(join(root, 'outside.json'), JSON.stringify({ text: secret }))
      const dispatch = fileDispatcher({ callTool: async () => { throw new Error('a refused request must not call a tool') } })
      const notOwn = '"arguments_file" is not this request\'s arguments file'
      for (const [text, reason] of [
        [line('mine', { arguments_file: name('other') }), notOwn],
        [line('mine', { arguments_file: '../outside.json' }), notOwn],
        [line('missing'), 'the arguments file could not be read'],
        [line('link'), 'the arguments file is not a regular file'],
        [line('notjson'), 'the arguments file is not JSON'],
        [line('array'), '"arguments" is not a JSON object'],
        [line('large'), 'the arguments file is too large'],
        [line('other', { arguments: {}, arguments_file: name('other') }), 'a request takes "arguments" or "arguments_file", not both'],
        [JSON.stringify({ id: 'other', method: 'tools/list', arguments_file: name('other') }), 'tools/list takes no tool or arguments'],
      ] as const) {
        const error = await dispatch(text, root).then(() => undefined, (e: Error) => e)
        refusals.push(error?.message ?? 'accepted')
        expect(error?.message).toBe(reason)
      }
      // The same reader accepts the request's own regular file.
      const own = await fileDispatcher({ callTool: async (request: unknown) => ({ isError: false, content: [{ type: 'text', text: JSON.stringify(request).length.toString() }] }) })(line('other'), root)
      expect(own).toEqual({ id: 'other', isError: false, text: String(JSON.stringify({ name: 'reply', arguments: { text: secret } }).length) })
    } finally {
      try { assertNoLeak({ refusals }) } finally { rmSync(root, { recursive: true, force: true }) }
    }
  })

  test.each([
    { method: 'tools/call', tool: 'tools/list', arguments: {} },
    { method: 'tools/list', tool: 'set_channel_delivery', arguments: {} },
    { method: 'unknown' },
  ])('the actual stub parser refuses an invalid method/tool envelope: %j', async fields => {
    await expect(dispatcher({})(JSON.stringify({ id: 'fixture-invalid', ...fields }))).rejects.toThrow()
  })
})

test('test29 restart authority assertion accepts fresh inventory but detects changed choices, identities, reviewed bytes and invalid state', async () => {
  const { isDeepStrictEqual } = await import('node:util')
  const { dirname } = await import('node:path')
  const config = await import('../src/config.ts')
  const shared = await import('../src/shared-channels.ts')
  const { makeMembershipHarness, membershipPage, SHARED_CHANNEL_IDS: ids } = await import('./test-helpers/shared-channels.ts')
  const root = mkdtempSync(join(tmpdir(), 'restart-authority-'))
  const f = makeMembershipHarness(root)
  try {
    f.h.stub(f.h.p('alpha')).script.inventory.push(membershipPage([ids.primary]))
    await f.start(); await f.scan(); f.assign(ids.primary, 'off')
    const input = join(root, 'config.json'), before = join(root, 'before.json')
    writeFileSync(input, f.authority.sourceBytes()); writeFileSync(before, readFileSync(f.authority.path))
    const source = readFileSync(join(import.meta.dir, 'integration/fixtures/fmk-texts.ts'), 'utf8')
    const declarations = source.slice(source.indexOf('async function readSharedConfiguration('), source.indexOf('const sharedAuthorityStartLine: Entry'))
    const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const modules: Record<string, Record<string, unknown>> = { 'config.ts': config, 'shared-channels.ts': shared }
    const printer = new Function('packageFunction', 'expectArguments', 'PrinterFailure', 'PRINTER_FAIL_EXIT', 'isDeepStrictEqual', 'dirname', 'Buffer',
      'copyFileSync', 'mkdtempSync', 'rmSync', 'tmpdir', 'join', `${compiled}\nreturn sharedAuthorityPreserved;`)(
      async (_context: unknown, file: string, name: string) => { expect(modules[file]?.[name]).toBeTypeOf('function'); return modules[file]![name] },
      (_entry: string, args: string[], expected: string[]) => expect(args).toHaveLength(expected.length),
      Error, 1, isDeepStrictEqual, dirname, Buffer, copyFileSync, mkdtempSync, rmSync, () => root, join,
    ) as { print(args: string[], context: object): Promise<string> }
    const args = [input, before, f.authority.path]
    f.h.stub(f.h.p('alpha')).script.inventory.push(membershipPage([ids.primary]))
    f.scanner.request('alpha'); await f.scan()
    expect(readFileSync(before).equals(readFileSync(f.authority.path))).toBe(false)
    expect(await printer.print(args, {})).toBe('')
    assertNoLeak({ captured: f.captured(), input: writtenFile(input), before: writtenFile(before) })
    for (const mutation of ['choice', 'identity', 'installation', 'reviewed-bytes', 'invalid'] as const) {
      const original = shared.parseSharedChannelState(readFileSync(before), f.authority.path)!
      const authority = createSharedChannelAuthority(f.authority.path, original)
      if (mutation === 'choice') authority.assign('alpha', authority.incarnation('alpha')!, ids.primary, 'all', authority.revision)
      if (mutation === 'identity') {
        const source = structuredClone(original.source)
        ;(source.personas as Array<Record<string, unknown>>)[0]!.working_directory = join(root, 'replacement')
        authority.applyReviewed(configBytes(source), authority.revision)
      }
      if (mutation === 'installation') expect(authority.observeMembership('alpha', authority.incarnation('alpha')!, {
        event: 'EvREPLACED', channel: ids.primary, member: true, identity: JSON.stringify(['T0OTHER', 'A0OTHER', 'U0OTHER', 'B0OTHER']),
        boundary: original.personas.alpha!.membership[ids.primary]!.boundary,
      }, authority.revision).kind).toBe('applied')
      if (mutation === 'reviewed-bytes') authority.applyReviewed(Buffer.concat([authority.sourceBytes(), Buffer.from('\n')]), authority.revision)
      // Inspect each valid written authority before intentionally corrupting
      // it or replacing it on the next iteration.
      assertNoLeak(writtenFile(f.authority.path))
      if (mutation === 'invalid') writeFileSync(f.authority.path, '{')
      await expect(printer.print(args, {})).rejects.toThrow()
    }
    const scenario = readFileSync(join(import.meta.dir, 'integration/test-29-invited-channels.sh'), 'utf8')
    expect(scenario).toContain('sharedAuthorityPreserved "${CONFIG}" "${STORE_BEFORE_RESTART}" "${STORE_FILE}"')
    expect(scenario).not.toContain('cmp -s -- "${STORE_FILE}" "${STORE_BEFORE_RESTART}"')
    assertNoLeak({ logs: f.lines, manager: f.h.lines, statuses: f.h.statuses })
  } finally { await f.close(); expect(f.h.clock.pendingCount()).toBe(0); rmSync(root, { recursive: true, force: true }) }
})

// Execute only extracted shell declarations with inert AD/receipt/Slack stubs.
// These controls never source a scenario, start a native agent or grant readiness.
describe('latency admission wiring', () => {
  const realScenario = readFileSync(join(import.meta.dir, 'integration/lib/real-scenario.sh'), 'utf8')
  const orderScenario = readFileSync(join(import.meta.dir, 'integration/test-32-fmk-real-order.sh'), 'utf8')
  const receipts = readFileSync(join(import.meta.dir, 'integration/fixtures/transcript-receipts.ts'), 'utf8')
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cscb-latency-wiring-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })
  const run = (code: string) => spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', `set -euo pipefail\n${code}`, 'control', home], {
    encoding: 'utf8', timeout: 5000, env: hostSafeChildEnv(home),
  })
  const latencyLoop = (source: string) => {
    const start = source.lastIndexOf('for n in {1..20}; do'), end = source.indexOf('\n\ncase_assert launches', start)
    if (start < 0 || end < start) throw new Error('Missing complete 20-sample phase')
    return source.slice(start, end)
  }
  const runLoop = (source: string, blocked = 0) => run(`
REAL_KEY=alpha
REAL_LABEL=alpha
real_wait_latency_admission() { printf 'ready:%s\\n' "$2"; [[ "$2" != '${blocked}' ]]; }
real_wait_idle() { printf 'idle\\n'; }
real_dm() { printf 'dm:%s\\n' "$n"; }
real_wait_delivery() { printf 'delivered:%s\\n' "$2"; }
real_assert_latency() { printf 'latency:%s\\n' "$2"; }
${latencyLoop(source)}
`)
  const expectedLoop = Array.from({ length: 20 }, (_, i) => [`ready:${33 + i}`, `dm:${i + 1}`, `delivered:${34 + i}`]).flat().concat('latency:20', '').join('\n')
  test('all 20 original samples require admission and delivery, with no skipped/filtered/retried input', () => {
    const result = runLoop(orderScenario)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(expectedLoop)
    expect(result.stderr).toBe('')
    const blocked = runLoop(orderScenario, 35)
    expect(blocked.status).toBe(1)
    expect(blocked.stdout.trim().split('\n')).toEqual(expectedLoop.split('\n').slice(0, 7))
    expect(orderScenario).toContain('case_assert reply-permission-resume "${REAL_KILLED_ROW}" "${SCENARIO_ROOT}/relaunch-${REAL_KEY}.json"\nreal_wait_delivery "${REAL_KEY}" 33')
    expect(orderScenario).toContain("real_persona order 'For every relayed Slack message, call the Slack reply tool with text exactly OK")
    expect(orderScenario).toContain('for n in {1..20}; do real_dm "${REAL_LABEL}" "fault order ${n}"; done')
  })
  test.each(['waiting only', 'omitted admission', 'fewer samples', 'ignored admission failure'])('loop audit rejects %s', mutation => {
    let source = orderScenario
    if (mutation === 'waiting only') source = source.replace('real_wait_latency_admission "${REAL_KEY}" "$((33+n-1))"', 'real_wait_idle "${REAL_KEY}"')
    if (mutation === 'omitted admission') source = source.replace('real_wait_latency_admission "${REAL_KEY}" "$((33+n-1))"', ':')
    if (mutation === 'fewer samples') source = source.replace('real_assert_latency "${REAL_KEY}" 20', 'real_assert_latency "${REAL_KEY}" 19')
    if (mutation === 'ignored admission failure') source = source.replace('real_wait_latency_admission "${REAL_KEY}" "$((33+n-1))"', 'real_wait_latency_admission "${REAL_KEY}" "$((33+n-1))" || true')
    expect(source).not.toBe(orderScenario)
    const result = runLoop(source, mutation === 'ignored admission failure' ? 35 : 0)
    if (mutation === 'ignored admission failure') expect(result.status).not.toBe(1)
    else expect(result.stdout).not.toBe(expectedLoop)
  })
  test.each([
    [2000, 10000, 20, true], [2000.001, 10000, 20, false], [2000, 10000.001, 20, false], [1, 1, 19, false],
  ])('actual latency CLI keeps typing=%s delivery=%s count=%s boundary', (typing, delivery, count, passes) => {
    const block = receipts.match(/const n = Number\(count\)[\s\S]*?if \(typing > 2000 \|\| delivery > 10000\) throw new Error\('[^']*latency exceeded'\)/)?.[0]
    expect(block).toBeDefined()
    const output: string[] = []
    const check = () => new Function('result', 'count', 'percentile', 'console', block!)({ timings:
      Array.from({ length: Number(count) }, (_, i) => ({ typing_ms: i < 18 ? 1 : typing, delivery_ms: i < 18 ? 1 : delivery })) },
    20, percentile, { log: (line: string) => output.push(line) })
    if (passes) { expect(check).not.toThrow(); expect(output[0]).toContain('samples=20') }
    else expect(check).toThrow(count === 19 ? 'Insufficient latency samples' : 'latency exceeded')
  })
})


describe('shared scenario consumer evidence boundaries', () => {
  const integration = join(import.meta.dir, 'integration')
  const recovery = readFileSync(join(integration, 'test-46-shared-channel-recovery.sh'), 'utf8')
  const healthy = readFileSync(join(integration, 'test-29-invited-channels.sh'), 'utf8')
  const clean = (source: string) => source.replace(/\\\n\s*/g, ' ').split('\n')
    .filter(line => !line.trim().startsWith('#')).map(line => line.trim()).join('\n')
  const fn = (source: string, name: string) => source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0] ?? ''
  const ordered = (source: string, pieces: string[]) => {
    let offset = 0
    for (const piece of pieces) {
      const at = source.indexOf(piece, offset)
      if (at < 0) return false
      offset = at + piece.length
    }
    return true
  }
  function recoveryFindings(source: string): string[] {
    const findings: string[] = [], pending = clean(fn(source, 'pending_post')), hold = clean(fn(source, 'post_hold')), all = clean(source)
    const exact = 'shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" unresolved'
    if (!ordered(pending, [
      'OP_STAMP="$(stamp p "${OP_CHANNEL}")"', 'before="$(shared_own_post_records',
      'OP_CALL="$(stub_session_submit', 'OP_ID="$(jq -ser --argjson before "${before}" --arg c "${OP_CHANNEL}" --argjson stamp "${OP_STAMP}"',
      '.operationId as $id|$before|index($id)|not', 'length==1 and .[0].channel==$c and .[0].stamp==$stamp',
      '.incarnation==$stamp.incarnation and .assignments[$channel].threadHybridSince==$stamp.threadHybridSince',
      exact + '  > "${EVIDENCE}/post-${case_name}-unresolved.json"',
    ])) findings.push('pending post lacks independent identity/stamp or exact unresolved observation')
    if (!ordered(hold, [
      '.operations==[$operation] and .stamp==$stamp',
      '.incarnation==$stamp.incarnation and .assignments[$channel].threadHybridSince==$stamp.threadHybridSince',
      exact + '  > "${EVIDENCE}/post-${case_name}-held-unresolved.json"',
    ])) findings.push('post hold lacks exact operation/stamp or unresolved observation')
    // Each composed crash first reaches the guarded pending_post declaration.
    for (const pair of [
      ['pending_post "recovered-${performed}" "${performed}"', 'post_hold "recovered-${performed}"'],
      ['pending_post "lookup-${problem}" true'], ['pending_post stale-value true'],
      ['pending_post ambiguous true'], ['pending_post "identity-${reset}" true'],
    ]) {
      const start = all.indexOf(pair[0]!), end = all.indexOf('\ncrash', start)
      if (start < 0 || end < 0 || !ordered(all.slice(start, end), pair)) findings.push('missing pending/crash boundary: ' + pair[0])
    }
    const leave = all.slice(all.indexOf('for boundary in before after; do'), all.indexOf('pending_post stale-value true'))
    if (!ordered(leave, [
      'pending_post "leave-${boundary}" true', 'post_hold "leave-${boundary}"',
      'old_channel="${OP_CHANNEL}"; old_stamp="${OP_STAMP}"',
      'no_ack "${leave}"',
      'shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${old_channel}" "${old_stamp}" unresolved  > "${EVIDENCE}/leave-before-kill-intent.json"',
      'ack "${leave}"',
      'shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${old_channel}" "${old_stamp}" unresolved  > "${EVIDENCE}/leave-after-kill-historical-intent.json"',
      '\ncrash',
    ])) findings.push('leave boundary lacks historical exact observation')
    for (const [start, target] of [
      ['pending_post live-hold true', 'post-live-hold-after-receipts.json'],
      ['pending_post confirmed-unsaved true 25000', 'confirmed-unsaved-before-kill.json'],
    ]) {
      const begin = all.indexOf(start), end = all.indexOf('\ncrash', begin)
      const boundary = all.slice(begin, end)
      if (begin < 0 || end < 0 || !boundary.includes(exact) || !boundary.includes(target)) findings.push('missing fresh unresolved boundary: ' + target)
    }
    const unresolved = all.split('\n').filter(line => line.startsWith('shared_wait_own_post_state ') && line.includes(' unresolved'))
    if (unresolved.length !== 6 || unresolved.some(line => /\|\||;|&&/.test(line))) findings.push('missing or ignored unresolved assertion')
    return findings
  }
  function healthyFindings(source: string): string[] {
    const findings: string[] = [], all = clean(source), notice = clean(fn(source, 'notice_phase')), queued = clean(fn(source, 'wait_queued'))
    if (!ordered(all, ['shared_stub_permission_setup "${ALPHA_DIR}"', 'shared_stub_permission_setup "${BRAVO_DIR}"',
      'RECEIPT_MODE["${ALPHA_KEY}"]=manual', 'RECEIPT_MODE["${BRAVO_KEY}"]=manual', 'start_server --live'])) findings.push('manual hook setup must precede launch')
    if (!ordered(notice, ['shared_stub_notice end ', 'shared_stub_notice ended ', 'RECEIPT_MODE["${key}"]=ordinary',
      'matrix_message "${phase}-trigger"', 'post="$(slack_wait_messages_waiting', 'ts="$(jq -er \'.ts\' <<< "${post}")"',
      'shared_stub_notice resume '])) findings.push('notice lifecycle or independent successful-post root changed')
    if (!ordered(queued, ['EXPECTED_QUEUE_ROWS["${identity}"]="$(shared_delivery_expectation',
      'EXPECTED_INPUTS["${identity}"]="${PUSHED_EVENTS[$2|$3]}"',
      'if [[ "${RECEIPT_MODE[${QUEUE_KEY[$1]}]:-ordinary}" == manual ]]', 'shared_stub_permission receipt'])) findings.push('independent input/acceptance or manual receipt gate changed')
    const other = clean(fn(source, 'other_value_threads'))
    if (!other.includes('[[ ! -e "${SLACK_STATE_DIR}/threads/${THREAD_KEY}.jsonl" ]]') ||
      !other.includes('[[ "$(shared_thread_created "${THREAD_KEY}")" == false ]]') ||
      !ordered(all, ['other_value_threads "strict: other values" "${ALPHA_LABEL}" "${VIA_RECEIVE_ALL_SHARED}" true', 'ALPHA_THREADS=true'])) findings.push('early persona-wide no-file/no-marker evidence changed')
    if (!ordered(all, ['\nrequest_ms="$(printed MEMBERSHIP_REQUEST_TIMEOUT_MS)"',
      '\nslack_stub_inventory_fault alpha \'\' delay "delay_ms=$(( request_ms * 4 / 5 ))"\n',
      '[[ "$(slack_stub_record_count fault-settled "request_id=${request_id}")" == 0 ]]',
      'expect_attempt unverified-refusal',
      '[[ "$(slack_stub_record_count fault-settled "request_id=${request_id}")" == 0 ]]',
      'resolution=delay > /dev/null',
      '\nslack_stub_faults_clear alpha\n'])) findings.push('membership refusal is not bracketed by the delayed successful scan')
    return findings
  }
  test('healthy and recovery consumers retain independent observations and fail-closed boundaries', () => {
    expect(recoveryFindings(recovery)).toEqual([])
    expect(healthyFindings(healthy)).toEqual([])
  })
  test.each([
    ['recovery observer', 'recovery', 'shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" unresolved', ':'],
    ['recovery identity', 'recovery', 'OP_STAMP="$(stamp p "${OP_CHANNEL}")"', 'OP_STAMP=from-own-post'],
    ['historical leave stamp', 'recovery', '"${OP_ID}" "${old_channel}" "${old_stamp}" unresolved', '"${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" unresolved'],
    ['manual receipt boundary', 'healthy', 'RECEIPT_MODE["${key}"]=ordinary', ':'],
    ['independent input', 'healthy', 'EXPECTED_INPUTS["${identity}"]="${PUSHED_EVENTS[$2|$3]}"', 'EXPECTED_INPUTS["${identity}"]=queue'],
    ['early marker', 'healthy', '[[ "$(shared_thread_created "${THREAD_KEY}")" == false ]]', 'true'],
    ['unverified scan guard', 'healthy', '[[ "$(slack_stub_record_count fault-settled "request_id=${request_id}")" == 0 ]]', 'true'],
    ['request-deadline delay bound', 'healthy', '"delay_ms=$(( request_ms * 4 / 5 ))"', 'delay_ms=20000'],
    ['printed request deadline', 'healthy', 'request_ms="$(printed MEMBERSHIP_REQUEST_TIMEOUT_MS)"', 'request_ms=20000'],
    ['settled one-shot fault clear', 'healthy', '    slack_stub_faults_clear alpha\n', '    # slack_stub_faults_clear alpha\n'],
  ])('consumer audit detects removed %s in a scratch copy', (_name, kind, needle, replacement) => {
    mkdirSync('/tmp/c9', { recursive: true })
    const root = mkdtempSync('/tmp/c9/consumer-audit-'), path = join(root, 'scenario.sh')
    try {
      const source = kind === 'recovery' ? recovery : healthy
      expect(source).toContain(needle!)
      writeFileSync(path, source.replaceAll(needle!, replacement!))
      const findings = (kind === 'recovery' ? recoveryFindings : healthyFindings)(readFileSync(path, 'utf8'))
      assertNoLeak(findings)
      expect(findings.length).toBeGreaterThan(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('unchanged CI discovery accepts recovery46 exactly once with no duplicate script number', async () => {
    const ci = await import('../scripts/ci-run.ts')
    const entries = ci.readIntegrationEntries(join(import.meta.dir, '..'))
    expect(entries.ok).toBe(true)
    if (!entries.ok) throw new Error('integration directory unreadable')
    expect(ci.checkScriptNames(entries.value)).toEqual([])
    expect(ci.checkDuplicateNumbers(entries.value)).toEqual([])
    const scripts = ci.scriptListOf(entries.value)
    const selected = ci.matchScript('test-46', scripts)
    expect(selected?.fileName).toBe('test-46-shared-channel-recovery.sh')
    expect(ci.matchScript('test-46-shared-channel-recovery.sh', scripts)).toEqual(selected)
    expect(ci.checkDuplicateNumbers([...entries.value, { name: 'test-46-duplicate.sh', kind: 'regular' }])).toHaveLength(1)
  })
})

describe('shared MCP client transport, grouping and session evidence', () => {
  mkdirSync('/tmp/c9', { recursive: true })
  const scratch = mkdtempSync('/tmp/c9/mcp-client-audit-')
  const copy = join(scratch, 'stub-mcp-session.ts')
  writeFileSync(copy, readFileSync(join(import.meta.dir, 'integration/fixtures/stub-mcp-session.ts')))
  const source = readFileSync(copy, 'utf8')
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))
  const declarations = source.slice(source.indexOf('function errorCode('), source.indexOf('\nasync function main('))
  const control = source.slice(source.indexOf('  const parent = parentPid()'), source.indexOf('\n  const schedulePoll'))
  const js = ts.transpileModule(`
  const { Client, StreamableHTTPClientTransport, ListRootsRequestSchema,
    AsyncLocalStorage, pathToFileURL, fetch, readFileSync, appendLine, say, setTimeout, clearTimeout } = deps;
  const url = 'http://127.0.0.1/mcp', cwd = '/scratch/persona';
  const requestsPath = 'requests', resultsPath = 'results', sessionsPath = 'sessions', deliveriesPath = 'deliveries';
  const readArguments = argumentsFileReader('/scratch/stub', 'scratchkey');
  const CLIENT_INFO = {name:'scratch-probe',version:'1'}, CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';
  const NEWLINE = 10;
  ${source.match(/^const ROOTS_READY_TIMEOUT_MS = .+$/m)![0]}
  ${source.match(/^const SUBMISSION_BARRIER_TIMEOUT_MS = .+$/m)![0]}
  const parentPid = () => 1, describe = e => e instanceof Error ? e.name + ': ' + e.message : String(e);
  ${declarations}
  ${control}
  return { connect, poll, parseRequest, end, ended,
    bounds: { roots: ROOTS_READY_TIMEOUT_MS, barrier: SUBMISSION_BARRIER_TIMEOUT_MS },
    close: async () => { end(0, 'probe done'); await client?.close(); } };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const build = new Function('deps', js)
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

  function deferred<T = void>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
  }

  function rpcResponse(id: number | string, result: object, sid?: string) {
    return Response.json({ jsonrpc: '2.0', id, result }, { headers: sid ? { 'mcp-session-id': sid } : {} })
  }

  function harness(files = new Map<string, string>(), respond?: (message: any, sid: string) => Promise<Response> | Response,
    rootGate?: (sid: string) => Promise<void>, Transport = StreamableHTTPClientTransport) {
    const clock = createFakeClock()
    const starts: Array<{ sid: string; name: string; args: unknown }> = []
    const roots: string[] = [], reads: string[] = [], cancels: string[] = [], logs: string[] = [], closed: string[] = []
    const recordWaiters: Array<{event:string, resolve: (value: any) => void}> = []
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
    const observed = (path: string) => (files.get(path) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
    let serial = observed('sessions').filter(x => x.event === 'connected').length
    const appendLine = (path: string, record: any) => {
      files.set(path, (files.get(path) ?? '') + JSON.stringify(record) + '\n')
      for (const waiter of recordWaiters) if (record.event === waiter.event) waiter.resolve(record)
    }
    const toolResponse = (id: number | string, name: string) => {
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: name }] } }))) },
        pull(controller) { controller.close() },
      })
      const cancel = body.cancel.bind(body)
      body.cancel = (reason?: unknown) => { cancels.push(name); return cancel(reason) }
      const response = new Response(body, { headers: { 'content-type': 'application/json' } })
      const json = response.json.bind(response)
      response.json = () => { reads.push(name); return json() }
      return response
    }
    const fakeFetch = async (_input: unknown, init: RequestInit): Promise<Response> => {
      const headers = new Headers(init.headers), sid = headers.get('mcp-session-id') ?? ''
      if (init.method === 'GET') {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.set(sid, controller)
            controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:'roots-'+sid,method:'roots/list'})}\n\n`))
            init.signal?.addEventListener('abort', () => { closed.push(sid); try { controller.close() } catch {} }, { once: true })
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      const message = JSON.parse(String(init.body))
      if (message.method === 'initialize') {
        return rpcResponse(message.id, { protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} }, serverInfo: { name: 'scratch-probe', version: '1' } }, `probe-${++serial}`)
      }
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (message.result?.roots) {
        expect(message.result.roots).toEqual([{ uri: 'file:///scratch/persona', name: '/scratch/persona' }])
        await rootGate?.(sid)
        roots.push(sid)
        return new Response(null, { status: 202 })
      }
      if (message.method === 'notifications/cancelled') return new Response(null, { status: 202 })
      if (message.method === 'tools/list') return rpcResponse(message.id, { tools: [] })
      if (message.method !== 'tools/call') throw new Error('unexpected protocol message')
      expect(roots).toContain(sid)
      starts.push({sid, name: message.params.name, args: message.params.arguments})
      let abort!: () => void
      const stopped = new Promise<Response>((_resolve, reject) => {
        abort = () => reject(new Error('fetch aborted'))
        init.signal?.addEventListener('abort', abort, { once: true })
      })
      try {
        return await Promise.race([Promise.resolve(respond ? respond(message, sid) : toolResponse(message.id, message.params.name)), stopped])
      } finally { init.signal?.removeEventListener('abort', abort) }
    }
    const api: {
      connect: (reason: 'start' | 'lost_response' | 'replacement') => Promise<void>; poll: () => Promise<void>; close: () => Promise<void>;
      parseRequest: (value: string) => any; ended: Promise<number>; end: (code: number, reason: string) => void;
      bounds: { roots: number; barrier: number };
    } = build({ Client: MCPClient, StreamableHTTPClientTransport: Transport, ListRootsRequestSchema, AsyncLocalStorage, pathToFileURL,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      fetch: fakeFetch, appendLine, say: (line: string) => logs.push(line), readFileSync: (path: string, encoding?: string) => {
        const text = files.get(path)
        if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return encoding ? text : Buffer.from(text)
      } })
    cleanups.push(async () => {
      await api.close(); await clock.flush()
      expect(clock.pendingCount()).toBe(0)
      assertNoLeak({ results: observed('results'), sessions: observed('sessions'), logs })
    })
    return { ...api, clock, files, starts, roots, reads, cancels, logs, closed, toolResponse, observed,
      onRecord: (event: string) => new Promise<any>(resolve => recordWaiters.push({event,resolve})),
      write: (requests: unknown[]) => { files.set('requests', requests.map(r => JSON.stringify(r)).join('\n') + '\n') },
      notify: (sid: string, params: object) => streams.get(sid)!.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/claude/channel',params})}\n\n`)),
    }
  }

  const request = (id: string, fields: object = {}) => ({id, method:'tools/call', tool:id, arguments:{attempt_id:'retained',intent:'assignment'}, ...fields})
  const turns = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
  // Feed real captured client output into test29's actual data-only reader.
  // No integration entrypoint or scenario declaration is executed here.
  function test29Records(command: 'skipped' | 'once', files: Record<string, string>) {
    const consumer = readFileSync(join(import.meta.dir, 'integration/test-29-invited-channels.sh'), 'utf8')
      .match(/cat > "\$\{STUB_RECORDS\}" << 'EOF'\n([\s\S]*?)\nEOF/)?.[1]
    expect(consumer).toBeDefined()
    const root = mkdtempSync(join(scratch, 'records-')), reader = join(root, 'reader.py')
    try {
      writeFileSync(reader, consumer!)
      for (const [name, bytes] of Object.entries(files)) writeFileSync(join(root, name), bytes)
      const args = command === 'skipped' ? ['log', 'ids'] : ['requests', 'results']
      const child = spawnSync('python3', [reader, command, ...args.map(name => join(root, name))], {
        encoding: 'utf8', timeout: 2000, env: hostSafeChildEnv(root, { tools: ['python3'] }),
      })
      assertNoLeak({ stdout: child.stdout, stderr: child.stderr, error: child.error })
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
      return child.status
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  test('ordinary requests remain serial, preserve line shapes, and retain skip state across a new client', async () => {
    const first = deferred<Response>()
    const h = harness(undefined, m => m.params.name === 'first' ? first.promise : h.toolResponse(m.id, m.params.name))
    await h.connect('start')
    h.write([request('first'), request('second')])
    const pending = h.poll(); await turns()
    expect(h.starts.map(x => x.name)).toEqual(['first']); expect(h.observed('results')).toEqual([])
    first.resolve(h.toolResponse(1, 'first')); await pending
    expect(h.starts.map(x => x.name)).toEqual(['first','second'])
    expect(h.observed('results')).toEqual([{id:'first',isError:false,text:'first'}, {id:'second',isError:false,text:'second'}])
    h.notify('probe-1', {content:'unchanged',meta:{via:'thread'}}); await turns()
    expect(h.observed('deliveries')).toEqual([{content:'unchanged',meta:{via:'thread'}}])
    await h.close()
    const restart = harness(h.files)
    await restart.connect('start'); await restart.poll()
    expect(restart.starts).toEqual([])
    expect(restart.observed('sessions').filter((x: any) => x.event === 'connected')).toHaveLength(2)
    expect(test29Records('skipped', { log: restart.logs.join('\n'), ids: 'first\nsecond\n' })).toBe(0)
    expect(test29Records('skipped', { log: restart.logs.filter(line => !line.includes('request second ')).join('\n'), ids: 'first\nsecond\n' })).toBe(1)
    expect(restart.observed('results')).toEqual([{id:'first',isError:false,text:'first'}, {id:'second',isError:false,text:'second'}])
    expect(test29Records('once', { requests: h.files.get('requests')!, results: h.files.get('results')! })).toBe(0)
    expect(test29Records('once', { requests: h.files.get('requests')!, results: h.files.get('results')! + h.files.get('results')! })).toBe(1)
  })

  test('same-poll groups start all members before an answer and await all before the next batch', async () => {
    const a = deferred<Response>(), b = deferred<Response>()
    const h = harness(undefined, m => m.params.name === 'a' ? a.promise : m.params.name === 'b' ? b.promise : h.toolResponse(m.id, m.params.name))
    await h.connect('start')
    h.write([request('a',{group:'together'}), request('later'), request('b',{group:'together'}), request('a',{group:'together'})])
    const pending = h.poll(); await turns()
    expect(h.starts.map(x=>x.name)).toEqual(['a','b']); expect(h.observed('results')).toEqual([])
    b.resolve(h.toolResponse(2,'b')); await turns()
    expect(h.starts.map(x=>x.name)).toEqual(['a','b'])
    a.resolve(h.toolResponse(1,'a')); await pending
    expect(h.starts.map(x=>x.name)).toEqual(['a','b','later'])
    expect(h.observed('results').map((x:any)=>x.id).sort()).toEqual(['a','b','later'])
    expect(h.logs.some(line => /request a .*scheduled.*not run/.test(line))).toBe(true)
    expect(test29Records('skipped', { log: h.logs.join('\n'), ids: 'a\n' })).toBe(1)
  })

  test('loss cancels an unread response and retry in the same poll uses a fresh roots-acknowledged session', async () => {
    const gate = deferred(), entered = deferred()
    const h = harness(undefined, undefined, sid => {
      if (sid === 'probe-2') { entered.resolve(); return gate.promise }
      return Promise.resolve()
    })
    await h.connect('start')
    h.write([request('lost',{lose_response:true}), request('retry',{arguments:{attempt_id:'retained',intent:'retry'}})])
    const pending = h.poll(); await entered.promise
    expect(h.starts.map(x=>x.name)).toEqual(['lost'])
    expect(h.reads).toEqual([])
    expect(h.cancels).toEqual(['lost'])
    expect(h.observed('results')).toEqual([{id:'lost',isError:true,text:'',status:'lost',session_id:'probe-1'}])
    gate.resolve(); await pending
    expect(h.starts).toEqual([
      {sid:'probe-1',name:'lost',args:{attempt_id:'retained',intent:'assignment'}},
      {sid:'probe-2',name:'retry',args:{attempt_id:'retained',intent:'retry'}},
    ])
    expect(h.reads).toEqual(['retry'])
    expect(h.observed('results')[1]).toEqual({id:'retry',isError:false,text:'retry'})
    expect(h.observed('sessions').filter((x:any)=>x.event === 'connected').map((x:any)=>x.reason)).toEqual(['start','lost_response'])
    expect(h.observed('sessions').filter((x:any)=>x.event === 'request').map((x:any)=>[x.id,x.session_id])).toEqual([['lost','probe-1'],['retry','probe-2']])
    await h.close()
    const restarted = harness(h.files)
    await restarted.connect('start'); await restarted.poll()
    expect(restarted.starts).toEqual([])
  })

  test('closing a lost-response group answers every in-flight member once and continues on the new session', async () => {
    const never = deferred<Response>()
    const h = harness(undefined, m => m.params.name === 'peer' ? never.promise : h.toolResponse(m.id,m.params.name))
    await h.connect('start')
    h.write([request('lose',{group:'g',lose_response:true}),request('peer',{group:'g'}),request('next')])
    await h.poll()
    expect(h.starts.map(x=>[x.name,x.sid])).toEqual([['lose','probe-1'],['peer','probe-1'],['next','probe-2']])
    const results = h.observed('results')
    expect(results).toHaveLength(3)
    expect(results.find((x:any)=>x.id==='lose').status).toBe('lost')
    expect(results.find((x:any)=>x.id==='peer')).toMatchObject({isError:true,text:'',error:expect.any(String)})
    expect(results.find((x:any)=>x.id==='next')).toEqual({id:'next',isError:false,text:'next'})
  })

  test('failure before response headers is an error, never a claimed response loss', async () => {
    const h = harness(undefined, () => { throw new Error('fixture pre-headers disconnect') })
    await h.connect('start'); h.write([request('failed',{lose_response:true})]); await h.poll()
    expect(h.observed('results')).toEqual([{id:'failed',isError:true,text:'',error:expect.stringContaining('fixture pre-headers disconnect')}])
    expect(h.observed('sessions').filter((x:any)=>x.event === 'connected')).toHaveLength(1)
  })

  test('two already received responses lost together each retain their loss marker', async () => {
    const h = harness(); await h.connect('start')
    h.write([request('loss-a',{group:'g',lose_response:true}),request('loss-b',{group:'g',lose_response:true})])
    await h.poll()
    expect(h.reads).toEqual([])
    expect(h.cancels).toEqual(['loss-a','loss-b'])
    expect(h.observed('results').map((x:any)=>[x.id,x.status])).toEqual([['loss-a','lost'],['loss-b','lost']])
    expect(h.observed('sessions').filter((x:any)=>x.event==='connected')).toHaveLength(2)
  })

  test('incomplete lines wait for a later poll and groups never include unread partial members', async () => {
    const h = harness(); await h.connect('start')
    h.files.set('requests', JSON.stringify(request('one',{group:'g'}))+'\n'+JSON.stringify(request('two',{group:'g'})))
    await h.poll(); expect(h.starts.map(x=>x.name)).toEqual(['one'])
    h.files.set('requests',h.files.get('requests')+'\n'); await h.poll()
    expect(h.starts.map(x=>x.name)).toEqual(['one','two'])
    for (const fields of [{group:''},{group:1},{lose_response:'true'},{method:'tools/list',lose_response:false}]) {
      expect(h.parseRequest(JSON.stringify(request('invalid',fields)))).toHaveProperty('invalid')
    }
  })

  const pairRequest = (id: string, role: 'stale' | 'replacement', fields: object = {}) => request(id, {
    group: 'replacement-pair',
    arguments: {attempt_id:'retained',channel:'CEXAMPLE',delivery:'thread_hybrid',intent:'assignment',_stub_session:role},
    ...fields,
  })

  test('two real SDK transports retain roots and one barrier, refuse stale HTTP without retry and keep the replacement', async () => {
    const rootsGate = deferred(), rootsEntered = deferred(), stale = deferred<Response>(), current = deferred<Response>()
    const h = harness(undefined, (message, sid) => message.params.name === 'old' ? stale.promise :
      message.params.name === 'new' ? current.promise : h.toolResponse(message.id, message.params.name),
      sid => { if (sid === 'probe-2') { rootsEntered.resolve(); return rootsGate.promise }; return Promise.resolve() })
    await h.connect('start')
    h.write([pairRequest('old','stale'), pairRequest('new','replacement'), request('historical', {
      arguments:{attempt_id:'retained',channel:'CEXAMPLE',delivery:'thread_hybrid',intent:'retry'},
    })])
    const pending = h.poll(); await rootsEntered.promise
    expect(h.starts).toEqual([])
    expect(h.closed).toEqual([])
    rootsGate.resolve(); await turns()
    expect(h.roots).toEqual(['probe-1','probe-2'])
    expect(h.starts.map(x=>[x.name,x.sid])).toEqual([['old','probe-1'],['new','probe-2']])
    for (const start of h.starts) expect(start.args).toEqual({attempt_id:'retained',channel:'CEXAMPLE',delivery:'thread_hybrid',intent:'assignment'})
    const events = h.observed('sessions')
    expect(events.filter((x:any)=>x.event==='connected').map((x:any)=>x.reason)).toEqual(['start','replacement'])
    expect(events.filter((x:any)=>x.event==='submission_ready').map((x:any)=>[x.id,x.session_id])).toEqual([['old','probe-1'],['new','probe-2']])
    const barrier = events.find((x:any)=>x.event==='submission_barrier')
    expect(barrier.requests.map((x:any)=>[x.id,x.session_id,x.session_role])).toEqual([['old','probe-1','stale'],['new','probe-2','replacement']])
    const starts = events.filter((x:any)=>x.event==='http_start')
    expect(starts.map((x:any)=>x.in_flight)).toEqual([['old'],['old','new']])
    expect(events.indexOf(barrier)).toBeLessThan(events.indexOf(starts[0]))
    expect(h.observed('results')).toEqual([])
    stale.resolve(new Response('stale transport refused', {status:404})); await turns()
    expect(h.starts.map(x=>x.name)).toEqual(['old','new'])
    expect(h.observed('results')).toEqual([{id:'old',isError:true,text:'',error:expect.stringContaining('stale transport refused'),group:'replacement-pair',session_id:'probe-1',session_role:'stale'}])
    expect(h.closed).toEqual([])
    current.resolve(h.toolResponse(1,'new')); await pending
    expect(h.closed).toEqual(['probe-1'])
    expect(h.starts.map(x=>[x.name,x.sid])).toEqual([['old','probe-1'],['new','probe-2'],['historical','probe-2']])
    expect(h.starts[2].args).toEqual({attempt_id:'retained',channel:'CEXAMPLE',delivery:'thread_hybrid',intent:'retry'})
    expect(h.observed('results')[1]).toEqual({id:'new',isError:false,text:'new',group:'replacement-pair',session_id:'probe-2',session_role:'replacement'})
    expect(h.observed('results')[2]).toEqual({id:'historical',isError:false,text:'historical'})
    expect(h.observed('sessions').filter((x:any)=>x.event==='http_headers').map((x:any)=>[x.id,x.http_status])).toEqual([['old',404],['new',200]])
    expect(h.observed('sessions').filter((x:any)=>x.event==='submission_aborted')).toEqual([])
    await h.close()
    const restarted = harness(h.files); await restarted.connect('start'); await restarted.poll()
    expect(restarted.starts).toEqual([])
    expect(restarted.roots).toEqual(['probe-3'])
  })

  test('role selection follows the opt-in arguments in either file order and preserves retry intent', async () => {
    const h = harness()
    await h.connect('start')
    h.write([pairRequest('new-first','replacement'), pairRequest('old-second','stale',{
      arguments:{attempt_id:'retained',channel:'CEXAMPLE',delivery:'thread_hybrid',intent:'retry',_stub_session:'stale'},
    })])
    await h.poll()
    expect(h.starts.map(x=>[x.name,x.sid])).toEqual([['new-first','probe-2'],['old-second','probe-1']])
    expect(h.starts[1].args).toEqual({attempt_id:'retained',channel:'CEXAMPLE',delivery:'thread_hybrid',intent:'retry'})
    expect(h.observed('sessions').find((x:any)=>x.event==='http_start' && x.id==='old-second').in_flight).toEqual(['new-first','old-second'])
    expect(h.closed).toEqual(['probe-1'])
  })

  test('bad pair composition sends no calls, opens no replacement and answers each unique request once', async () => {
    for (const batch of [
      [pairRequest('one','stale')],
      [pairRequest('one','stale',{group:undefined}),pairRequest('two','replacement',{group:undefined})],
      [pairRequest('one','stale'),pairRequest('two','stale')],
      [pairRequest('one','stale'),pairRequest('two','replacement'),request('extra',{group:'replacement-pair'})],
      [pairRequest('one','stale',{lose_response:true}),pairRequest('two','replacement')],
      [pairRequest('one','stale'),{id:'two',method:'tools/list',group:'replacement-pair'}],
    ]) {
      const h=harness(); await h.connect('start'); h.write(batch); await h.poll()
      expect(h.starts).toEqual([])
      expect(h.roots).toEqual(['probe-1'])
      expect(h.observed('results').map((x:any)=>x.id)).toEqual(batch.map(x=>x.id))
      for (const result of h.observed('results')) expect(result).toMatchObject({isError:true,text:'',error:expect.stringContaining('session replacement needs')})
      await h.close()
    }
    const h = harness()
    for (const role of [null,true,{},'', 'current']) expect(h.parseRequest(JSON.stringify(request('bad',{arguments:{_stub_session:role}})))).toHaveProperty('invalid')
  })

  test('transport failure before either fetch releases no peer and records a failed barrier, never overlap', async () => {
    class RefusingTransport extends StreamableHTTPClientTransport {
      async send(message: any, options?: any) {
        if (message.method==='tools/call' && this.sessionId==='probe-1') throw new Error('probe refuses before fetch')
        return super.send(message, options)
      }
    }
    const h=harness(undefined,undefined,undefined,RefusingTransport)
    await h.connect('start'); h.write([pairRequest('old','stale'),pairRequest('new','replacement'),request('later')]); await h.poll()
    expect(h.starts.map(x=>[x.name,x.sid])).toEqual([['later','probe-2']])
    const events=h.observed('sessions')
    expect(events.filter((x:any)=>x.event==='submission_barrier' || x.event==='http_start')).toEqual([])
    expect(events.filter((x:any)=>x.event==='submission_aborted')).toHaveLength(1)
    expect(h.observed('results').slice(0,2).every((x:any)=>x.isError && x.error && x.text==='')).toBe(true)
    expect(h.closed).toEqual(['probe-1'])
  })

  test('a missing submission is bounded and late arrival cannot send after the barrier aborts', async () => {
    const hold=deferred()
    class DelayedTransport extends StreamableHTTPClientTransport {
      async send(message: any, options?: any) {
        if (message.method==='tools/call' && this.sessionId==='probe-1') await hold.promise
        return super.send(message, options)
      }
    }
    const h=harness(undefined,undefined,undefined,DelayedTransport)
    await h.connect('start'); h.write([pairRequest('old','stale'),pairRequest('new','replacement')])
    const ready=h.onRecord('submission_ready'), aborted=h.onRecord('submission_aborted'), pending=h.poll()
    await ready
    await h.clock.advance(h.bounds.barrier - 1)
    expect(h.observed('sessions').filter((x:any)=>x.event==='submission_aborted')).toEqual([])
    expect(h.starts).toEqual([])
    await h.clock.advance(1)
    expect((await aborted).error).toBe('paired SDK submission timed out')
    expect(h.starts).toEqual([])
    hold.resolve(); await pending
    expect(h.starts).toEqual([])
    expect(h.observed('sessions').filter((x:any)=>x.event==='submission_barrier')).toEqual([])
    expect(h.observed('results')).toHaveLength(2)
    for (const result of h.observed('results')) expect(result).toMatchObject({isError:true,text:'',error:expect.stringContaining('paired SDK submission timed out')})
  })

  test('replacement roots failure reports no submitted pair and keeps the gate failed', async () => {
    const rootsFailed=deferred()
    const h=harness(undefined,undefined, async sid => { if(sid==='probe-2') { rootsFailed.resolve(); throw new Error('probe roots reply refused') } })
    await h.connect('start'); h.write([pairRequest('old','stale'),pairRequest('new','replacement')])
    const pending=h.poll()
    await rootsFailed.promise
    await h.clock.advance(h.bounds.roots - 1)
    expect(h.observed('results')).toEqual([])
    expect(h.starts).toEqual([])
    await h.clock.advance(1)
    await pending
    expect(await h.ended).toBe(1)
    expect(h.starts).toEqual([])
    expect(h.observed('sessions').filter((x:any)=>x.event==='submission_barrier')).toEqual([])
    expect(h.observed('results')).toHaveLength(2)
    expect(h.closed).toContain('probe-1')
  })
})
