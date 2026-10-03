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
 * The file starts no process and reads nothing outside the repository.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AD_TMUX_TABLE } from '../src/ad-settings.ts'
import { callArguments, maskLiterals, splitTopLevel, stripComments } from './test-helpers/source-audit.ts'

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

/** The row-delete helpers (SRJ-716) and the `src/cli.ts` audit's delete verbs (`directorDelete`, `deleteSpawn`). */
const DELETE_HELPERS = ['deleteInstance', 'deleteInstanceRow', 'deletePersonaInstance', 'tryDelete', 'killAndDeleteSweptRow', 'directorDelete', 'deleteSpawn']

/** SRJ-601's removed identifiers, E17 T1's focused approver-seam names and E22 T4's ladder kill clock seam. */
const REMOVED_IDENTIFIERS = [
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

/** Callees that start a process (the CLI's `spawnDaemon` dependency included). */
const START_NAMES = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'spawnDaemon'])

/** Modules whose start functions and `$` count as process starts. */
const PROCESS_MODULE = /^(?:(?:node:)?child_process|bun)$/

/** A whole identifier from `names`. */
const wholeWord = (names: readonly string[]): RegExp => new RegExp(`(?<![\\w$])(?:${names.join('|')})(?![\\w$])`, 'g')

const WORD_RULES: ReadonlyArray<readonly [Rule, RegExp]> = [
  ['delete-helper', wholeWord(DELETE_HELPERS)],
  ['finished-row-option', /include_finished|include-finished/g],
  ['ad-label', /ad_owner|ad_pane/g],
  ['raw-tmux-subcommand', /kill-session|has-session|start-server/g],
  ['removed-identifier', wholeWord(REMOVED_IDENTIFIERS)],
]

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
