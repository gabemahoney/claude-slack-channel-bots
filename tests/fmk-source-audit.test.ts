/**
 * fmk-source-audit.test.ts — One source audit over every `src/` file (b.jg5
 * SRJ-716, SRJ-106, SRJ-612; SRJ-601's removed identifiers and process-start
 * rule; AC 16's source half, AC 17, AC 18).
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
 * - `finished-row-option`: `include_finished` or `include-finished` anywhere (SRJ-106).
 * - `ad-label`: `ad_owner` or `ad_pane` anywhere (SRJ-612, HO rev 17).
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
 *   anywhere (SRJ-1101; HO C1, C18, C20).
 * - `removed-identifier`: any of SRJ-601's removed names, E17 T1's approver
 *   seam names and E22 T4's ladder kill clock seam, in code or a string.
 *
 * Log text naming tmux sub-commands (`tmux attach -t`) is no process start.
 *
 * A second audit, `byNameFindings`, reads every `src/` file and the
 * agent-director stub (`tests/test-helpers/agent-director-stub.ts`) with the
 * TypeScript parser, so text in strings and comments never counts, and finds
 * any recognition of a class the client declares by name rather than by class
 * (b.jg5 SRJ-101, SRJ-104). The class names are read from the installed
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
 * to the pinned client's own (b.jg5 SRJ-101, SRJ-103, SRJ-1203):
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
 * (b.jg5 SRJ-101, SRJ-1303); it is pinned the same way.
 *
 * The file starts no process and reads nothing outside the repository and
 * its installed client.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import * as agentDirectorClient from 'agent-director'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import { AD_TMUX_TABLE } from '../src/ad-settings.ts'
import { PHASE1_ONLY_ERR_NAMES } from '../src/agent-director-errors.ts'
import { AD_NS, AGENT_DIRECTOR_MODULE, agentDirectorNamespaceArguments, agentDirectorValueReads, finding } from './test-helpers/ad-value-reads.ts'
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

describe('b.jg5 SRJ-716, SRJ-106, SRJ-612, SRJ-601: one source audit over every src/ file', () => {
  test('the real src/ has no finding, every listed non-literal start among them', () => {
    expect(SRC_FILES.map(([name]) => name)).toEqual(expect.arrayContaining(['cli.ts', 'session-manager.ts', 'server.ts', 'stop-hook-bootstrap.ts']))
    expect(auditSources(SRC_FILES, NON_LITERAL_STARTS)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Planted violations and negative controls
// ---------------------------------------------------------------------------

/** [what is planted, the synthetic source (one line), the one rule it breaks]. */
const PLANTED: ReadonlyArray<readonly [string, string, Rule]> = [
  // The agent-director client's delete.
  ['client.delete', 'await client.delete({ claude_instance_id: id })', 'client-delete'],
  ['client . delete with spacing', 'await client . delete ({ claude_instance_id: id })', 'client-delete'],
  ['client?.delete', 'await client?.delete({ claude_instance_id: id })', 'client-delete'],
  ['client.delete?.()', 'await client.delete?.({ claude_instance_id: id })', 'client-delete'],
  ["client['delete']", "await client['delete']({ claude_instance_id: id })", 'client-delete'],
  ['client?.["delete"]', 'await client?.["delete"]({ claude_instance_id: id })', 'client-delete'],
  ['this.client.delete', 'await this.client.delete({ claude_instance_id: id })', 'client-delete'],
  ['deps.adClient.delete', 'await deps.adClient.delete({ claude_instance_id: id })', 'client-delete'],
  ['getClient().delete', 'await getClient().delete({ claude_instance_id: id })', 'client-delete'],
  ['getClient() . delete with spacing', 'await getClient( ) . delete ({ claude_instance_id: id })', 'client-delete'],
  ['deps.delete', 'await deps.delete(id)', 'client-delete'],
  ['directorOps.delete', 'await directorOps.delete(id)', 'client-delete'],
  ['director.destroy', 'await director.destroy(id)', 'client-delete'],
  ...DELETE_HELPERS.flatMap((name): Array<readonly [string, string, Rule]> => [
    [`${name} in code`, `await deps.${name}(key)`, 'delete-helper'],
    [`${name} in a string`, `log('${name} failed')`, 'delete-helper'],
  ]),
  // finished-row-option: include_finished or include-finished (SRJ-106).
  ['include_finished in code', 'await c.kill({ claude_instance_id: id, include_finished: true })', 'finished-row-option'],
  ['include_finished in a string', "const key = 'include_finished'", 'finished-row-option'],
  ['include-finished in a string', 'const flag = "--include-finished"', 'finished-row-option'],
  ['include-finished in a template', 'const line = `kill --include-finished ${id}`', 'finished-row-option'],
  // agent-director's labels (SRJ-612).
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
  // A raw tmux sub-command named in a string (SRJ-1101).
  ['kill-session', "const verb = 'kill-session'", 'raw-tmux-subcommand'],
  ['has-session', 'const verb = "has-session"', 'raw-tmux-subcommand'],
  ['start-server', 'const line = `tmux start-server ${flags}`', 'raw-tmux-subcommand'],
  // SRJ-601's removed identifiers, E17 T1's and E22 T4's seams.
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
  ['getClient().spawn({ … })', 'await getClient().spawn({ claude_instance_id: id, cwd })'],
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
// By-name recognition of a class the client declares (b.jg5 SRJ-101, SRJ-104)
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
 * `ErrAmbiguousRequest` and `ErrPermissionRequestNotFound`, which SRJ-104's
 * table does not list and E37's ruling keeps as they are (b.jg5 SRJ-101); the
 * version gate's three system-install comparisons; and the checked kill's
 * GONE-name log label. Every other class, at these files included, is decided
 * by `instanceof`. The A-13 rows
 * (`ErrInternal`, `ErrConfigMalformed`, the three store-open names) and CSCB's
 * `UnknownError` row in `src/ad-error-class.ts` need no entry: those names are
 * no class the client declares.
 */
interface SanctionedByName {
  readonly file: string
  readonly name: string
  readonly rule: ByNameRule
  readonly reason: string
}

const SANCTIONED_BY_NAME: readonly SanctionedByName[] = [
  { file: 'src/permission-click-handler.ts', name: 'ErrAmbiguousRequest', rule: 'class-name-comparison', reason: "decide's defense-in-depth backstop and its trail class (SR-4.4, SR-V-2.7)" },
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

/** The module that re-exports the client's error classes (b.jg5 SRJ-103). */
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
    "if (err.errName === 'ErrConfigMalformed') return",
    'if (err.unknownName === ERR_INTERNAL_NAME) return',
    'if (err.errName === ERR_SPAWN_CAP_REACHED_NAME) return capHint()',
    "return new AgentDirectorError('decide', 'ErrInternal', 'internal error')",
  ].join('\n')],
  ["the A-13 and UnknownError rows in src/ad-error-class.ts", 'src/ad-error-class.ts', [
    "import { ERR_INTERNAL_NAME, ERR_CONFIG_MALFORMED_NAME, STORE_OPEN_ERR_NAMES } from './agent-director-errors.ts'",
    "const CSCB_UNKNOWN_ERROR_NAME = 'UnknownError'",
    'const STORE_OPEN_NAMES: ReadonlySet<unknown> = new Set(STORE_OPEN_ERR_NAMES)',
    "const errName = readProp(value, 'errName')",
    'if (errName === ERR_INTERNAL_NAME || errName === ERR_CONFIG_MALFORMED_NAME || STORE_OPEN_NAMES.has(errName)) return classifyUnknownName(errName, description)',
    'if (errName === CSCB_UNKNOWN_ERROR_NAME) return { errorClass: AD_ERROR_CLASS_UNAVAILABLE }',
    'if (unknownName === ERR_INTERNAL_NAME) return internal()',
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

describe('b.jg5 SRJ-101, SRJ-104: every class the client declares is decided by class in src/ and the stub, never by name', () => {
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
// The three Phase-1-only classes are the pinned client's own (b.jg5 SRJ-101, SRJ-103, SRJ-1203)
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

describe('b.jg5 SRJ-103, SRJ-1203: src/agent-director-errors.ts re-exports the three Phase-1-only classes by name from agent-director', () => {
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

describe('b.jg5 SRJ-101, SRJ-1203: no file in src/ or tests/test-helpers/ reads a Phase-1-only class from agent-director but by a named import or re-export', () => {
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

describe('b.jg5 SRJ-101, SRJ-1203: no file in src/ or tests/test-helpers/ declares a stand-in for a Phase-1-only class', () => {
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
// src/ad-phase1-types.ts declares no field (b.jg5 SRJ-101, SRJ-1303)
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

describe('b.jg5 SRJ-101, SRJ-1303: src/ad-phase1-types.ts declares no field; the client declares them all', () => {
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
