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
 *   DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds
 *                                 src/ad-settings.ts DEFAULT_AD_SETTINGS, its
 *                                 `tmux.stopping_window_seconds`: agent-director's
 *                                 default stopping window, how long an ended row
 *                                 whose agent has not exited counts as still
 *                                 stopping, in whole seconds
 *   DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS
 *                                 src/config.ts DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS:
 *                                 CSCB's default bound on one agent-director call, in
 *                                 milliseconds
 *   LAUNCH_TIMEOUT_PHRASE         src/ad-description-phrases.ts LAUNCH_TIMEOUT_PHRASE:
 *                                 the phrase an ErrTmuxUnresponsive carries when it
 *                                 ends a launch call as a launch timeout
 *   STILL_STOPPING_PHRASE         src/ad-description-phrases.ts STILL_STOPPING_PHRASE:
 *                                 the phrase an ErrTmuxUnresponsive carries for a
 *                                 row that appears to still be stopping
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
 *   tmuxUnresponsiveOnsetText <key>
 *                                 src/persona-episodes.ts tmuxUnresponsiveOnsetText for
 *                                 persona key <key>: the body of the persona's
 *                                 tmux-unresponsive onset notice (the persona
 *                                 notifier adds its prefix)
 *   spawnFailureNoticeHead <error-name>
 *                                 src/session-manager.ts spawnFailureNoticeText (the
 *                                 body `notifySpawnFailure` posts) for an
 *                                 agent-director error named <error-name> (letters
 *                                 and digits, starting `Err`), cut where the error's
 *                                 description begins: the notice's first line, then
 *                                 its error line up to and including the `—` after
 *                                 the label (the description is agent-director's and
 *                                 the remediation follows it, so neither is printed)
 *   unavailableRetryLineHead <key>
 *                                 src/unavailable-retry.ts: the longest head that
 *                                 unavailableRetryArmedLine, unavailableRetryRetryLine,
 *                                 unavailableRetryReArmedLine and
 *                                 unavailableRetryStoppedLine for persona key <key>
 *                                 share: the head of every retry-timer line of the
 *                                 persona
 *   unavailableRetryArmedHead <key>
 *                                 src/unavailable-retry.ts unavailableRetryArmedLine for
 *                                 <key>, in full and in pending-only mode, each cut
 *                                 where its description begins, then their longest
 *                                 shared head: the head of the persona's arm line in
 *                                 either mode
 *   unavailableRetryStoppedHead <key>
 *                                 src/unavailable-retry.ts unavailableRetryStoppedLine
 *                                 for <key>, with no tag and with the pending-only
 *                                 mode and a row read, each cut where its reason
 *                                 begins, then their longest shared head: the head of
 *                                 the persona's stop line in either form
 *   unavailableRetryNotArmedHead <key>
 *                                 src/unavailable-retry.ts
 *                                 unavailableRetryNotArmedClosedLine for <key>, cut
 *                                 where the refused cause begins: the head of the line
 *                                 an arm logs once the controller is closed (the
 *                                 server's shutdown)
 *   unavailableRetryRetryLineParts <key>
 *                                 src/unavailable-retry.ts unavailableRetryRetryLine
 *                                 for <key>, split where the retry number stands, three
 *                                 lines: the head before the number, the text after it
 *                                 in full mode, then in pending-only mode. A retry line
 *                                 is exactly the head, a number and one of the two
 *                                 tails; the re-armed line, which starts the same way,
 *                                 is neither
 *   launchUnavailableGetLineParts <ref>
 *                                 src/session-manager.ts launchUnavailableGetLine for
 *                                 persona reference <ref>, two lines: the text before
 *                                 the call's name (`what`), then the text from after it
 *                                 to the outcome's form
 *   launchUnavailableFormText <form>
 *                                 src/session-manager.ts launchUnavailableFormText: for
 *                                 <form> the name of a src/ad-error-class.ts
 *                                 launch-timeout form export (LAUNCH_TIMEOUT_FORM_…),
 *                                 the text naming that form; for `none` (no launch
 *                                 timeout), the UNAVAILABLE text cut where the rendered
 *                                 failure begins
 *   tmuxUnresponsiveLineHead <key>
 *                                 src/persona-episodes.ts tmuxUnresponsiveLine for <key>,
 *                                 cut where its text begins: the head of every
 *                                 tmux-unresponsive line of the persona
 *   approverShutdownStopLine <ref>
 *                                 src/session-manager.ts approverLogLine of
 *                                 approverStopRequestedMessage for persona reference
 *                                 <ref> and APPROVER_STOP_SHUTDOWN: the line shutdown
 *                                 logs when it stops the persona's running approver
 * A <key> is a persona key (lower-case letters, digits and `_`); a <ref> is
 * one line. A head or part is printed as it is, a trailing space included.
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

/** The package's `tmuxUnresponsiveOnsetText(key)`: the onset notice's one body for persona `key`. */
async function tmuxUnresponsiveOnsetText(key: string): Promise<string> {
  const build = await packageExport('persona-episodes.ts', 'tmuxUnresponsiveOnsetText')
  if (typeof build !== 'function') throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/persona-episodes.ts tmuxUnresponsiveOnsetText is not a function")
  const text: unknown = (build as (key: string) => unknown)(key)
  if (typeof text !== 'string' || text === '') {
    throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/persona-episodes.ts tmuxUnresponsiveOnsetText gave no text")
  }
  return text
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

/** Export `name` of `relPath`, which must be a function. */
async function functionExport(relPath: string, name: string): Promise<(...args: unknown[]) => unknown> {
  const value = await packageExport(relPath, name)
  if (typeof value !== 'function') throw new PrinterFailure(PACKAGE_EXIT, `the installed package's src/${relPath} ${name} is not a function`)
  return value as (...args: unknown[]) => unknown
}

/** A persona key as lib/scenario.sh `persona_key` makes it: lower-case letters, digits and `_`. */
const KEY_RE = /^[a-z0-9_]+$/

/** Fails with a usage error unless `key` is a persona key. */
function checkKey(entry: string, key: string): void {
  if (!KEY_RE.test(key)) throw new PrinterFailure(USAGE_EXIT, `${entry}: '${key}' is not a persona key (lower-case letters, digits and _)`)
}

/** Fails with a usage error when `arg` is empty or holds a newline. */
function checkOneLine(entry: string, argName: string, arg: string): void {
  if (arg === '' || arg.includes('\n')) throw new PrinterFailure(USAGE_EXIT, `${entry}: <${argName}> is empty or holds a newline`)
}

/** The marker a builder's variable part is given; the text is cut where it begins. */
const VALUE_MARK = 'fmk-texts-value-mark'

/** A second marker, for a builder with two variable parts. */
const SECOND_MARK = 'fmk-texts-second-mark'

/** The retry number the retry line is built with; the line is split where it stands. */
const RETRY_MARK = 987654321

/**
 * `text`, the result of the package's `builder`, up to where `mark` begins.
 * The mark must stand once, after at least one character, in a one-line text.
 */
function cutAtMark(builder: string, text: unknown, mark: string): string {
  if (typeof text !== 'string' || text.includes('\n')) {
    throw new PrinterFailure(PACKAGE_EXIT, `the installed package's ${builder} gave no one-line text`)
  }
  const at = text.indexOf(mark)
  if (at <= 0 || text.indexOf(mark, at + 1) !== -1) {
    throw new PrinterFailure(PACKAGE_EXIT, `the installed package's ${builder} gave a text that does not hold its variable part once, after a head`)
  }
  return text.slice(0, at)
}

/** The longest text every one of `texts` starts with. */
function commonHead(texts: readonly string[]): string {
  let head = texts[0] ?? ''
  for (const text of texts.slice(1)) {
    let n = 0
    while (n < head.length && n < text.length && head[n] === text[n]) n++
    head = head.slice(0, n)
  }
  return head
}

/** Fails unless `head`, the common head of `builder`'s forms for persona `key`, holds `persona=<key> ` (the key whole). */
function checkKeyHead(builder: string, head: string, key: string): string {
  if (!head.includes(`persona=${key} `)) {
    throw new PrinterFailure(PACKAGE_EXIT, `the installed package's ${builder} forms share no head naming persona=${key}`)
  }
  return head
}

/**
 * The head every line of persona `key`'s retry timer starts with: the
 * longest text the package's arm, retry, re-armed and stop lines for `key`
 * (src/unavailable-retry.ts `unavailableRetryArmedLine`,
 * `unavailableRetryRetryLine`, `unavailableRetryReArmedLine` and
 * `unavailableRetryStoppedLine`) all start with.
 */
async function unavailableRetryLineHead(key: string): Promise<string> {
  checkKey('unavailableRetryLineHead', key)
  const armed = await functionExport('unavailable-retry.ts', 'unavailableRetryArmedLine')
  const retry = await functionExport('unavailable-retry.ts', 'unavailableRetryRetryLine')
  const reArmed = await functionExport('unavailable-retry.ts', 'unavailableRetryReArmedLine')
  const stopped = await functionExport('unavailable-retry.ts', 'unavailableRetryStoppedLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryArmedLine, unavailableRetryRetryLine, unavailableRetryReArmedLine and unavailableRetryStoppedLine'
  const retryMark = String(RETRY_MARK)
  const heads = [
    cutAtMark(builder, armed(key, false, VALUE_MARK, 1000), VALUE_MARK),
    cutAtMark(builder, retry(key, RETRY_MARK, false), retryMark),
    cutAtMark(builder, reArmed(key, RETRY_MARK, false, VALUE_MARK, undefined, 1000), retryMark),
    cutAtMark(builder, stopped(key, false, undefined, VALUE_MARK), VALUE_MARK),
  ]
  return checkKeyHead(builder, commonHead(heads), key)
}

/**
 * The head of persona `key`'s arm line in either mode: the longest text the
 * package's `unavailableRetryArmedLine` for `key`, in full and in
 * pending-only mode, starts with, each cut where its description begins.
 */
async function unavailableRetryArmedHead(key: string): Promise<string> {
  checkKey('unavailableRetryArmedHead', key)
  const build = await functionExport('unavailable-retry.ts', 'unavailableRetryArmedLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryArmedLine'
  const forms = [false, true].map((pendingOnly) => cutAtMark(builder, build(key, pendingOnly, VALUE_MARK, 1000), VALUE_MARK))
  return checkKeyHead(builder, commonHead(forms), key)
}

/**
 * The head of persona `key`'s stop line in either form: the longest text the
 * package's `unavailableRetryStoppedLine` for `key`, with no mode named and
 * with the pending-only mode and a row read named, starts with, each cut
 * where its reason begins.
 */
async function unavailableRetryStoppedHead(key: string): Promise<string> {
  checkKey('unavailableRetryStoppedHead', key)
  const build = await functionExport('unavailable-retry.ts', 'unavailableRetryStoppedLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryStoppedLine'
  const forms = [
    cutAtMark(builder, build(key, false, undefined, VALUE_MARK), VALUE_MARK),
    cutAtMark(builder, build(key, true, SECOND_MARK, VALUE_MARK), VALUE_MARK),
  ]
  return checkKeyHead(builder, commonHead(forms), key)
}

/**
 * The head of persona `key`'s not-armed line (an arm refused once the
 * controller is closed, the server's shutdown): the package's
 * `unavailableRetryNotArmedClosedLine` for `key`, cut where the refused
 * cause begins.
 */
async function unavailableRetryNotArmedHead(key: string): Promise<string> {
  checkKey('unavailableRetryNotArmedHead', key)
  const build = await functionExport('unavailable-retry.ts', 'unavailableRetryNotArmedClosedLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryNotArmedClosedLine'
  return checkKeyHead(builder, cutAtMark(builder, build(key, VALUE_MARK, SECOND_MARK), VALUE_MARK), key)
}

/**
 * Persona `key`'s retry line in its parts, three lines: the head before the
 * retry number, then the text after the number in full mode, then in
 * pending-only mode (the package's `unavailableRetryRetryLine` for `key`,
 * split where the number stands). A retry line is exactly the head, a
 * number and one of the two tails; the re-armed line, which starts the same
 * way, is neither.
 */
async function unavailableRetryRetryLineParts(key: string): Promise<string> {
  checkKey('unavailableRetryRetryLineParts', key)
  const build = await functionExport('unavailable-retry.ts', 'unavailableRetryRetryLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryRetryLine'
  const mark = String(RETRY_MARK)
  const parts = [false, true].map((pendingOnly) => {
    const line = build(key, RETRY_MARK, pendingOnly)
    const head = cutAtMark(builder, line, mark)
    const tail = (line as string).slice(head.length + mark.length)
    if (tail === '') throw new PrinterFailure(PACKAGE_EXIT, `the installed package's ${builder} gave a line that ends at its retry number`)
    return { head, tail }
  })
  const [full, pendingOnly] = parts as [{ head: string; tail: string }, { head: string; tail: string }]
  if (full.head !== pendingOnly.head) throw new PrinterFailure(PACKAGE_EXIT, `the installed package's ${builder} gave its two modes different heads`)
  checkKeyHead(builder, full.head, key)
  return [full.head, full.tail, pendingOnly.tail].join('\n')
}

/**
 * The post-UNAVAILABLE get line's fixed parts for persona reference `ref`,
 * two lines: the text before the call's name (`what`), then the text from
 * after it to the outcome's form (the package's `launchUnavailableGetLine`,
 * src/session-manager.ts, built with markers for the two and cut at them).
 */
async function launchUnavailableGetLineParts(ref: string): Promise<string> {
  checkOneLine('launchUnavailableGetLineParts', 'ref', ref)
  const build = await functionExport('session-manager.ts', 'launchUnavailableGetLine')
  const builder = 'src/session-manager.ts launchUnavailableGetLine'
  const line = build(ref, VALUE_MARK, SECOND_MARK, 'pending', undefined, 'outcome')
  const toWhat = cutAtMark(builder, line, VALUE_MARK)
  const toForm = cutAtMark(builder, line, SECOND_MARK)
  const between = toForm.slice(toWhat.length + VALUE_MARK.length)
  if (toForm.length < toWhat.length + VALUE_MARK.length || !between.includes(ref)) {
    throw new PrinterFailure(PACKAGE_EXIT, `the installed package's ${builder} gave no line naming the call, then ${ref}, then the form`)
  }
  return [toWhat, between].join('\n')
}

/** An ad-error-class.ts launch-timeout form's export name. */
const LAUNCH_TIMEOUT_FORM_NAME_RE = /^LAUNCH_TIMEOUT_FORM_[A-Z_]+$/

/**
 * How the post-UNAVAILABLE get line names the launch's outcome (the
 * package's `launchUnavailableFormText`, src/session-manager.ts): for
 * `<form>` the name of a src/ad-error-class.ts launch-timeout form export
 * (`LAUNCH_TIMEOUT_FORM_…`), that form's text; for `none` (no launch
 * timeout), the UNAVAILABLE text cut where the rendered failure begins.
 */
async function launchUnavailableFormText(form: string): Promise<string> {
  const build = await functionExport('session-manager.ts', 'launchUnavailableFormText')
  const builder = 'src/session-manager.ts launchUnavailableFormText'
  if (form === 'none') return cutAtMark(builder, build(undefined, VALUE_MARK), VALUE_MARK)
  if (!LAUNCH_TIMEOUT_FORM_NAME_RE.test(form)) {
    throw new PrinterFailure(USAGE_EXIT, `launchUnavailableFormText: '${form}' is neither none nor a LAUNCH_TIMEOUT_FORM_ export name`)
  }
  const value = await stringExport('ad-error-class.ts', form)
  const text = build(value, VALUE_MARK)
  if (typeof text !== 'string' || text === '' || text.includes('\n') || text.includes(VALUE_MARK) || !text.includes(value)) {
    throw new PrinterFailure(PACKAGE_EXIT, `the installed package's ${builder} gave no one-line text naming the form ${value}`)
  }
  return text
}

/**
 * The head of persona `key`'s tmux-unresponsive lines: the package's
 * `tmuxUnresponsiveLine` (src/persona-episodes.ts) for `key`, cut where its
 * text begins.
 */
async function tmuxUnresponsiveLineHead(key: string): Promise<string> {
  checkKey('tmuxUnresponsiveLineHead', key)
  const build = await functionExport('persona-episodes.ts', 'tmuxUnresponsiveLine')
  const builder = 'src/persona-episodes.ts tmuxUnresponsiveLine'
  return checkKeyHead(builder, cutAtMark(builder, build(key, VALUE_MARK), VALUE_MARK), key)
}

/**
 * The approver's line when shutdown stops it for persona reference `ref`:
 * the package's `approverLogLine(approverStopRequestedMessage(ref,
 * APPROVER_STOP_SHUTDOWN))` (src/session-manager.ts), the line
 * `stopAllDialogApprovers` logs.
 */
async function approverShutdownStopLine(ref: string): Promise<string> {
  checkOneLine('approverShutdownStopLine', 'ref', ref)
  const logLine = await functionExport('session-manager.ts', 'approverLogLine')
  const message = await functionExport('session-manager.ts', 'approverStopRequestedMessage')
  const reason = await stringExport('session-manager.ts', 'APPROVER_STOP_SHUTDOWN')
  const line = logLine(message(ref, reason))
  if (typeof line !== 'string' || line.includes('\n') || !line.includes(ref) || !line.includes(reason)) {
    throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/session-manager.ts approverStopRequestedMessage gave no one-line text naming the reference and the shutdown reason")
  }
  return line
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
  'DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds': noArguments('DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds', () =>
    wholeNumberAt('ad-settings.ts', 'DEFAULT_AD_SETTINGS', ['tmux', 'stopping_window_seconds']),
  ),
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS: noArguments('DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS', () =>
    wholeNumberAt('config.ts', 'DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS', []),
  ),
  LAUNCH_TIMEOUT_PHRASE: noArguments('LAUNCH_TIMEOUT_PHRASE', () => stringExport('ad-description-phrases.ts', 'LAUNCH_TIMEOUT_PHRASE')),
  STILL_STOPPING_PHRASE: noArguments('STILL_STOPPING_PHRASE', () => stringExport('ad-description-phrases.ts', 'STILL_STOPPING_PHRASE')),
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
  tmuxUnresponsiveOnsetText: oneArgument('tmuxUnresponsiveOnsetText', 'key', tmuxUnresponsiveOnsetText),
  spawnFailureNoticeHead: oneArgument('spawnFailureNoticeHead', 'error-name', spawnFailureNoticeHead),
  unavailableRetryLineHead: oneArgument('unavailableRetryLineHead', 'key', unavailableRetryLineHead),
  unavailableRetryArmedHead: oneArgument('unavailableRetryArmedHead', 'key', unavailableRetryArmedHead),
  unavailableRetryStoppedHead: oneArgument('unavailableRetryStoppedHead', 'key', unavailableRetryStoppedHead),
  unavailableRetryNotArmedHead: oneArgument('unavailableRetryNotArmedHead', 'key', unavailableRetryNotArmedHead),
  unavailableRetryRetryLineParts: oneArgument('unavailableRetryRetryLineParts', 'key', unavailableRetryRetryLineParts),
  launchUnavailableGetLineParts: oneArgument('launchUnavailableGetLineParts', 'ref', launchUnavailableGetLineParts),
  launchUnavailableFormText: oneArgument('launchUnavailableFormText', 'form', launchUnavailableFormText),
  tmuxUnresponsiveLineHead: oneArgument('tmuxUnresponsiveLineHead', 'key', tmuxUnresponsiveLineHead),
  approverShutdownStopLine: oneArgument('approverShutdownStopLine', 'ref', approverShutdownStopLine),
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
