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
 * Scenarios 16 and 15, an upgrade's start sweep with one failing kill and a
 * persona removal whose kill fails (test-14; b.jg5 SRJ-1417, SRJ-714,
 * SRJ-715, SRJ-801, SRJ-802, SRJ-1003, SRJ-1007, SRJ-1013, SRJ-1020):
 *   SERVICE_LABEL, PERSONA_LABEL_KEY the `service` label CSCB's rows carry and
 *                                    the `persona` label's key
 *                                    (src/persona-identity.ts)
 *   personaTmuxSessionName <key>     a persona's own tmux session name
 *                                    (src/persona-identity.ts)
 *   PENDING_FILE_SUFFIX              the suffixes of the pending file and the
 *   APPLY_FILE_SUFFIX                confirmation beside config.json
 *                                    (src/reload.ts)
 *   PERSONA_TEARDOWN_NOTICE_LABEL    the persona teardown's startup-errors
 *                                    class (src/kill-failure-alert.ts)
 *   RETIRED_KEYS_FILE_NAME           the retired-key record's file name, its
 *   retiredKeysPath <state-dir>      path in the server's state directory
 *   RETIRED_KEY_CAUSE_REMOVED        and the causes `removed` and
 *   RETIRED_KEY_CAUSE_ABSENT_AT_START `absent-at-start` (src/retired-keys.ts)
 *   startSweepKillFailedEntry.pre-persona <instance-id> <state> <session> <description>
 *                                    the start sweep's `orphan-cleanup` entry
 *                                    head for a pre-persona row (no `persona`
 *                                    label), as `startSweepKillFailedEntry`
 *                                    above; its alert is
 *                                    `killFailureAlertEntryText.start-sweep`
 *                                    with the row's instance id
 *   startSweepKillSucceededLine.head <instance-id> <persona>
 *   startSweepKillSucceededLine.pre-persona-head <instance-id>
 *   startSweepKillSucceededLine.tail <instance-id>
 *                                    the parts of the start sweep's per-row
 *                                    line for a kill whose success stands
 *                                    (`startSweepKillSucceededLine`,
 *                                    src/session-manager.ts) before and after
 *                                    the outcome: for a swept row (<persona>
 *                                    as the line names it: an absent
 *                                    persona's label value) or a pre-persona
 *                                    row
 *   startSweepSummaryLine <listed> <killed> <kept> <kill-failed> <recorded-as-retired> <left-for-latch>
 *                                    the start sweep's summary line for those
 *                                    counts (src/session-manager.ts)
 *   startSweepSummaryLine.head       its fixed part before the first count
 *   startSweepLatchedFromOwnRowLine.launch-start-not-recorded <name> <instance-id>
 *                                    the start sweep's line for the persona
 *                                    named <name> latched from its own listed
 *                                    row with the case "launch start not
 *                                    recorded" (src/session-manager.ts,
 *                                    LATCH_CASE_LAUNCH_START_NOT_RECORDED,
 *                                    src/conflict-latch.ts)
 *   launchStartNotRecordedNoticeText <key>
 *                                    the launch-start-not-recorded post's body
 *                                    for persona <key>, naming its session
 *                                    (src/conflict-latch.ts); the posted text
 *                                    is `formatPersonaNotice` above, then this
 *   personaTeardownNoticeEntryText.kill-failure <name> <session> <description>
 *                                    the kill-failure alert's ordinary version
 *                                    on the persona-teardown route, in its
 *                                    `persona-teardown-notice` entry form: the
 *                                    persona named <name>, "raised during its
 *                                    teardown", then the alert for its own row
 *                                    and <session> with that route's closing
 *                                    sentence, unescaped
 *                                    (`personaTeardownNoticeEntryText`,
 *                                    src/persona-notifier.ts; the alert as
 *                                    `killFailureAlertEntryText.start-sweep`
 *                                    builds it, with context
 *                                    KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN)
 * Scenario 6, a wedged tmux (test-18; b.jg5 SRJ-1408, SRJ-302, SRJ-307 to
 * SRJ-310, SRJ-702, SRJ-1006, AC 56):
 *   tmuxUnresponsiveAlertText <key>  the `tmux-unresponsive` alert's body for
 *                                    persona <key> at the alert threshold of
 *                                    agent-director's default settings
 *                                    (src/persona-episodes.ts, the threshold
 *                                    as `adAlertThresholdMs.default` below)
 *   tmuxUnresponsiveRecoveryText <key>
 *                                    the recovery's body (src/persona-episodes.ts)
 *   tmuxUnresponsiveStartedLine.head <key>
 *                                    the condition's started line
 *                                    (`tmuxUnresponsiveStartedLine`,
 *                                    src/persona-episodes.ts) up to the
 *                                    refusing verb: a script reads the
 *                                    persona's first refusal's time from it
 *   adAlertThresholdMs.default       the alert threshold in milliseconds at
 *                                    agent-director's default settings
 *                                    (`adAlertThresholdMs` of
 *                                    DEFAULT_AD_SETTINGS_IN_EFFECT,
 *                                    src/ad-settings.ts)
 *   UNAVAILABLE_RETRY_BASE_S         the retry timer's first wait and its
 *   UNAVAILABLE_RETRY_CEILING_S      ceiling, in seconds (src/unavailable-retry.ts)
 *   TMUX_UNRESPONSIVE_ONSET_FLOOR_MS the onset's floor with the health check
 *                                    off (src/persona-episodes.ts)
 *   restartCapReachedNoticeText      the restart-cap notice's body
 *                                    (src/session-manager.ts), for absence
 *                                    checks
 *   restartRetryCapSkippedLine <key> the retry entry's line for a persona at
 *                                    the restart cap (src/restart.ts)
 *   UNAVAILABLE_RETRY_STOP_CAPPED    the retry timer's stop reason at the
 *                                    restart cap (src/unavailable-retry.ts)
 *   DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS
 *                                    CSCB's default agent-director call
 *                                    timeout (src/config.ts, b.jg5 SRJ-213)
 *   KILL_RETRY_SPACING_MS            the wait between a kill's tries
 *                                    (src/kill-retry.ts)
 *   killRetryTryLine.head <instance-id> <try> <max>
 *   killRetryTryLine.tail <next>     the parts of the bounded retry's per-try
 *                                    line (`killRetryTryLine`, no prefix)
 *                                    before and after its outcome, for try
 *                                    <try> of <max> of <instance-id>, and for
 *                                    what follows it, <next> the name of a
 *                                    `KILL_RETRY_NEXT_*` export of
 *                                    src/kill-retry.ts
 * Scenario 9, teardowns that meet a conflict (test-21; b.jg5 SRJ-1411,
 * SRJ-901, SRJ-903 to SRJ-907, SRJ-909, SRJ-1007, SRJ-1013). <command> is the
 * name of a `CLI_COMMAND_*` export of src/cli-teardown.ts, <class> the name of
 * an `AD_ERROR_CLASS_*` export of src/ad-error-class.ts, and a persona is
 * named by <name> (its key from `personaKey`, its session from
 * `personaTmuxSessionName`):
 *   CLI_COMMAND_CLEAN_RESTART        the two teardown commands as their lines
 *   CLI_COMMAND_STOP_BOTS            name them (src/cli-teardown.ts)
 *   adErrorClass <class>             the class label (src/ad-error-class.ts)
 *   adErrorName <error-class>        the error name of the agent-director error
 *                                    class <error-class> the package re-exports
 *                                    (src/agent-director-errors.ts; for
 *                                    example ErrSpawnNotPausable)
 *   CONFLICT_PANE_NOT_FOUND_PHRASE   agent-director's CONFLICT words "the
 *                                    agent's pane was not found"
 *                                    (src/ad-description-phrases.ts)
 *   precheckFailureLine.head <command> <name> <class>
 *                                    the precheck's failure line
 *                                    (`precheckFailureLine`) up to its
 *                                    description: the persona, key, session
 *                                    and class
 *   precheckNothingStoppedLine <command>
 *                                    the failed precheck's last line
 *   teardownFailureLine.head <command> <name> <class>
 *                                    a persona's teardown failure line
 *                                    (`teardownFailureLine`) up to its
 *                                    description
 *   cliTeardownKillFailed.failure-line <command> <name> <description>
 *   cliTeardownKillFailed.alert-line <command> <name> <description>
 *   cliTeardownKillFailed.entry-class <command> <name> <description>
 *   cliTeardownKillFailed.entry-message <command> <name> <description>
 *                                    the report of a persona whose teardown
 *                                    kill's tries ended exhausted on an
 *                                    `ErrTmuxKillFailed` carrying
 *                                    <description> with the ordinary alert
 *                                    decided (`teardownKillOutcomeOf`, then
 *                                    `personaTeardownReportOf`,
 *                                    src/cli-teardown.ts): its failure line,
 *                                    the kill-failure alert's ordinary
 *                                    version for the CLI-teardown route with
 *                                    its closing sentence (the line after
 *                                    it), and its startup-errors entry's
 *                                    class and message
 *   teardownNotStoppedLine <command> <count>
 *                                    the command's last line when <count>
 *                                    personas could not be stopped
 *   PERSONA_KILL_FAILED_LABEL        the CLI-teardown route's startup-errors
 *                                    class (src/kill-failure-alert.ts)
 *   CLEAN_RESTART_NOT_RESTARTED_LABEL
 *                                    the not-restarted alert's class
 *                                    (src/cli-teardown.ts)
 *   cleanRestartNotRestartedAlert <class> <names>
 *                                    `clean_restart`'s not-restarted alert
 *                                    for the personas <names> (comma-
 *                                    separated, in configuration order), each
 *                                    failed under <class>
 *   answerCheckFailedTryLine.head <try>
 *                                    `clean_restart`'s answer check's line
 *                                    for a failed `list` try <try>
 *                                    (`answerCheckFailedTryLine`) up to its
 *                                    class
 *   adGraceMs.default                agent-director's pending grace period G
 *                                    in milliseconds at its default settings
 *                                    (`adGraceMs` of
 *                                    DEFAULT_AD_SETTINGS_IN_EFFECT,
 *                                    src/ad-settings.ts)
 * Scenario 7, reuse replaces delete (test-19; b.jg5 SRJ-1409, SRJ-413,
 * SRJ-707, SRJ-712):
 *   preTrustLogLine <name> <verb> <value>
 *                                    the one `pre_trust` line a successful
 *                                    launch logs (`preTrustLogLine`,
 *                                    src/session-manager.ts) for the persona
 *                                    named <name> (its reference from
 *                                    `renderPersonaRef`), <verb> the name of a
 *                                    `LAUNCH_VERB_*` export of
 *                                    src/session-manager.ts (for example
 *                                    LAUNCH_VERB_REUSE_SPAWN) and <value> the
 *                                    result's `pre_trust` (for example `ok`)
 *   JSONL_DIAGNOSIS_REUSE_WORDING    the fixed fragment every log line of the
 *                                    lost-transcript diagnosis
 *                                    (`diagnoseJsonlMissing`,
 *                                    src/session-manager.ts) holds: the
 *                                    persona brought up fresh by a reuse spawn
 *                                    of the same instance, its row kept
 *   JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS
 *   JSONL_TRANSCRIPT_LOST_ENTRY_CLASS
 *                                    the diagnosis's startup-errors classes
 *                                    (src/session-manager.ts)
 * Scenario 12, a missing row with no session id and an ended row with a
 * stale `config_dir` label beside a running session (test-19; b.jg5
 * SRJ-1414, SRJ-707, SRJ-410):
 *   classifyAdError <error-class>    the class label `classifyAdError`
 *                                    (src/ad-error-class.ts) gives an error of
 *                                    the agent-director error class
 *                                    <error-class> the package re-exports
 *                                    (src/agent-director-errors.ts; for
 *                                    example ErrTmuxSessionConflict), made
 *                                    with the verb `spawn`, its own name and
 *                                    an empty description: a script reads a
 *                                    refused call's class from the error name
 *                                    its log line names
 * Scenario 18, a persona removed and re-added, and one whose
 * `credentials_file` changes, comes back fresh by reuse (test-19; b.jg5
 * SRJ-1419, SRJ-803, SRJ-805):
 *   RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY
 *                                    the retired-key record's cause of the old
 *                                    half of a destructive modify
 *                                    (src/retired-keys.ts)
 *   reloadAppliedLogLine <added> <removed> <destructive> <in-place> <credentials> <settings> <config-path>
 *                                    the `reload-applied` line an apply logs
 *                                    once all its steps ran
 *                                    (`renderAppliedLogLine`,
 *                                    src/reload-apply.ts) for a change plan of
 *                                    those counts (`changePlanCounts`,
 *                                    src/reload-plan.ts, reads only its
 *                                    classes' lengths, so the plan holds
 *                                    stand-in entries), naming the
 *                                    last-applied record beside the
 *                                    configuration file at <config-path>
 *                                    (`reloadFilePaths`, src/reload.ts)
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

/**
 * A stand-in count, for the entry that cuts the start sweep's summary line
 * at its first count: found once in the line it is put in.
 */
const COUNT_STAND_IN = 918273645

/** `<n>` as a whole number from 0. */
function count(raw: string): number {
  const n = Number(raw)
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n)) throw new PrinterFailure(`count '${raw}' is not a whole number from 0`, USAGE_EXIT)
  return n
}

/**
 * The start sweep's line for a kill whose success stands
 * (`startSweepKillSucceededLine`, src/session-manager.ts) for `instanceId`
 * (named `persona`; none for a pre-persona row), cut around its outcome
 * (`describeKillOutcome` of a kill that answered `kill_sent` true).
 */
async function startSweepKillSucceededParts(instanceId: string, persona: string | undefined): Promise<{ readonly head: string; readonly tail: string }> {
  const killOutcomeOf = await fn<(settled: { result: unknown }) => unknown>('checked-kill.ts', 'killOutcomeOf')
  const outcome = killOutcomeOf({ result: { kill_sent: true } })
  const line = (await fn<(id: string, p: string | undefined, o: unknown) => string>('session-manager.ts', 'startSweepKillSucceededLine'))(instanceId, persona, outcome)
  return around(line, await describeKillOutcome(outcome), 'startSweepKillSucceededLine')
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

/** The alert threshold at agent-director's default settings (`adAlertThresholdMs`). */
async function defaultAlertThresholdMs(): Promise<number> {
  const defaults = await value('ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT')
  return (await fn<(values: unknown) => number>('ad-settings.ts', 'adAlertThresholdMs'))(defaults)
}

/** A stand-in verb, for the entry that cuts the condition's started line at its verb: found once in it. */
const VERB_STAND_IN = 'FMKTEXTSVERBSTANDIN'

/**
 * The bounded retry's per-try line (`killRetryTryLine`, no prefix) for try
 * `n` of `max` of `instanceId`, followed by `next`, cut around its outcome
 * (an `ErrTmuxKillFailed` naming no survivor, so no survivor clause sits
 * between the outcome and what follows).
 */
async function killRetryTryLineParts(instanceId: string, n: number, max: number, next: unknown): Promise<{ readonly head: string; readonly tail: string }> {
  const outcome = await killFailedOutcome(DESCRIPTION_STAND_IN)
  const tryLine = await fn<(prefix: string, id: string, n: number, max: number, outcome: unknown, next: unknown) => string>('kill-retry.ts', 'killRetryTryLine')
  return around(tryLine('', instanceId, n, max, outcome, next), await describeKillOutcome(outcome), 'killRetryTryLine')
}

/** A stand-in class label, for the entry that cuts a line at its class: found once in it. */
const CLASS_STAND_IN = 'FMKTEXTSCLASSSTANDIN'

/** The value of the `CLI_COMMAND_*` export named `name` (src/cli-teardown.ts). */
async function cliCommand(name: string): Promise<string> {
  if (!/^CLI_COMMAND_[A-Z_]+$/.test(name)) throw new PrinterFailure(`command '${name}' is not a CLI_COMMAND_* export's name`, USAGE_EXIT)
  return text('cli-teardown.ts', name)
}

/** The value of the `AD_ERROR_CLASS_*` export named `name` (src/ad-error-class.ts). */
async function adErrorClass(name: string): Promise<string> {
  if (!/^AD_ERROR_CLASS_[A-Z_]+$/.test(name)) throw new PrinterFailure(`class '${name}' is not an AD_ERROR_CLASS_* export's name`, USAGE_EXIT)
  return text('ad-error-class.ts', name)
}

/** The persona named `name` as the CLI's lines take it: its name and key (`personaKey`). */
async function cliPersona(name: string): Promise<{ readonly name: string; readonly key: string }> {
  return { name, key: (await fn<(n: string) => string>('persona-identity.ts', 'personaKey'))(name) }
}

/**
 * The report (`personaTeardownReportOf`) of the persona named `name` under
 * the `CLI_COMMAND_*` export `commandName`, whose teardown kill's tries
 * ended exhausted after `KILL_RETRY_TRIES` kills on an `ErrTmuxKillFailed`
 * carrying `description`, with the ordinary alert decided, its outcome
 * mapped by `teardownKillOutcomeOf` as the CLI maps it.
 */
async function cliTeardownKillFailedReport(
  commandName: string,
  name: string,
  description: string,
): Promise<{ readonly printed: readonly string[]; readonly entry?: { readonly classLabel: string; readonly message: string } }> {
  const command = await cliCommand(commandName)
  const persona = await cliPersona(name)
  const tries = await killRetryTries()
  const result = {
    outcome: await killFailedOutcome(description),
    end: await value('kill-retry.ts', 'KILL_RETRY_END_EXHAUSTED'),
    tries,
    reads: tries - 1,
    alert: { kind: await value('kill-retry.ts', 'KILL_RETRY_ALERT_ORDINARY'), lastKillFailedDescription: description },
  }
  const outcome = (await fn<(r: object) => unknown>('cli-teardown.ts', 'teardownKillOutcomeOf'))(result)
  const report = (await fn<(c: string, p: object, o: unknown) => { printed: string[]; entry?: { classLabel: string; message: string } }>(
    'cli-teardown.ts',
    'personaTeardownReportOf',
  ))(command, persona, outcome)
  if (report.printed.length !== 2 || report.entry === undefined) {
    throw new PrinterFailure('personaTeardownReportOf did not give a failure line, an alert line and an entry for a kill that failed with the ordinary alert', ENTRY_FAIL_EXIT)
  }
  return report
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
  // Scenarios 16 and 15 (test-14; b.jg5 SRJ-1417, SRJ-714, SRJ-715).
  SERVICE_LABEL: { args: [], print: () => text('persona-identity.ts', 'SERVICE_LABEL') },
  PERSONA_LABEL_KEY: { args: [], print: () => text('persona-identity.ts', 'PERSONA_LABEL_KEY') },
  personaTmuxSessionName: {
    args: ['key'],
    print: async ([key]) => (await fn<(k: string) => string>('persona-identity.ts', 'personaTmuxSessionName'))(key),
  },
  PENDING_FILE_SUFFIX: { args: [], print: () => text('reload.ts', 'PENDING_FILE_SUFFIX') },
  APPLY_FILE_SUFFIX: { args: [], print: () => text('reload.ts', 'APPLY_FILE_SUFFIX') },
  PERSONA_TEARDOWN_NOTICE_LABEL: { args: [], print: () => text('kill-failure-alert.ts', 'PERSONA_TEARDOWN_NOTICE_LABEL') },
  RETIRED_KEYS_FILE_NAME: { args: [], print: () => text('retired-keys.ts', 'RETIRED_KEYS_FILE_NAME') },
  retiredKeysPath: {
    args: ['state-dir'],
    print: async ([stateDir]) => (await fn<(dir: string) => string>('retired-keys.ts', 'retiredKeysPath'))(stateDir),
  },
  RETIRED_KEY_CAUSE_REMOVED: { args: [], print: () => text('retired-keys.ts', 'RETIRED_KEY_CAUSE_REMOVED') },
  RETIRED_KEY_CAUSE_ABSENT_AT_START: { args: [], print: () => text('retired-keys.ts', 'RETIRED_KEY_CAUSE_ABSENT_AT_START') },
  'startSweepKillFailedEntry.pre-persona': {
    args: ['instance-id', 'state', 'session', 'description'],
    print: async ([instanceId, state, session, description]) => {
      const outcome = await describeKillOutcome(await killFailedOutcome(description))
      const entry = await fn<(input: object) => string>('session-manager.ts', 'startSweepKillFailedEntry')
      return entry({ instanceId, state, session, outcome, stoppedAtShutdown: false })
    },
  },
  'startSweepKillSucceededLine.head': {
    args: ['instance-id', 'persona'],
    print: async ([instanceId, persona]) => (await startSweepKillSucceededParts(instanceId, persona)).head,
  },
  'startSweepKillSucceededLine.pre-persona-head': {
    args: ['instance-id'],
    print: async ([instanceId]) => (await startSweepKillSucceededParts(instanceId, undefined)).head,
  },
  'startSweepKillSucceededLine.tail': {
    args: ['instance-id'],
    print: async ([instanceId]) => (await startSweepKillSucceededParts(instanceId, undefined)).tail,
  },
  startSweepSummaryLine: {
    args: ['listed', 'killed', 'kept', 'kill-failed', 'recorded-as-retired', 'left-for-latch'],
    print: async ([listed, killed, kept, killFailed, recorded, left]) => {
      const summary = await fn<(result: object) => string>('session-manager.ts', 'startSweepSummaryLine')
      return summary({
        listed: count(listed),
        killed: count(killed),
        kept: count(kept),
        killFailed: count(killFailed),
        recordedAsRetired: count(recorded),
        leftForLatch: count(left),
      })
    },
  },
  'startSweepSummaryLine.head': {
    args: [],
    print: async () => {
      const summary = await fn<(result: object) => string>('session-manager.ts', 'startSweepSummaryLine')
      const line = summary({ listed: COUNT_STAND_IN, killed: 0, kept: 0, killFailed: 0, recordedAsRetired: 0, leftForLatch: 0 })
      return around(line, String(COUNT_STAND_IN), 'startSweepSummaryLine').head
    },
  },
  'startSweepLatchedFromOwnRowLine.launch-start-not-recorded': {
    args: ['name', 'instance-id'],
    print: async ([name, instanceId]) => {
      const ref = (await fn<(n: string) => string>('persona-identity.ts', 'renderPersonaRef'))(name)
      const latchCase = await text('conflict-latch.ts', 'LATCH_CASE_LAUNCH_START_NOT_RECORDED')
      return (await fn<(r: string, id: string, c: string) => string>('session-manager.ts', 'startSweepLatchedFromOwnRowLine'))(ref, instanceId, latchCase)
    },
  },
  launchStartNotRecordedNoticeText: {
    args: ['key'],
    print: async ([key]) => (await fn<(k: string) => string>('conflict-latch.ts', 'launchStartNotRecordedNoticeText'))(key),
  },
  'personaTeardownNoticeEntryText.kill-failure': {
    args: ['name', 'session', 'description'],
    print: async ([name, session, description]) => {
      const key = (await fn<(n: string) => string>('persona-identity.ts', 'personaKey'))(name)
      const instanceId = (await fn<(k: string) => string>('persona-identity.ts', 'personaInstanceId'))(key)
      const context = await value('kill-failure-alert.ts', 'KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN')
      const route = await ordinaryRoute(context, false)
      const alert = await alertText(await ordinaryContent(instanceId, session, description), route.closing, false)
      // The persona notifier's teardown window writes the text with Slack's
      // control-character escapes undone (src/persona-notifier.ts writeTeardownNotice).
      const unescaped = (await fn<(t: string) => string>('slack-text-escape.ts', 'unescapeSlackControlCharacters'))(alert)
      const ref = (await fn<(n: string, k: string) => string>('persona-identity.ts', 'renderPersonaRef'))(name, key)
      const entry = await fn<(personaRef: string, text: string) => string>('persona-notifier.ts', 'personaTeardownNoticeEntryText')
      // The window's persona reference, `persona <ref>` (src/persona-notifier.ts
      // teardownRef; no exported builder).
      return entry(`persona ${ref}`, unescaped)
    },
  },
  // Scenario 6 (test-18; b.jg5 SRJ-1408).
  tmuxUnresponsiveAlertText: {
    args: ['key'],
    print: async ([key]) => (await fn<(k: string, ms: number) => string>('persona-episodes.ts', 'tmuxUnresponsiveAlertText'))(key, await defaultAlertThresholdMs()),
  },
  tmuxUnresponsiveRecoveryText: {
    args: ['key'],
    print: async ([key]) => (await fn<(k: string) => string>('persona-episodes.ts', 'tmuxUnresponsiveRecoveryText'))(key),
  },
  'tmuxUnresponsiveStartedLine.head': {
    args: ['key'],
    print: async ([key]) => {
      const line = (await fn<(k: string, verb: string, d: string) => string>('persona-episodes.ts', 'tmuxUnresponsiveStartedLine'))(key, VERB_STAND_IN, DESCRIPTION_STAND_IN)
      return around(line, VERB_STAND_IN, 'tmuxUnresponsiveStartedLine').head
    },
  },
  'adAlertThresholdMs.default': { args: [], print: async () => String(await defaultAlertThresholdMs()) },
  UNAVAILABLE_RETRY_BASE_S: { args: [], print: () => text('unavailable-retry.ts', 'UNAVAILABLE_RETRY_BASE_S') },
  UNAVAILABLE_RETRY_CEILING_S: { args: [], print: () => text('unavailable-retry.ts', 'UNAVAILABLE_RETRY_CEILING_S') },
  TMUX_UNRESPONSIVE_ONSET_FLOOR_MS: { args: [], print: () => text('persona-episodes.ts', 'TMUX_UNRESPONSIVE_ONSET_FLOOR_MS') },
  restartCapReachedNoticeText: {
    args: [],
    print: async () => (await fn<() => string>('session-manager.ts', 'restartCapReachedNoticeText'))(),
  },
  restartRetryCapSkippedLine: {
    args: ['key'],
    print: async ([key]) => (await fn<(k: string) => string>('restart.ts', 'restartRetryCapSkippedLine'))(key),
  },
  UNAVAILABLE_RETRY_STOP_CAPPED: { args: [], print: () => text('unavailable-retry.ts', 'UNAVAILABLE_RETRY_STOP_CAPPED') },
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS: { args: [], print: () => text('config.ts', 'DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS') },
  KILL_RETRY_SPACING_MS: { args: [], print: () => text('kill-retry.ts', 'KILL_RETRY_SPACING_MS') },
  'killRetryTryLine.head': {
    args: ['instance-id', 'try', 'max'],
    print: async ([instanceId, rawTry, rawMax]) => {
      const n = tryNumber(rawTry)
      const max = tryNumber(rawMax)
      const next = await value('kill-retry.ts', 'KILL_RETRY_NEXT_AGAIN')
      return (await killRetryTryLineParts(instanceId, n, max, next)).head
    },
  },
  'killRetryTryLine.tail': {
    args: ['next'],
    print: async ([nextName]) => {
      if (!/^KILL_RETRY_NEXT_[A-Z_]+$/.test(nextName)) throw new PrinterFailure(`next '${nextName}' is not a KILL_RETRY_NEXT_* export's name`, USAGE_EXIT)
      const next = await value('kill-retry.ts', nextName)
      return (await killRetryTryLineParts(DESCRIPTION_STAND_IN.toLowerCase(), 1, 1, next)).tail
    },
  },
  // Scenario 9 (test-21; b.jg5 SRJ-1411).
  CLI_COMMAND_CLEAN_RESTART: { args: [], print: () => cliCommand('CLI_COMMAND_CLEAN_RESTART') },
  CLI_COMMAND_STOP_BOTS: { args: [], print: () => cliCommand('CLI_COMMAND_STOP_BOTS') },
  adErrorClass: { args: ['class'], print: async ([name]) => adErrorClass(name) },
  adErrorName: {
    args: ['error-class'],
    print: async ([name]) => {
      if (!/^Err[A-Za-z]+$/.test(name)) throw new PrinterFailure(`error class '${name}' is not an Err* name`, USAGE_EXIT)
      const errorClass = await value('agent-director-errors.ts', name)
      if (typeof errorClass !== 'function' || errorClass.name !== name) {
        throw new PrinterFailure(`src/agent-director-errors.ts's ${name} is not an error class named ${name}`, ENTRY_FAIL_EXIT)
      }
      return errorClass.name
    },
  },
  CONFLICT_PANE_NOT_FOUND_PHRASE: { args: [], print: () => text('ad-description-phrases.ts', 'CONFLICT_PANE_NOT_FOUND_PHRASE') },
  'precheckFailureLine.head': {
    args: ['command', 'name', 'class'],
    print: async ([commandName, name, className]) => {
      const line = (await fn<(c: string, p: object, f: object) => string>('cli-teardown.ts', 'precheckFailureLine'))(
        await cliCommand(commandName),
        await cliPersona(name),
        { errorClass: await adErrorClass(className), description: DESCRIPTION_STAND_IN },
      )
      return around(line, DESCRIPTION_STAND_IN, 'precheckFailureLine').head
    },
  },
  precheckNothingStoppedLine: {
    args: ['command'],
    print: async ([commandName]) => (await fn<(c: string) => string>('cli-teardown.ts', 'precheckNothingStoppedLine'))(await cliCommand(commandName)),
  },
  'teardownFailureLine.head': {
    args: ['command', 'name', 'class'],
    print: async ([commandName, name, className]) => {
      const line = (await fn<(c: string, p: object, f: object) => string>('cli-teardown.ts', 'teardownFailureLine'))(
        await cliCommand(commandName),
        await cliPersona(name),
        { errorClass: await adErrorClass(className), description: DESCRIPTION_STAND_IN },
      )
      return around(line, DESCRIPTION_STAND_IN, 'teardownFailureLine').head
    },
  },
  'cliTeardownKillFailed.failure-line': {
    args: ['command', 'name', 'description'],
    print: async ([commandName, name, description]) => (await cliTeardownKillFailedReport(commandName, name, description)).printed[0],
  },
  'cliTeardownKillFailed.alert-line': {
    args: ['command', 'name', 'description'],
    print: async ([commandName, name, description]) => (await cliTeardownKillFailedReport(commandName, name, description)).printed[1],
  },
  'cliTeardownKillFailed.entry-class': {
    args: ['command', 'name', 'description'],
    print: async ([commandName, name, description]) => (await cliTeardownKillFailedReport(commandName, name, description)).entry!.classLabel,
  },
  'cliTeardownKillFailed.entry-message': {
    args: ['command', 'name', 'description'],
    print: async ([commandName, name, description]) => (await cliTeardownKillFailedReport(commandName, name, description)).entry!.message,
  },
  teardownNotStoppedLine: {
    args: ['command', 'count'],
    print: async ([commandName, raw]) => (await fn<(c: string, n: number) => string>('cli-teardown.ts', 'teardownNotStoppedLine'))(await cliCommand(commandName), count(raw)),
  },
  PERSONA_KILL_FAILED_LABEL: { args: [], print: () => text('kill-failure-alert.ts', 'PERSONA_KILL_FAILED_LABEL') },
  CLEAN_RESTART_NOT_RESTARTED_LABEL: { args: [], print: () => text('cli-teardown.ts', 'CLEAN_RESTART_NOT_RESTARTED_LABEL') },
  cleanRestartNotRestartedAlert: {
    args: ['class', 'names'],
    print: async ([className, names]) => {
      const errorClass = await adErrorClass(className)
      const list = names.split(',')
      if (list.some((n) => n === '')) throw new PrinterFailure(`names '${names}' holds an empty name`, USAGE_EXIT)
      const failures = await Promise.all(list.map(async (n) => ({ persona: await cliPersona(n), errorClass })))
      return (await fn<(f: readonly object[]) => string>('cli-teardown.ts', 'cleanRestartNotRestartedAlert'))(failures)
    },
  },
  'answerCheckFailedTryLine.head': {
    args: ['try'],
    print: async ([raw]) => {
      const line = (await fn<(n: number, r: object) => string>('cli-teardown.ts', 'answerCheckFailedTryLine'))(tryNumber(raw), {
        errorClass: CLASS_STAND_IN,
        description: DESCRIPTION_STAND_IN,
      })
      return around(line, CLASS_STAND_IN, 'answerCheckFailedTryLine').head
    },
  },
  'adGraceMs.default': {
    args: [],
    print: async () => {
      const defaults = await value('ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT')
      return String((await fn<(values: unknown) => number>('ad-settings.ts', 'adGraceMs'))(defaults))
    },
  },
  // Scenario 7 (test-19; b.jg5 SRJ-1409).
  preTrustLogLine: {
    args: ['name', 'verb', 'value'],
    print: async ([name, verbName, preTrust]) => {
      if (!/^LAUNCH_VERB_[A-Z_]+$/.test(verbName)) throw new PrinterFailure(`verb '${verbName}' is not a LAUNCH_VERB_* export's name`, USAGE_EXIT)
      const verb = await text('session-manager.ts', verbName)
      const ref = (await fn<(n: string) => string>('persona-identity.ts', 'renderPersonaRef'))(name)
      return (await fn<(r: string, v: string, p: string) => string>('session-manager.ts', 'preTrustLogLine'))(ref, verb, preTrust)
    },
  },
  JSONL_DIAGNOSIS_REUSE_WORDING: { args: [], print: () => text('session-manager.ts', 'JSONL_DIAGNOSIS_REUSE_WORDING') },
  JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS: { args: [], print: () => text('session-manager.ts', 'JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS') },
  JSONL_TRANSCRIPT_LOST_ENTRY_CLASS: { args: [], print: () => text('session-manager.ts', 'JSONL_TRANSCRIPT_LOST_ENTRY_CLASS') },
  // Scenario 12 (test-19; b.jg5 SRJ-1414).
  classifyAdError: {
    args: ['error-class'],
    print: async ([name]) => {
      if (!/^Err[A-Za-z]+$/.test(name)) throw new PrinterFailure(`error class '${name}' is not an Err* name`, USAGE_EXIT)
      const errorClass = (await packageModule('agent-director-errors.ts'))[name]
      if (typeof errorClass !== 'function' || errorClass.name !== name) {
        throw new PrinterFailure(`src/agent-director-errors.ts re-exports no error class named ${name}`, ENTRY_FAIL_EXIT)
      }
      const thrown = new (errorClass as new (verb: string, errName: string, errDescription: string) => Error)('spawn', name, '')
      const classify = await fn<(v: unknown) => { readonly errorClass: string }>('ad-error-class.ts', 'classifyAdError')
      return classify(thrown).errorClass
    },
  },
  // Scenario 18 (test-19; b.jg5 SRJ-1419).
  RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY: { args: [], print: () => text('retired-keys.ts', 'RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY') },
  reloadAppliedLogLine: {
    args: ['added', 'removed', 'destructive', 'in-place', 'credentials', 'settings', 'config-path'],
    print: async ([added, removed, destructive, inPlace, credentials, settings, configPath]) => {
      // Stand-in entries, each with its own key: the counts read only how
      // many each class holds (`inPlace` and `nextLaunch` by distinct key).
      const standIns = (raw: string, what: string) => Array.from({ length: count(raw) }, (_, i) => ({ key: `${what}${i}`, name: `${what}${i}` }))
      const plan = {
        added: standIns(added, 'added'),
        removed: standIns(removed, 'removed'),
        destructive: standIns(destructive, 'destructive'),
        inPlace: standIns(inPlace, 'inplace'),
        nextLaunch: [],
        credentials: standIns(credentials, 'credentials'),
        settings: standIns(settings, 'setting'),
      }
      const paths = (await fn<(p: string) => { readonly lastApplied: string }>('reload.ts', 'reloadFilePaths'))(configPath)
      return (await fn<(p: object, recordPath: string) => string>('reload-apply.ts', 'renderAppliedLogLine'))(plan, paths.lastApplied)
    },
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
