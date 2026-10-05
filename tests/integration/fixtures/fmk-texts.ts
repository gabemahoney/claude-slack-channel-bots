/**
 * fmk-texts.ts — the value printer of the fmk scenarios (b.jg5 SRJ-1306,
 * SRJ-1401). A scenario script cannot import TypeScript, and a test never
 * retypes a notice text, class label, version or settings value CSCB
 * defines, so a script that matches such a value prints it here, from the
 * installed package under test (the tarball /ci installs), and matches what
 * this prints. This is the one printer for every fmk scenario: a scenario
 * that needs another value adds a named entry to `ENTRIES` below, never a
 * second printer.
 *
 * REFUSAL
 * -------
 * Runs only in a cscb-ci image. Its first statement checks for the image
 * marker `/etc/cscb-ci-image`; without it, it prints
 * `FAIL: fmk-texts: refused: /etc/cscb-ci-image is absent …` on stderr and
 * exits 2, before it reads an argument or loads a module. Only `node:`
 * built-ins are imported statically: the package under test is imported
 * dynamically, after the check, by the entry that needs it.
 *
 * USAGE
 * -----
 *   bun fmk-texts.ts <entry> [<arg>...]
 *
 * It prints exactly the value of the named entry for its arguments on
 * stdout, a multi-line text as it is, with nothing added (no newline after
 * it), and exits 0. A script captures a value with a command substitution,
 * as a standalone assignment so a failure ends the script:
 *
 *   PREFIX="$(bun --no-install "${SCENARIO_FIXTURES}/fmk-texts.ts" APPROVER_LOG_PREFIX)" \
 *       || fail "setup: fmk-texts.ts could not print APPROVER_LOG_PREFIX"
 *
 * (A command substitution drops trailing newlines; no entry below ends with
 * one.) With no entry named, an unknown entry, arguments an entry does not
 * take, or a package that lacks the export, it prints
 * `FAIL: fmk-texts: <reason>` on one line on stderr and exits 64 (a usage
 * error) or 1 (the package).
 *
 * INPUTS (env)
 * ------------
 *   CSCB_PKG_DIR   the installed package (default
 *                  /test-repo/node_modules/claude-slack-channel-bots), read as
 *                  `driver.ts` and `fmk-driver.ts` read it
 *
 * ENTRIES (each prints a `src/` export of the installed package)
 * -------
 *   APPROVER_LOG_PREFIX           src/session-manager.ts APPROVER_LOG_PREFIX: the head
 *                                 of every log line the dialog approver writes
 *   DEV_CHANNELS_DIALOG_NEEDLE    src/session-manager.ts DEV_CHANNELS_DIALOG_NEEDLE: the
 *                                 approver's needle for the dev-channels dialog
 *   TRUST_DIALOG_NEEDLE           src/session-manager.ts TRUST_DIALOG_NEEDLE: the
 *                                 approver's needle for the folder-trust prompt
 *   DIALOG_POLL_INTERVAL_MS       src/session-manager.ts DIALOG_POLL_INTERVAL_MS: the
 *                                 approver's pace before G, in milliseconds
 *   DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds
 *                                 src/ad-settings.ts DEFAULT_AD_SETTINGS, its
 *                                 `tmux.pending_grace_seconds`: agent-director's
 *                                 default pending grace period G, in whole seconds
 *   DEFAULT_AD_SETTINGS.tmux.create_timeout_ms
 *                                 src/ad-settings.ts DEFAULT_AD_SETTINGS, its
 *                                 `tmux.create_timeout_ms`: agent-director's default
 *                                 bound on its session-creating tmux call, in
 *                                 milliseconds
 *   DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS
 *                                 src/config.ts DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS:
 *                                 CSCB's default bound on one agent-director call, in
 *                                 milliseconds
 *   LAUNCH_TIMEOUT_PHRASE         src/ad-description-phrases.ts LAUNCH_TIMEOUT_PHRASE:
 *                                 the phrase an ErrTmuxUnresponsive carries when it
 *                                 ends a launch call as a launch timeout
 *   LAUNCH_UNAVAILABLE_OUTCOME_APPROVER
 *                                 src/session-manager.ts
 *                                 LAUNCH_UNAVAILABLE_OUTCOME_APPROVER: the outcome the
 *                                 one `get` after a launch timeout logs for a covered
 *                                 `pending` row whose approver it started
 *   LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT
 *                                 src/ad-error-class.ts LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT:
 *                                 the name the post-timeout get line gives a launch
 *                                 timeout that was CSCB's own call timeout
 *   PENDING_ROW_RULE_LOG_HEAD     src/pending-row.ts PENDING_ROW_RULE_LOG_HEAD: the
 *                                 head of the pending-row rule's lines
 *   PENDING_ROW_RUN_MARKED_MISSING
 *                                 src/pending-row.ts PENDING_ROW_RUN_MARKED_MISSING: the
 *                                 placement a pending-row rule round's line gives
 *                                 its bypassing `find-missing` run when the run
 *                                 marked the row `missing`
 *   UNAVAILABLE_RETRY_BASE_S     src/unavailable-retry.ts UNAVAILABLE_RETRY_BASE_S: the
 *                                 retry timer's first wait, in seconds
 *   UNAVAILABLE_RETRY_CEILING_S   src/unavailable-retry.ts UNAVAILABLE_RETRY_CEILING_S:
 *                                 the retry timer's longest wait, in seconds
 * None of the above takes an argument.
 *   tmuxUnresponsiveEndedLines <key>
 *                                 src/persona-episodes.ts tmuxUnresponsiveEndedLine for
 *                                 persona key <key>, once for each end reason
 *                                 TMUX_UNRESPONSIVE_END_TEXT names, in its order, one
 *                                 line each: every ended line the persona's
 *                                 tmux-unresponsive condition can log
 *   spawnFailureNoticeHead <error-name>
 *                                 src/session-manager.ts spawnFailureNoticeText (the
 *                                 body `notifySpawnFailure` posts) for an
 *                                 agent-director error named <error-name> (letters
 *                                 and digits, starting `Err`), cut where the error's
 *                                 description begins: the notice's first line, then
 *                                 its error line up to and including the `—` after
 *                                 the label (the description is agent-director's and
 *                                 the remediation follows it, so neither is printed)
 *
 * It makes no agent-director call, starts no process or server, opens no
 * socket, reads no token and writes no file.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: fmk-texts: refused: /etc/cscb-ci-image is absent; this printer runs only in a cscb-ci image (/ci)')
  process.exit(2)
}

/** The name the printer's FAIL lines carry. */
const PRINTER_NAME = 'fmk-texts'

/** Exit status for a missing or unknown entry, or arguments an entry does not take (EX_USAGE). */
const USAGE_EXIT = 64

/** Exit status when the installed package lacks an export or holds a value of another kind. */
const PACKAGE_EXIT = 1

/** The installed package under test. */
const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

/** A failure: one `FAIL: fmk-texts: <reason>` line on stderr, then `code`. */
class PrinterFailure extends Error {
  constructor(
    readonly code: number,
    reason: string,
  ) {
    super(reason)
  }
}

/** Imports the installed package's `src/<relPath>`. */
async function importPackageModule(relPath: string): Promise<Record<string, unknown>> {
  return (await import(join(PKG_DIR, 'src', relPath))) as Record<string, unknown>
}

/** Export `name` of the package module `relPath`, which must be defined. */
async function packageExport(relPath: string, name: string): Promise<unknown> {
  const mod = await importPackageModule(relPath)
  const value = mod[name]
  if (value === undefined) throw new PrinterFailure(PACKAGE_EXIT, `the installed package's src/${relPath} exports no ${name}`)
  return value
}

/** Export `name` of `relPath`, which must be a string; printed as it is. */
async function stringExport(relPath: string, name: string): Promise<string> {
  const value = await packageExport(relPath, name)
  if (typeof value !== 'string') throw new PrinterFailure(PACKAGE_EXIT, `the installed package's src/${relPath} ${name} is not a string`)
  return value
}

/** Export `name` of `relPath`, or the value at `path` inside it, which must be a whole number (a bigint or an integer); printed in decimal. */
async function wholeNumberAt(relPath: string, name: string, path: readonly string[]): Promise<string> {
  let value: unknown = await packageExport(relPath, name)
  for (const key of path) {
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
  }
  const at = [name, ...path].join('.')
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  throw new PrinterFailure(PACKAGE_EXIT, `the installed package's src/${relPath} ${at} is not a whole number`)
}

/** One entry: prints its value for its arguments. */
type Entry = (args: readonly string[]) => Promise<string>

/** An entry that takes no argument and prints `read()`. */
function noArguments(name: string, read: () => Promise<string>): Entry {
  return async (args) => {
    if (args.length > 0) throw new PrinterFailure(USAGE_EXIT, `${name} takes no argument (got ${args.length})`)
    return await read()
  }
}

/** An entry that takes exactly one argument, named `argName` in its usage error, and prints `read(arg)`. */
function oneArgument(name: string, argName: string, read: (arg: string) => Promise<string>): Entry {
  return async (args) => {
    if (args.length !== 1) throw new PrinterFailure(USAGE_EXIT, `${name} takes one argument, <${argName}> (got ${args.length})`)
    return await read(args[0]!)
  }
}

/**
 * Every ended line of persona `key`'s tmux-unresponsive condition: the
 * package's `tmuxUnresponsiveEndedLine(key, reason)` for each reason its
 * `TMUX_UNRESPONSIVE_END_TEXT` names, in that order, joined by newlines.
 */
async function tmuxUnresponsiveEndedLines(key: string): Promise<string> {
  const build = await packageExport('persona-episodes.ts', 'tmuxUnresponsiveEndedLine')
  const texts = await packageExport('persona-episodes.ts', 'TMUX_UNRESPONSIVE_END_TEXT')
  if (typeof build !== 'function') throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/persona-episodes.ts tmuxUnresponsiveEndedLine is not a function")
  if (typeof texts !== 'object' || texts === null) {
    throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/persona-episodes.ts TMUX_UNRESPONSIVE_END_TEXT is not an object")
  }
  const reasons = Object.keys(texts)
  if (reasons.length === 0) throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/persona-episodes.ts TMUX_UNRESPONSIVE_END_TEXT names no end reason")
  const lines = reasons.map((reason) => {
    const line: unknown = (build as (key: string, reason: unknown) => unknown)(key, reason)
    if (typeof line !== 'string' || line.includes('\n')) {
      throw new PrinterFailure(PACKAGE_EXIT, `the installed package's src/persona-episodes.ts tmuxUnresponsiveEndedLine gave no one-line text for reason ${reason}`)
    }
    return line
  })
  return lines.join('\n')
}

/** An agent-director error name: `Err`, then letters and digits. */
const ERROR_NAME_RE = /^Err[A-Za-z0-9]+$/

/** The description the notice is built with; cut off with all that follows it. */
const DESCRIPTION_MARK = 'fmk texts description mark'

/**
 * The spawn-failure notice's head for an error named `errorName`: the
 * package's `spawnFailureNoticeText` for an `AgentDirectorError` of that name
 * whose description is {@link DESCRIPTION_MARK}, up to where the mark begins.
 */
async function spawnFailureNoticeHead(errorName: string): Promise<string> {
  if (!ERROR_NAME_RE.test(errorName)) {
    throw new PrinterFailure(USAGE_EXIT, `spawnFailureNoticeHead: '${errorName}' is not an agent-director error name (Err, then letters and digits)`)
  }
  const build = await packageExport('session-manager.ts', 'spawnFailureNoticeText')
  const errorClass = await packageExport('agent-director-errors.ts', 'AgentDirectorError')
  if (typeof build !== 'function') throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/session-manager.ts spawnFailureNoticeText is not a function")
  if (typeof errorClass !== 'function') throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/agent-director-errors.ts AgentDirectorError is not a class")
  const error: unknown = new (errorClass as new (verb: string, name: string, description: string) => unknown)('spawn', errorName, DESCRIPTION_MARK)
  const text: unknown = (build as (error: unknown) => unknown)(error)
  const at = typeof text === 'string' ? text.indexOf(DESCRIPTION_MARK) : -1
  if (typeof text !== 'string' || at <= 0) {
    throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/session-manager.ts spawnFailureNoticeText gave no text holding the error's description")
  }
  return text.slice(0, at)
}

/** The entries, by the name a script passes. */
const ENTRIES: Readonly<Record<string, Entry>> = {
  APPROVER_LOG_PREFIX: noArguments('APPROVER_LOG_PREFIX', () => stringExport('session-manager.ts', 'APPROVER_LOG_PREFIX')),
  DEV_CHANNELS_DIALOG_NEEDLE: noArguments('DEV_CHANNELS_DIALOG_NEEDLE', () => stringExport('session-manager.ts', 'DEV_CHANNELS_DIALOG_NEEDLE')),
  TRUST_DIALOG_NEEDLE: noArguments('TRUST_DIALOG_NEEDLE', () => stringExport('session-manager.ts', 'TRUST_DIALOG_NEEDLE')),
  DIALOG_POLL_INTERVAL_MS: noArguments('DIALOG_POLL_INTERVAL_MS', () => wholeNumberAt('session-manager.ts', 'DIALOG_POLL_INTERVAL_MS', [])),
  'DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds': noArguments('DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds', () =>
    wholeNumberAt('ad-settings.ts', 'DEFAULT_AD_SETTINGS', ['tmux', 'pending_grace_seconds']),
  ),
  'DEFAULT_AD_SETTINGS.tmux.create_timeout_ms': noArguments('DEFAULT_AD_SETTINGS.tmux.create_timeout_ms', () =>
    wholeNumberAt('ad-settings.ts', 'DEFAULT_AD_SETTINGS', ['tmux', 'create_timeout_ms']),
  ),
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS: noArguments('DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS', () =>
    wholeNumberAt('config.ts', 'DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS', []),
  ),
  LAUNCH_TIMEOUT_PHRASE: noArguments('LAUNCH_TIMEOUT_PHRASE', () => stringExport('ad-description-phrases.ts', 'LAUNCH_TIMEOUT_PHRASE')),
  LAUNCH_UNAVAILABLE_OUTCOME_APPROVER: noArguments('LAUNCH_UNAVAILABLE_OUTCOME_APPROVER', () =>
    stringExport('session-manager.ts', 'LAUNCH_UNAVAILABLE_OUTCOME_APPROVER'),
  ),
  LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT: noArguments('LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT', () =>
    stringExport('ad-error-class.ts', 'LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT'),
  ),
  PENDING_ROW_RULE_LOG_HEAD: noArguments('PENDING_ROW_RULE_LOG_HEAD', () => stringExport('pending-row.ts', 'PENDING_ROW_RULE_LOG_HEAD')),
  PENDING_ROW_RUN_MARKED_MISSING: noArguments('PENDING_ROW_RUN_MARKED_MISSING', () =>
    stringExport('pending-row.ts', 'PENDING_ROW_RUN_MARKED_MISSING'),
  ),
  UNAVAILABLE_RETRY_BASE_S: noArguments('UNAVAILABLE_RETRY_BASE_S', () => wholeNumberAt('unavailable-retry.ts', 'UNAVAILABLE_RETRY_BASE_S', [])),
  UNAVAILABLE_RETRY_CEILING_S: noArguments('UNAVAILABLE_RETRY_CEILING_S', () => wholeNumberAt('unavailable-retry.ts', 'UNAVAILABLE_RETRY_CEILING_S', [])),
  tmuxUnresponsiveEndedLines: oneArgument('tmuxUnresponsiveEndedLines', 'key', tmuxUnresponsiveEndedLines),
  spawnFailureNoticeHead: oneArgument('spawnFailureNoticeHead', 'error-name', spawnFailureNoticeHead),
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv
  const known = Object.keys(ENTRIES).sort().join(', ')
  try {
    if (name === undefined || name === '') throw new PrinterFailure(USAGE_EXIT, `no entry was named; usage: bun fmk-texts.ts <entry> [<arg>...] (entries: ${known})`)
    const entry = Object.hasOwn(ENTRIES, name) ? ENTRIES[name] : undefined
    if (entry === undefined) throw new PrinterFailure(USAGE_EXIT, `unknown entry '${name}' (entries: ${known})`)
    const text = await entry(args)
    // Written whole before the exit below.
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()))
    return 0
  } catch (err) {
    const code = err instanceof PrinterFailure ? err.code : PACKAGE_EXIT
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`FAIL: ${PRINTER_NAME}: ${reason.replace(/\s*\n\s*/g, ' ')}`)
    return code
  }
}

process.exit(await main(process.argv.slice(2)))
