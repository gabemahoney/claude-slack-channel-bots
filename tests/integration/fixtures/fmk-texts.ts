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
 * The stuck-launch entries (scenario 21), each printing a `src/` export or a
 * builder's output for its arguments. <ref> is a persona reference as the
 * server logs it (`"<name>" (key=<key>)`), <key> a persona key, <name> a
 * persona name, <launch-start> a row's `launch_started_at` as agent-director
 * prints it, and <bound-ms> B in milliseconds:
 *   PENDING_ROW_RUN_NOT_JUDGED    src/pending-row.ts PENDING_ROW_RUN_NOT_JUDGED: the
 *                                 placement a pending-row rule round's line gives
 *                                 its bypassing `find-missing` run when the run left
 *                                 the `pending` row in neither list (not judged)
 *   PENDING_ROW_RULE_ORIGIN_RETRY src/pending-row.ts PENDING_ROW_RULE_ORIGIN_RETRY: the
 *                                 origin a rule line names for a run at a retry of
 *                                 the persona's retry timer
 *   PENDING_ROW_RULE_ORIGIN_APPROVER_STOP
 *                                 src/pending-row.ts
 *                                 PENDING_ROW_RULE_ORIGIN_APPROVER_STOP: the origin a
 *                                 rule line names for the run at the dialog
 *                                 approver's stop
 *   adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)
 *                                 src/ad-settings.ts adLaunchBoundMs over
 *                                 DEFAULT_AD_SETTINGS_IN_EFFECT: B, CSCB's launch
 *                                 bound at agent-director's default settings, in
 *                                 milliseconds
 * None of the above takes an argument.
 *   approverBoundLine <ref> <bound-ms>
 *                                 src/session-manager.ts approverLogLine over
 *                                 approverBoundMessage(<ref>, <bound-ms>,
 *                                 APPROVER_BOUND_FROM_LAUNCH_START): the one line the
 *                                 dialog approver writes when it stops at B measured
 *                                 from the launch start
 *   pendingRowRuleApproverStopRelaunchLine <ref>
 *                                 src/session-manager.ts
 *                                 pendingRowRuleApproverStopLine(<ref>,
 *                                 APPROVER_STOP_BOUND, …) for the rule's answer
 *                                 PENDING_ROW_RULE_RELAUNCH with
 *                                 PENDING_ROW_RELAUNCH_SEQUENCE_STARTED
 *                                 (src/pending-row.ts): the line of the rule's run at
 *                                 the approver's stop at B that made the relaunching
 *                                 post and the abort, and started the live-row
 *                                 sequence
 *   stuckLaunchRelaunchingPost <name> <key> <bound-ms>
 *                                 src/persona-notifier.ts formatPersonaNotice for the
 *                                 persona over src/pending-row.ts
 *                                 stuckLaunchRelaunchingText(<key>, <bound-ms>): the
 *                                 whole relaunching post as the persona notifier
 *                                 posts it
 *   stuckLaunchHeldPost <name> <key> <launch-start> <true|false>
 *                                 src/persona-notifier.ts formatPersonaNotice for the
 *                                 persona over src/pending-row.ts
 *                                 stuckLaunchHeldText(<key>, <launch-start>, <met
 *                                 not interactive>): the whole held post (with the
 *                                 attach remedy for `false`), multi-line
 *   describeLaunchStartForLog <launch-start>
 *                                 src/pending-row.ts describeLaunchStartForLog: the one
 *                                 renderer of a launch start, in the held text and
 *                                 the rule's lines
 *   stuckLaunchPostLine <key> <mark> <answer>
 *                                 src/pending-row.ts stuckLaunchPostLine(<key>, <mark>,
 *                                 <answer>), where <mark> is STUCK_LAUNCH_MARK_RELAUNCHING
 *                                 or STUCK_LAUNCH_MARK_HELD and <answer> one of the
 *                                 poster's answers (STUCK_LAUNCH_POSTED,
 *                                 STUCK_LAUNCH_ALREADY_POSTED, STUCK_LAUNCH_SUPPRESSED,
 *                                 STUCK_LAUNCH_NOT_POSTED_CLOSED,
 *                                 STUCK_LAUNCH_POST_FAILED), each given by its value:
 *                                 the poster's one line for that answer
 *   stuckLaunchAbortKillSucceededHead <key>
 *                                 src/pending-row.ts stuckLaunchAbortKillLine for the
 *                                 answer STUCK_LAUNCH_ABORT_KILL_SUCCEEDED whose
 *                                 description is src/checked-kill.ts
 *                                 describeKillOutcome of a KILL_OUTCOME_KILLED outcome
 *                                 with `kill_sent` true, cut where what follows
 *                                 begins: the abort kill's line up to and including
 *                                 the `— ` after the description
 *   liveRowSequenceStep3MarkedMissingLines <ref>
 *                                 src/live-row-sequence.ts liveRowSequenceRunLine(<ref>,
 *                                 3, <n>, LIVE_ROW_RUN_MARKED_MISSING) for each <n> from
 *                                 1 to LIVE_ROW_SEQUENCE_STEP3_RUNS, one line each:
 *                                 every line a step-3 run of the live-row sequence
 *                                 logs when it marked the row `missing`
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

/** An entry that takes exactly the arguments `argNames` names, in its usage error, and prints `read(args)`. */
function exactArguments(name: string, argNames: readonly string[], read: (args: readonly string[]) => Promise<string>): Entry {
  return async (args) => {
    if (args.length !== argNames.length) {
      throw new PrinterFailure(USAGE_EXIT, `${name} takes ${argNames.map((a) => `<${a}>`).join(' ')} (got ${args.length} argument(s))`)
    }
    return await read(args)
  }
}

/** Export `name` of `relPath`, which must be a function. */
async function functionExport(relPath: string, name: string): Promise<(...args: unknown[]) => unknown> {
  const value = await packageExport(relPath, name)
  if (typeof value !== 'function') throw new PrinterFailure(PACKAGE_EXIT, `the installed package's src/${relPath} ${name} is not a function`)
  return value as (...args: unknown[]) => unknown
}

/** A builder's output, which must be a string. */
function builtText(relPath: string, name: string, value: unknown): string {
  if (typeof value !== 'string') throw new PrinterFailure(PACKAGE_EXIT, `the installed package's src/${relPath} ${name} gave no text`)
  return value
}

/** `arg`, named `argName` in `entry`'s usage error, as a whole number of milliseconds. */
function wholeMsArgument(entry: string, argName: string, arg: string): number {
  if (!/^[0-9]+$/.test(arg)) throw new PrinterFailure(USAGE_EXIT, `${entry}: <${argName}> '${arg}' is not a whole number of milliseconds`)
  return Number(arg)
}

/** `arg`, named `argName` in `entry`'s usage error, as `true` or `false`. */
function booleanArgument(entry: string, argName: string, arg: string): boolean {
  if (arg !== 'true' && arg !== 'false') throw new PrinterFailure(USAGE_EXIT, `${entry}: <${argName}> '${arg}' is not true or false`)
  return arg === 'true'
}

/** `arg`, named `argName` in `entry`'s usage error, which must be one of the string exports `names` of `relPath`. */
async function oneOfExports(entry: string, argName: string, arg: string, relPath: string, names: readonly string[]): Promise<string> {
  const values = await Promise.all(names.map((n) => stringExport(relPath, n)))
  if (!values.includes(arg)) throw new PrinterFailure(USAGE_EXIT, `${entry}: <${argName}> '${arg}' is none of ${values.join(', ')}`)
  return arg
}

/** The posted text of a notice for the persona `name` with key `key`: the persona notifier's `formatPersonaNotice` over `text`. */
async function personaNotice(name: string, key: string, text: string): Promise<string> {
  const format = await functionExport('persona-notifier.ts', 'formatPersonaNotice')
  return builtText('persona-notifier.ts', 'formatPersonaNotice', format({ name, key }, text))
}

/** The approver's one line at B measured from the launch start, for `ref` and B `boundMs`. */
async function approverBoundLine(ref: string, boundMs: number): Promise<string> {
  const lineOf = await functionExport('session-manager.ts', 'approverLogLine')
  const messageOf = await functionExport('session-manager.ts', 'approverBoundMessage')
  const from = await stringExport('session-manager.ts', 'APPROVER_BOUND_FROM_LAUNCH_START')
  const message = builtText('session-manager.ts', 'approverBoundMessage', messageOf(ref, boundMs, from))
  return builtText('session-manager.ts', 'approverLogLine', lineOf(message))
}

/** The line of the rule's run at the approver's stop at B that answered the relaunch with the sequence started, for `ref`. */
async function pendingRowRuleApproverStopRelaunchLine(ref: string): Promise<string> {
  const lineOf = await functionExport('session-manager.ts', 'pendingRowRuleApproverStopLine')
  const bound = await stringExport('session-manager.ts', 'APPROVER_STOP_BOUND')
  const relaunch = await stringExport('pending-row.ts', 'PENDING_ROW_RULE_RELAUNCH')
  const started = await stringExport('pending-row.ts', 'PENDING_ROW_RELAUNCH_SEQUENCE_STARTED')
  return builtText('session-manager.ts', 'pendingRowRuleApproverStopLine', lineOf(ref, bound, { kind: relaunch, answer: { kind: started } }))
}

/** The relaunching post for the persona `name` with key `key`, with B `boundMs`. */
async function stuckLaunchRelaunchingPost(name: string, key: string, boundMs: number): Promise<string> {
  const textOf = await functionExport('pending-row.ts', 'stuckLaunchRelaunchingText')
  return await personaNotice(name, key, builtText('pending-row.ts', 'stuckLaunchRelaunchingText', textOf(key, boundMs)))
}

/** The held post for the persona `name` with key `key`, its launch start `launchStart` and `metNotInteractive`. */
async function stuckLaunchHeldPost(name: string, key: string, launchStart: string, metNotInteractive: boolean): Promise<string> {
  const textOf = await functionExport('pending-row.ts', 'stuckLaunchHeldText')
  return await personaNotice(name, key, builtText('pending-row.ts', 'stuckLaunchHeldText', textOf(key, launchStart, metNotInteractive)))
}

/** What follows the description in the abort kill's line; cut off with all after it. */
const FOLLOWS_MARK = 'fmk texts follows mark'

/** The abort kill's line for a success with `kill_sent` true for persona `key`, up to where what follows begins. */
async function stuckLaunchAbortKillSucceededHead(key: string): Promise<string> {
  const lineOf = await functionExport('pending-row.ts', 'stuckLaunchAbortKillLine')
  const describe = await functionExport('checked-kill.ts', 'describeKillOutcome')
  const succeeded = await stringExport('pending-row.ts', 'STUCK_LAUNCH_ABORT_KILL_SUCCEEDED')
  const killed = await stringExport('checked-kill.ts', 'KILL_OUTCOME_KILLED')
  const description = builtText('checked-kill.ts', 'describeKillOutcome', describe({ kind: killed, killSent: true }))
  const line = builtText('pending-row.ts', 'stuckLaunchAbortKillLine', lineOf(key, { kind: succeeded, killSent: true, description }, FOLLOWS_MARK))
  const at = line.indexOf(FOLLOWS_MARK)
  if (at <= 0) throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/pending-row.ts stuckLaunchAbortKillLine gave no line holding what follows")
  return line.slice(0, at)
}

/** Every step-3 run line of the live-row sequence for `ref` that marked the row `missing`, one per run number, joined by newlines. */
async function liveRowSequenceStep3MarkedMissingLines(ref: string): Promise<string> {
  const lineOf = await functionExport('live-row-sequence.ts', 'liveRowSequenceRunLine')
  const runs = Number(await wholeNumberAt('live-row-sequence.ts', 'LIVE_ROW_SEQUENCE_STEP3_RUNS', []))
  const marked = await stringExport('live-row-sequence.ts', 'LIVE_ROW_RUN_MARKED_MISSING')
  const lines: string[] = []
  for (let run = 1; run <= runs; run++) lines.push(builtText('live-row-sequence.ts', 'liveRowSequenceRunLine', lineOf(ref, 3, run, marked)))
  if (lines.length === 0) throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/live-row-sequence.ts LIVE_ROW_SEQUENCE_STEP3_RUNS names no run")
  return lines.join('\n')
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
  PENDING_ROW_RUN_NOT_JUDGED: noArguments('PENDING_ROW_RUN_NOT_JUDGED', () => stringExport('pending-row.ts', 'PENDING_ROW_RUN_NOT_JUDGED')),
  PENDING_ROW_RULE_ORIGIN_RETRY: noArguments('PENDING_ROW_RULE_ORIGIN_RETRY', () => stringExport('pending-row.ts', 'PENDING_ROW_RULE_ORIGIN_RETRY')),
  PENDING_ROW_RULE_ORIGIN_APPROVER_STOP: noArguments('PENDING_ROW_RULE_ORIGIN_APPROVER_STOP', () =>
    stringExport('pending-row.ts', 'PENDING_ROW_RULE_ORIGIN_APPROVER_STOP'),
  ),
  'adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)': noArguments('adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)', async () => {
    const bound = await functionExport('ad-settings.ts', 'adLaunchBoundMs')
    const value: unknown = bound(await packageExport('ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT'))
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new PrinterFailure(PACKAGE_EXIT, "the installed package's src/ad-settings.ts adLaunchBoundMs gave no whole number of milliseconds")
    }
    return String(value)
  }),
  approverBoundLine: exactArguments('approverBoundLine', ['ref', 'bound-ms'], ([ref, ms]) =>
    approverBoundLine(ref!, wholeMsArgument('approverBoundLine', 'bound-ms', ms!)),
  ),
  pendingRowRuleApproverStopRelaunchLine: oneArgument('pendingRowRuleApproverStopRelaunchLine', 'ref', pendingRowRuleApproverStopRelaunchLine),
  stuckLaunchRelaunchingPost: exactArguments('stuckLaunchRelaunchingPost', ['name', 'key', 'bound-ms'], ([name, key, ms]) =>
    stuckLaunchRelaunchingPost(name!, key!, wholeMsArgument('stuckLaunchRelaunchingPost', 'bound-ms', ms!)),
  ),
  stuckLaunchHeldPost: exactArguments('stuckLaunchHeldPost', ['name', 'key', 'launch-start', 'true|false'], ([name, key, start, met]) =>
    stuckLaunchHeldPost(name!, key!, start!, booleanArgument('stuckLaunchHeldPost', 'true|false', met!)),
  ),
  describeLaunchStartForLog: oneArgument('describeLaunchStartForLog', 'launch-start', async (start) => {
    const render = await functionExport('pending-row.ts', 'describeLaunchStartForLog')
    return builtText('pending-row.ts', 'describeLaunchStartForLog', render(start))
  }),
  stuckLaunchPostLine: exactArguments('stuckLaunchPostLine', ['key', 'mark', 'answer'], async ([key, mark, answer]) => {
    const lineOf = await functionExport('pending-row.ts', 'stuckLaunchPostLine')
    const m = await oneOfExports('stuckLaunchPostLine', 'mark', mark!, 'pending-row.ts', ['STUCK_LAUNCH_MARK_RELAUNCHING', 'STUCK_LAUNCH_MARK_HELD'])
    const a = await oneOfExports('stuckLaunchPostLine', 'answer', answer!, 'pending-row.ts', [
      'STUCK_LAUNCH_POSTED',
      'STUCK_LAUNCH_ALREADY_POSTED',
      'STUCK_LAUNCH_SUPPRESSED',
      'STUCK_LAUNCH_NOT_POSTED_CLOSED',
      'STUCK_LAUNCH_POST_FAILED',
    ])
    return builtText('pending-row.ts', 'stuckLaunchPostLine', lineOf(key, m, a))
  }),
  stuckLaunchAbortKillSucceededHead: oneArgument('stuckLaunchAbortKillSucceededHead', 'key', stuckLaunchAbortKillSucceededHead),
  liveRowSequenceStep3MarkedMissingLines: oneArgument('liveRowSequenceStep3MarkedMissingLines', 'ref', liveRowSequenceStep3MarkedMissingLines),
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
