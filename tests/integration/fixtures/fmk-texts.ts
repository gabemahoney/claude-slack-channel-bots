/**
 * fmk-texts.ts — the value printer of the fmk scenarios (b.jg5 SRJ-1401):
 * the one place a scenario script gets a CSCB-defined text, class label, log
 * fragment or setting value from. A shell script cannot import TypeScript,
 * and no scenario retypes such a value, so each value is printed from the
 * installed package under test (the tarball `/ci` installs into
 * /test-repo), through the export that builds or holds it. There is one
 * printer: a later scenario adds named entries to `ENTRIES` here, never a
 * second printer.
 *
 * REFUSAL
 * -------
 * Runs only in a cscb-ci image. Its first statement checks for the image
 * marker `/etc/cscb-ci-image`; without it, the printer prints
 * `FAIL: fmk-texts: refused: /etc/cscb-ci-image is absent …` on stderr and
 * exits 2, before it reads an argument or loads a module. Only `node:`
 * built-ins are imported statically: the package under test, and the
 * agent-director client that package resolves, are imported dynamically,
 * after the check, by the entry that needs them.
 *
 * USAGE
 * -----
 *   bun fmk-texts.ts <entry> [<arg>...]
 *
 * It prints the entry's value for its arguments on stdout, exactly, with
 * nothing added (no trailing newline), and exits 0. A script captures it
 * whole with a command substitution, standing alone:
 *
 *   label="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" ORPHAN_CLEANUP_LABEL)"
 *
 * An unknown entry, or the wrong number of arguments, prints one
 * `FAIL: fmk-texts: …` line on stderr and exits 64; a package that lacks an
 * export the entry needs, or an entry that throws, prints one
 * `FAIL: fmk-texts: …` line and exits 1. Nothing is printed on stdout then.
 *
 * It makes no agent-director call, starts no process or server, opens no
 * socket, reads no token and writes no file. It is not a CSCB process: a
 * scenario runs it from its own shell.
 *
 * INPUTS (env)
 * ------------
 *   CSCB_PKG_DIR   the installed package (default
 *                  /test-repo/node_modules/claude-slack-channel-bots), as
 *                  `driver.ts` and `fmk-driver.ts` take it
 *
 * ENTRIES (each names the `src/` export it prints)
 * -------
 * Persona identity (src/persona-identity.ts):
 *   personaInstanceId <key>          `personaInstanceId(key)`
 *   formatPersonaNotice <name>       the persona notifier's prefix of every
 *                                    notice it posts for the persona named
 *                                    <name> (its key from `personaKey`):
 *                                    `formatPersonaNotice(persona, '')`
 *                                    (src/persona-notifier.ts)
 * Scenario 2, a kill that really fails (test-14; b.jg5 SRJ-1403, SRJ-704,
 * SRJ-1007, SRJ-1013, SRJ-1014):
 *   LAST_APPLIED_FILE_SUFFIX         the suffix of the last-applied record
 *                                    beside config.json (src/reload.ts)
 *   ORPHAN_CLEANUP_LABEL             the start sweep's startup-errors class
 *                                    (src/kill-failure-alert.ts)
 *   RETRY_KILL_LATER_PHRASE          agent-director's kill-failure words
 *   NEVER_DELETE_ROW_PHRASE          (src/ad-description-phrases.ts)
 *   KILL_RETRY_TRIES                 the bounded retry's tries (src/kill-retry.ts)
 *   killRetryTryLine.description-head <instance-id> <try>
 *                                    the fixed part of the bounded retry's
 *                                    per-try line (`killRetryTryLine`,
 *                                    src/kill-retry.ts) for an
 *                                    `ErrTmuxKillFailed` try <try> of
 *                                    KILL_RETRY_TRIES of <instance-id>, from
 *                                    its `: kill try` up to the JSON-quoted
 *                                    description (`describeKillOutcome`,
 *                                    src/checked-kill.ts): a script finds the
 *                                    line holding it and reads agent-director's
 *                                    description, JSON-decoded, right after it
 *   killRetryEndLine.head <instance-id>
 *   killRetryEndLine.tail <instance-id>
 *                                    the parts of the bounded retry's end line
 *                                    (`killRetryEndLine`) before and after the
 *                                    outcome, for <instance-id>'s tries that
 *                                    ended exhausted after KILL_RETRY_TRIES
 *                                    kills with the ordinary alert decided
 *   startSweepKillFailedEntry <instance-id> <persona> <state> <session> <description>
 *                                    the start sweep's `orphan-cleanup` entry
 *                                    head (src/session-manager.ts) for a swept
 *                                    row whose kill stands as an
 *                                    `ErrTmuxKillFailed` carrying <description>
 *                                    (`killOutcomeOf`, `describeKillOutcome`)
 *   killFailureAlertEntryText.start-sweep <instance-id> <session> <description>
 *                                    the kill-failure alert's ordinary version
 *                                    in its start-sweep log-line and
 *                                    `orphan-cleanup` entry form, with that
 *                                    route's closing sentence
 *                                    (`selectKillFailureAlertRoute`,
 *                                    `killFailureAlertContentOf`,
 *                                    `killFailureAlertText`,
 *                                    `killFailureAlertEntryText`,
 *                                    src/kill-failure-alert.ts)
 *   killFailureAlertText.destination <instance-id> <session> <description>
 *                                    the ordinary version as posted at a
 *                                    configured, unlatched persona's
 *                                    destination (context `recovery`), the
 *                                    body after the persona notifier's prefix
 *                                    (`formatPersonaNotice` above): escaped for
 *                                    Slack, with the "keeps retrying" closing
 *                                    sentence
 *   uncoveredPendingRowLine <name> <reason>
 *                                    the line for the persona named <name>'s
 *                                    `pending` row that is not covered, sent to
 *                                    the live-row sequence
 *                                    (`uncoveredPendingRowLine`,
 *                                    src/session-manager.ts), <reason> the
 *                                    name of a `PENDING_ROW_REASON_*` export of
 *                                    src/pending-row.ts (its persona reference
 *                                    from `renderPersonaRef`)
 *   tmuxUnresponsiveOnsetText <key>  the `tmux-unresponsive` onset's body
 *                                    (src/persona-episodes.ts), for absence
 *                                    checks
 *
 * SPDX-License-Identifier: MIT
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: fmk-texts: refused: /etc/cscb-ci-image is absent; this printer runs only in a cscb-ci image (/ci)')
  process.exit(2)
}

/** The name the printer's FAIL lines carry. */
const PRINTER_NAME = 'fmk-texts'

/** Exit status for an unknown entry or the wrong arguments (EX_USAGE). */
const USAGE_EXIT = 64

/** Exit status for a missing export or an entry that threw. */
const ENTRY_FAIL_EXIT = 1

/** The installed package under test. */
const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

/**
 * A stand-in description, for entries that cut a line at the description:
 * letters only, so redaction, JSON quoting and Slack escaping leave it as it
 * is, and found once in the line it is put in.
 */
const DESCRIPTION_STAND_IN = 'FMKTEXTSDESCRIPTIONSTANDIN'

/** A usage or export failure, carried to the one FAIL line. */
class PrinterFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message)
  }
}

/** One entry: its arguments' names, and the value it prints for them. */
interface Entry {
  readonly args: readonly string[]
  readonly print: (args: readonly string[]) => Promise<string>
}

/** Import the installed package's `src/<relPath>`. */
async function packageModule(relPath: string): Promise<Record<string, unknown>> {
  return (await import(join(PKG_DIR, 'src', relPath))) as Record<string, unknown>
}

/** Export `name` of `src/<relPath>`, which must be a function. */
async function fn<F>(relPath: string, name: string): Promise<F> {
  const value = (await packageModule(relPath))[name]
  if (typeof value !== 'function') throw new PrinterFailure(`the installed package's src/${relPath} exports no function ${name}`, ENTRY_FAIL_EXIT)
  return value as F
}

/** Export `name` of `src/<relPath>`, which must be defined. */
async function value(relPath: string, name: string): Promise<unknown> {
  const v = (await packageModule(relPath))[name]
  if (v === undefined) throw new PrinterFailure(`the installed package's src/${relPath} exports no ${name}`, ENTRY_FAIL_EXIT)
  return v
}

/** Export `name` of `src/<relPath>` as text (a string, or a number printed as it is). */
async function text(relPath: string, name: string): Promise<string> {
  const v = await value(relPath, name)
  if (typeof v !== 'string' && typeof v !== 'number') throw new PrinterFailure(`src/${relPath}'s ${name} is neither a string nor a number`, ENTRY_FAIL_EXIT)
  return String(v)
}

/** `<try>` as a whole number from 1. */
function tryNumber(raw: string): number {
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1) throw new PrinterFailure(`try '${raw}' is not a whole number from 1`, USAGE_EXIT)
  return n
}

/** The bounded retry's tries (`KILL_RETRY_TRIES`). */
async function killRetryTries(): Promise<number> {
  const tries = await value('kill-retry.ts', 'KILL_RETRY_TRIES')
  if (typeof tries !== 'number') throw new PrinterFailure("src/kill-retry.ts's KILL_RETRY_TRIES is not a number", ENTRY_FAIL_EXIT)
  return tries
}

/**
 * The kill outcome of an `ErrTmuxKillFailed` carrying `description`, as the
 * checked kill reads it (`killOutcomeOf`), from the client class the package
 * re-exports (src/agent-director-errors.ts).
 */
async function killFailedOutcome(description: string): Promise<unknown> {
  const errors = await packageModule('agent-director-errors.ts')
  const KillFailed = errors['ErrTmuxKillFailed']
  const name = errors['ERR_TMUX_KILL_FAILED_NAME']
  if (typeof KillFailed !== 'function' || typeof name !== 'string') {
    throw new PrinterFailure("the installed package's src/agent-director-errors.ts exports no ErrTmuxKillFailed and ERR_TMUX_KILL_FAILED_NAME", ENTRY_FAIL_EXIT)
  }
  const thrown = new (KillFailed as new (verb: string, errName: string, errDescription: string) => Error)('', name, description)
  const killOutcomeOf = await fn<(settled: { thrown: unknown }) => unknown>('checked-kill.ts', 'killOutcomeOf')
  return killOutcomeOf({ thrown })
}

/** `describeKillOutcome` of `outcome`. */
async function describeKillOutcome(outcome: unknown): Promise<string> {
  return (await fn<(o: unknown) => string>('checked-kill.ts', 'describeKillOutcome'))(outcome)
}

/** `line` before and after the one place `part` sits in it. */
function around(line: string, part: string, what: string): { readonly head: string; readonly tail: string } {
  const at = line.indexOf(part)
  if (at < 0 || line.indexOf(part, at + 1) >= 0) throw new PrinterFailure(`${what} does not hold its outcome exactly once`, ENTRY_FAIL_EXIT)
  return { head: line.slice(0, at), tail: line.slice(at + part.length) }
}

/**
 * The bounded retry's end line (`killRetryEndLine`, no prefix) for
 * `instanceId`'s tries that ended exhausted after `KILL_RETRY_TRIES` kills,
 * with a read before each further try and the ordinary alert decided, cut
 * around its outcome.
 */
async function killRetryEndLineParts(instanceId: string): Promise<{ readonly head: string; readonly tail: string }> {
  const tries = await killRetryTries()
  const outcome = await killFailedOutcome(DESCRIPTION_STAND_IN)
  const end = await value('kill-retry.ts', 'KILL_RETRY_END_EXHAUSTED')
  const ordinary = await value('kill-retry.ts', 'KILL_RETRY_ALERT_ORDINARY')
  const endLine = await fn<(prefix: string, id: string, result: object) => string>('kill-retry.ts', 'killRetryEndLine')
  const line = endLine('', instanceId, { outcome, end, tries, reads: tries - 1, alert: { kind: ordinary, lastKillFailedDescription: DESCRIPTION_STAND_IN } })
  return around(line, await describeKillOutcome(outcome), 'killRetryEndLine')
}

/** The ordinary alert's content for `description` (`killFailureAlertContentOf`). */
async function ordinaryContent(instanceId: string, session: string, description: string): Promise<unknown> {
  const ordinary = await value('kill-retry.ts', 'KILL_RETRY_ALERT_ORDINARY')
  const contentOf = await fn<(decision: object, session: string, id: string) => unknown>('kill-failure-alert.ts', 'killFailureAlertContentOf')
  return contentOf({ kind: ordinary, lastKillFailedDescription: description }, session, instanceId)
}

/** The ordinary version's route for `context` (`selectKillFailureAlertRoute`). */
async function ordinaryRoute(context: unknown, configured: boolean): Promise<{ readonly closing: unknown }> {
  const version = await value('kill-failure-alert.ts', 'KILL_FAILURE_VERSION_ORDINARY')
  const select = await fn<(input: object) => { closing: unknown }>('kill-failure-alert.ts', 'selectKillFailureAlertRoute')
  return select({ version, context, configured, latched: false })
}

/** `killFailureAlertText` of `content` for `closing`. */
async function alertText(content: unknown, closing: unknown, forSlack: boolean): Promise<string> {
  return (await fn<(c: unknown, closing: unknown, forSlack: boolean) => string>('kill-failure-alert.ts', 'killFailureAlertText'))(content, closing, forSlack)
}

/** The entries, by the name a script passes. */
const ENTRIES: Readonly<Record<string, Entry>> = {
  personaInstanceId: {
    args: ['key'],
    print: async ([key]) => (await fn<(k: string) => string>('persona-identity.ts', 'personaInstanceId'))(key),
  },
  formatPersonaNotice: {
    args: ['name'],
    print: async ([name]) => {
      const key = (await fn<(n: string) => string>('persona-identity.ts', 'personaKey'))(name)
      return (await fn<(p: { name: string; key: string }, t: string) => string>('persona-notifier.ts', 'formatPersonaNotice'))({ name, key }, '')
    },
  },
  LAST_APPLIED_FILE_SUFFIX: { args: [], print: () => text('reload.ts', 'LAST_APPLIED_FILE_SUFFIX') },
  ORPHAN_CLEANUP_LABEL: { args: [], print: () => text('kill-failure-alert.ts', 'ORPHAN_CLEANUP_LABEL') },
  RETRY_KILL_LATER_PHRASE: { args: [], print: () => text('ad-description-phrases.ts', 'RETRY_KILL_LATER_PHRASE') },
  NEVER_DELETE_ROW_PHRASE: { args: [], print: () => text('ad-description-phrases.ts', 'NEVER_DELETE_ROW_PHRASE') },
  KILL_RETRY_TRIES: { args: [], print: async () => String(await killRetryTries()) },
  'killRetryTryLine.description-head': {
    args: ['instance-id', 'try'],
    print: async ([instanceId, raw]) => {
      const n = tryNumber(raw)
      const tries = await killRetryTries()
      const outcome = await killFailedOutcome(DESCRIPTION_STAND_IN)
      const next = await value('kill-retry.ts', n < tries ? 'KILL_RETRY_NEXT_AGAIN' : 'KILL_RETRY_NEXT_EXHAUSTED')
      const tryLine = await fn<(prefix: string, id: string, n: number, max: number, outcome: unknown, next: unknown) => string>('kill-retry.ts', 'killRetryTryLine')
      return around(tryLine('', instanceId, n, tries, outcome, next), JSON.stringify(DESCRIPTION_STAND_IN), 'killRetryTryLine').head
    },
  },
  'killRetryEndLine.head': { args: ['instance-id'], print: async ([instanceId]) => (await killRetryEndLineParts(instanceId)).head },
  'killRetryEndLine.tail': { args: ['instance-id'], print: async ([instanceId]) => (await killRetryEndLineParts(instanceId)).tail },
  startSweepKillFailedEntry: {
    args: ['instance-id', 'persona', 'state', 'session', 'description'],
    print: async ([instanceId, persona, state, session, description]) => {
      const outcome = await describeKillOutcome(await killFailedOutcome(description))
      const entry = await fn<(input: object) => string>('session-manager.ts', 'startSweepKillFailedEntry')
      return entry({ instanceId, persona, state, session, outcome, stoppedAtShutdown: false })
    },
  },
  'killFailureAlertEntryText.start-sweep': {
    args: ['instance-id', 'session', 'description'],
    print: async ([instanceId, session, description]) => {
      const context = await value('kill-failure-alert.ts', 'KILL_FAILURE_CONTEXT_START_SWEEP')
      const route = await ordinaryRoute(context, false)
      const body = await alertText(await ordinaryContent(instanceId, session, description), route.closing, false)
      const entryText = await fn<(ref: string, context: unknown, text: string) => string>('kill-failure-alert.ts', 'killFailureAlertEntryText')
      // The row's reference as the start sweep writes it, `instanceId=<id>`
      // (src/session-manager.ts sweepKillAlertEntry; no exported builder).
      return entryText(`instanceId=${instanceId}`, context, body)
    },
  },
  'killFailureAlertText.destination': {
    args: ['instance-id', 'session', 'description'],
    print: async ([instanceId, session, description]) => {
      const context = await value('kill-failure-alert.ts', 'KILL_FAILURE_CONTEXT_RECOVERY')
      const route = await ordinaryRoute(context, true)
      return alertText(await ordinaryContent(instanceId, session, description), route.closing, true)
    },
  },
  uncoveredPendingRowLine: {
    args: ['name', 'reason'],
    print: async ([name, reasonName]) => {
      if (!/^PENDING_ROW_REASON_[A-Z_]+$/.test(reasonName)) throw new PrinterFailure(`reason '${reasonName}' is not a PENDING_ROW_REASON_* export's name`, USAGE_EXIT)
      const reason = await value('pending-row.ts', reasonName)
      const ref = (await fn<(n: string) => string>('persona-identity.ts', 'renderPersonaRef'))(name)
      return (await fn<(r: string, why: unknown) => string>('session-manager.ts', 'uncoveredPendingRowLine'))(ref, reason)
    },
  },
  tmuxUnresponsiveOnsetText: {
    args: ['key'],
    print: async ([key]) => (await fn<(k: string) => string>('persona-episodes.ts', 'tmuxUnresponsiveOnsetText'))(key),
  },
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv
  const known = Object.keys(ENTRIES).sort().join(', ')
  try {
    if (name === undefined || name === '') throw new PrinterFailure(`no entry was named; usage: bun fmk-texts.ts <entry> [<arg>...] (entries: ${known})`, USAGE_EXIT)
    const entry = Object.hasOwn(ENTRIES, name) ? ENTRIES[name] : undefined
    if (entry === undefined) throw new PrinterFailure(`unknown entry '${name}' (entries: ${known})`, USAGE_EXIT)
    if (args.length !== entry.args.length) {
      throw new PrinterFailure(`${name} takes ${entry.args.length} argument(s) (${entry.args.map((a) => `<${a}>`).join(' ') || 'none'}), got ${args.length}`, USAGE_EXIT)
    }
    const printed = await entry.print(args)
    // Flushed before the exit, so a pipe gets the whole value.
    await new Promise<void>((resolve) => {
      process.stdout.write(printed, () => resolve())
    })
    return 0
  } catch (err) {
    const code = err instanceof PrinterFailure ? err.exitCode : ENTRY_FAIL_EXIT
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`FAIL: ${PRINTER_NAME}: ${name ?? ''}: ${reason.replace(/\s*\n\s*/g, ' ')}`)
    return code
  }
}

process.exit(await main(process.argv.slice(2)))
