/**
 * fmk-texts.ts — the one value printer of the fmk scenarios (b.jg5 SRJ-1401,
 * SRJ-1306). A scenario script cannot import TypeScript, and a test never
 * retypes a notice text, class label, version or settings value that `src/`
 * exports. So a script asks this printer for the value, and the printer
 * prints the installed package's own export (the tarball under test): a
 * constant as it is, or a builder's output for the script's arguments.
 *
 * Every fmk scenario uses this one printer. A scenario that needs another
 * value adds a named entry to `ENTRIES` here, and never a second printer.
 *
 * REFUSAL
 * -------
 * Runs only in a cscb-ci image. Its first statement checks for the image
 * marker `/etc/cscb-ci-image`; without it, the printer prints
 * `FAIL: fmk-texts: refused: /etc/cscb-ci-image is absent …` on stderr and
 * exits 2, before it reads an argument or loads a module. Only `node:`
 * built-ins are imported statically: the package's modules are imported
 * dynamically, after the check, by the entry that needs them.
 *
 * USAGE
 * -----
 *   bun fmk-texts.ts <entry> [<arg>…]
 *
 * It prints the entry's value on stdout, byte for byte, with nothing added
 * (no trailing newline; a multi-line text is printed as it is), and exits 0.
 * A script runs it directly in its own shell (not through `cscb_run`: the
 * printer is not a CSCB process) and captures the value with a command
 * substitution, failing the scenario when the printer fails:
 *
 *   FLOOR="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" PHASE1_FLOOR_VERSION)" \
 *       || fail "fmk-texts: PHASE1_FLOOR_VERSION"
 *   STOP_MSG="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" \
 *       buildBelowPhase1FloorMessage "${OLD_VERSION}" "${BIN_PATH}" runtime)" \
 *       || fail "fmk-texts: buildBelowPhase1FloorMessage"
 *
 * A command substitution drops trailing newlines. No value below ends with
 * one but CONFLICT_NOTICE_LINE_SEPARATOR, which is one; an entry whose value
 * can must be captured with a sentinel instead:
 * `V="$(bun … && printf x)" || fail …; V="${V%x}"`.
 *
 * Failures print one `FAIL: fmk-texts: <reason>` line on stderr:
 *   - no entry named, an unknown entry, or arguments the entry does not
 *     take: exit 64, with the usage and the entry names;
 *   - the installed package lacks the export, the export is not of the kind
 *     the entry prints, or a builder throws: exit 1.
 *
 * INPUTS (env)
 * ------------
 *   CSCB_PKG_DIR   the installed package (default
 *                  /test-repo/node_modules/claude-slack-channel-bots), as
 *                  `driver.ts` and `fmk-driver.ts` read it
 *
 * ENTRIES (each named after its `src/` export)
 * -------
 *   PHASE1_FLOOR_VERSION                         src/ad-version-gate.ts, the Phase 1 floor
 *   AD_BELOW_PHASE1_FLOOR                        src/install-check-labels.ts, the class label
 *   buildBelowPhase1FloorMessage <found-version> <binary-path> <startup|runtime>
 *                                                src/ad-version-gate.ts, the floor message;
 *                                                `startup` and `runtime` select the package's
 *                                                FOUND_BY_STARTUP_CHECK and
 *                                                FOUND_BY_RUNTIME_RECHECK forms
 *   RUNTIME_RECHECK_PHRASE                       src/ad-version-gate.ts
 *   AD_VERSION_RECHECK_INTERVAL_MS               src/ad-version-gate.ts, in decimal
 *   AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX  src/ad-version-gate.ts
 *   INVALID_FLAGS_HOLD_ALERT_TEXT                src/invalid-flags-hold.ts, SRJ-1008's
 *                                                Cannot launch alert body
 *   formatPersonaNotice <persona-name> <entry> [<arg>…]
 *                                                src/persona-notifier.ts: the posted text of
 *                                                another entry's value as persona
 *                                                <persona-name>'s notice (the persona
 *                                                prefix added, the key derived by the
 *                                                package's personaKey, as the config
 *                                                loader derives it)
 *
 * The latch scenarios' entries (E42–E43, test-15 onward). Constants, each
 * printed as it is, named after their export:
 *   LATCH_CASE_*, REFUSED_OPERATION_*, CONFLICT_NOTICE_*, UNUSABLE_NAME_NOTICE_*,
 *   LAUNCH_START_NOTICE_*, LATCH_RECOVERY_REASON_ROW_READS_HEAD,
 *   CONFLICT_RECOVERY_HEAD, CONFLICT_RECOVERY_REASON_LEAD, HOLD_RECOVERY_HEAD,
 *   LATCH_RECOVERY_TAIL, LATCH_RECHECK_INTERVAL_MS (in decimal), RECHECK_STEP_*,
 *   RECHECK_LINE_STEP_NOT_DECIDED, RECHECK_CALL_*
 *                                                src/conflict-latch.ts (the full list is
 *                                                LATCH_CONSTANT_NAMES below);
 *                                                CONFLICT_NOTICE_LINE_SEPARATOR is a line
 *                                                break, so capture it with the sentinel
 *   UNUSABLE_RECORDED_NAME_PHRASE, CONFLICT_*_PHRASE (the nine case phrases),
 *   PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE, PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE,
 *   NEW_ROW_ENDED_PHRASE, NOTHING_WRITTEN_PHRASE
 *                                                src/ad-description-phrases.ts
 * Builders (<case> is a latch case's value, as the LATCH_CASE_* entries print
 * it; <reason> is LATCH_RECOVERY_REASON_ROW_GONE,
 * LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED,
 * LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED, LATCH_RECOVERY_REASON_CLEARED_BY_HAND,
 * or `latchRecoveryReasonRowReads <state>`):
 *   personaNoticePrefix <persona-name> [<key>]   src/persona-notifier.ts formatPersonaNotice's
 *                                                prefix (its output for an empty body); the
 *                                                key personaKey(<persona-name>) unless given
 *   personaInstanceId <key>                      src/persona-identity.ts
 *   conflictNoticeText <case> <session-name> [<description>]
 *                                                src/conflict-latch.ts, the whole CONFLICT
 *                                                notice body (a CONFLICT case only)
 *   conflictNoticeFirstLine <case> <session-name>
 *                                                its first line (head, the quoted session,
 *                                                the case sentence when the case has one,
 *                                                tail)
 *   conflictNoticeListLine <session-name>        its list line for that name (or the
 *                                                unsafe-name line in its place)
 *   conflictCaseSentence <case>                  the case sentence; fails for a case with none
 *   unusableNameNoticeText <key> <description>   SRJ-1019's notice body
 *   launchStartNotRecordedNoticeText <key>       SRJ-1020's notice body
 *   conflictRecoveryText <session-name> <reason> the CONFLICT recovery notice body
 *   holdRecoveryText <reason>                    the hold recovery notice body
 *   conflictLatchSetLine <key> <case> <session-name> <refused-operation> <row-state> [<previous-case>]
 *                                                the latch-set server-log line (no description;
 *                                                <row-state> a state read, `no-row` or
 *                                                `unreadable`, as the LATCH_ROW_STATE_KIND_*
 *                                                values spell them)
 *   latchClearedLine <key> <case> <session-name> <posted|not-posted> <reason>
 *                                                the clear's server-log line
 *   latchRecheckRoundLine <persona-name> <case> <step> <call> <answer>
 *                                                the re-check round's server-log line, the
 *                                                reference renderPersonaRef(<persona-name>)
 * Scenario 19's entries (test-16):
 *   personaTmuxSessionName <key>                 src/persona-identity.ts, the session name a
 *                                                persona's launches ask for
 *   LATCH_ROW_STATE_KIND_NO_ROW                  src/conflict-latch.ts, the latch-set line's
 *                                                word for no row (conflictLatchSetLine's
 *                                                <row-state>)
 *   adGraceMs, adLaunchBoundMs                   src/ad-settings.ts, G and B in milliseconds at
 *                                                agent-director's default settings
 *                                                (DEFAULT_AD_SETTINGS_IN_EFFECT), in decimal
 * Scenario 25's entries (test-27):
 *   AD_ERROR_CLASS_UNUSABLE_NAME                 src/ad-error-class.ts, CSCB's class for an
 *                                                unusable recorded name, as fmk-driver.ts's
 *                                                outcome line gives it (`class=<class>`)
 * The body entries print a body without the persona prefix; wrap one in
 * `formatPersonaNotice <persona-name> <entry> …` for the posted text.
 *
 * An entry is one `Entry` in `ENTRIES`: its argument synopsis, the export it
 * prints and a `print` function from its arguments to the value. Constants
 * use `constantEntry`; a builder entry checks its own arguments with
 * `expectArguments` and loads its export with `packageFunction`.
 *
 * The printer makes no agent-director call, starts no process or server,
 * opens no socket, reads no token and writes no file.
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

/** Exit status for a missing or mistyped export, or a builder that throws. */
const PRINTER_FAIL_EXIT = 1

/** The installed package under test. */
const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

/** What an entry gets besides its arguments. */
interface EntryContext {
  /** Import a module of the installed package's `src/` (for example `ad-version-gate.ts`). */
  importPackageModule(relPath: string): Promise<Record<string, unknown>>
  /** The value another entry prints for `args` (for an entry that wraps one). */
  entryValue(name: string, args: readonly string[]): Promise<string>
}

/** One named entry of the printer. */
interface Entry {
  /** The arguments it takes, as the usage shows them ('' for none). */
  readonly synopsis: string
  /** The value for `args`, exactly as printed. */
  print(args: readonly string[], context: EntryContext): Promise<string>
}

/** Prints `FAIL: fmk-texts: <reason>` on one line (line breaks become spaces) and exits with `code`. */
function fail(code: number, reason: string): never {
  console.error(`FAIL: ${PRINTER_NAME}: ${reason.replace(/\s*\n\s*/g, ' ')}`)
  process.exit(code)
}

/** A usage failure: the reason, the usage and each entry with its arguments; exit 64. */
function usageFail(detail: string): never {
  const known = Object.keys(ENTRIES)
    .sort()
    .map((name) => (ENTRIES[name].synopsis === '' ? name : `${name} ${ENTRIES[name].synopsis}`))
  fail(USAGE_EXIT, `${detail}; usage: bun fmk-texts.ts <entry> [<arg>…] (entries: ${known.join(', ')})`)
}

/** Fails with a usage failure unless `args` holds exactly `names.length` non-empty arguments. */
function expectArguments(entry: string, args: readonly string[], names: readonly string[]): void {
  const shown = names.length === 0 ? 'no argument' : names.map((n) => `<${n}>`).join(' ')
  if (args.length !== names.length) usageFail(`${entry} takes ${shown} (got ${args.length})`)
  const empty = args.findIndex((a) => a === '')
  if (empty >= 0) usageFail(`${entry}: <${names[empty]}> is empty`)
}

/** Export `name` of the package module `relPath`; a failure when it is undefined. */
async function packageExport(context: EntryContext, relPath: string, name: string): Promise<unknown> {
  const mod = await context.importPackageModule(relPath)
  const value = mod[name]
  if (value === undefined) fail(PRINTER_FAIL_EXIT, `the installed package's src/${relPath} exports no ${name}`)
  return value
}

/** Export `name` of the package module `relPath`, which must be a function. */
async function packageFunction<F>(context: EntryContext, relPath: string, name: string): Promise<F> {
  const value = await packageExport(context, relPath, name)
  if (typeof value !== 'function') fail(PRINTER_FAIL_EXIT, `the installed package's src/${relPath} export ${name} is not a function`)
  return value as F
}

/** Export `name` of the package module `relPath`, which must be a string. */
async function packageString(context: EntryContext, relPath: string, name: string): Promise<string> {
  const value = await packageExport(context, relPath, name)
  if (typeof value !== 'string') fail(PRINTER_FAIL_EXIT, `the installed package's src/${relPath} export ${name} is not a string`)
  return value
}

/** Fails unless a builder's output is a string; answers it. */
function builtString(entry: string, value: unknown): string {
  if (typeof value !== 'string') fail(PRINTER_FAIL_EXIT, `${entry} built a ${typeof value}, not a string`)
  return value
}

/** An entry printing the package constant `name` of `relPath`: a string as it is, a finite number in decimal. No argument. */
function constantEntry(relPath: string, name: string): Entry {
  return {
    synopsis: '',
    async print(args, context) {
      expectArguments(name, args, [])
      const value = await packageExport(context, relPath, name)
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      fail(PRINTER_FAIL_EXIT, `the installed package's src/${relPath} export ${name} is a ${typeof value}, not a string or a finite number`)
    },
  }
}

/** The printer's words for which check found a refused binary, by the package export each selects. */
const FOUND_BY_EXPORTS: Readonly<Record<string, string>> = {
  startup: 'FOUND_BY_STARTUP_CHECK',
  runtime: 'FOUND_BY_RUNTIME_RECHECK',
}

/** `buildBelowPhase1FloorMessage({ foundVersion, binaryPath }, foundBy)`, `foundBy` read from the package. */
const belowPhase1FloorMessage: Entry = {
  synopsis: '<found-version> <binary-path> <startup|runtime>',
  async print(args, context) {
    const entry = 'buildBelowPhase1FloorMessage'
    expectArguments(entry, args, ['found-version', 'binary-path', 'startup|runtime'])
    const [foundVersion, binaryPath, finder] = args
    const foundByExport = Object.hasOwn(FOUND_BY_EXPORTS, finder) ? FOUND_BY_EXPORTS[finder] : undefined
    if (foundByExport === undefined) usageFail(`${entry}: the finder must be startup or runtime (got '${finder}')`)
    const foundBy = await packageString(context, 'ad-version-gate.ts', foundByExport)
    const build = await packageFunction<(parts: object, foundBy: string) => unknown>(context, 'ad-version-gate.ts', entry)
    return builtString(entry, build({ foundVersion, binaryPath }, foundBy))
  },
}

/** `formatPersonaNotice({ name, key: personaKey(name) }, <another entry's value>)`: the text a persona's notice is posted as. */
const personaNotice: Entry = {
  synopsis: '<persona-name> <entry> [<arg>…]',
  async print(args, context) {
    const entry = 'formatPersonaNotice'
    const [name, inner, ...innerArgs] = args
    if (name === undefined || name === '' || inner === undefined || inner === '') {
      usageFail(`${entry} takes <persona-name> <entry> [<arg>…] (got ${args.length} argument${args.length === 1 ? '' : 's'})`)
    }
    const body = await context.entryValue(inner, innerArgs)
    const personaKey = await packageFunction<(name: string) => unknown>(context, 'persona-identity.ts', 'personaKey')
    const format = await packageFunction<(persona: { name: string; key: unknown }, text: string) => unknown>(context, 'persona-notifier.ts', entry)
    return builtString(entry, format({ name, key: personaKey(name) }, body))
  },
}

// ---------------------------------------------------------------------------
// The latch scenarios' entries (E42–E43): the latch notices, the recovery
// texts, agent-director's case phrases, the re-check interval and the latch's
// server-log lines, every one from conflict-latch.ts, ad-description-phrases.ts,
// persona-notifier.ts or persona-identity.ts.
// ---------------------------------------------------------------------------

/** conflict-latch.ts's constants the latch scenarios print as they are. */
const LATCH_CONSTANT_NAMES: readonly string[] = [
  'LATCH_CASE_CONFLICTING_LABELS',
  'LATCH_CASE_PANE_NOT_FOUND',
  'LATCH_CASE_NOT_THIS_LAUNCH',
  'LATCH_CASE_LEFTOVER',
  'LATCH_CASE_NEVER_REPORTED_IN',
  'LATCH_CASE_OWN_ID',
  'LATCH_CASE_NO_VALID_ID',
  'LATCH_CASE_DIFFERENT_ID',
  'LATCH_CASE_ANOTHER_STORE',
  'LATCH_CASE_UNRECOGNISED',
  'LATCH_CASE_UNUSABLE_RECORDED_NAME',
  'LATCH_CASE_LAUNCH_START_NOT_RECORDED',
  'REFUSED_OPERATION_PLAIN_SPAWN',
  'REFUSED_OPERATION_REUSE_SPAWN',
  'REFUSED_OPERATION_RESUME',
  'REFUSED_OPERATION_BRING_UP',
  'REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY',
  'REFUSED_OPERATION_NONE',
  'CONFLICT_NOTICE_FIRST_LINE_HEAD',
  'CONFLICT_NOTICE_CASE_SENTENCE_LEAD',
  'CONFLICT_NOTICE_FIRST_LINE_TAIL',
  'CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD',
  'CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL',
  'CONFLICT_NOTICE_POINTER_LINE',
  'CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE',
  'CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE',
  'CONFLICT_NOTICE_LIST_LINE_HEAD',
  'CONFLICT_NOTICE_LIST_LINE_TAIL',
  'CONFLICT_NOTICE_LIST_LINE_UNSAFE_NAME',
  'CONFLICT_NOTICE_HUMAN_ONLY_LINE',
  'CONFLICT_NOTICE_LINE_SEPARATOR',
  'UNUSABLE_NAME_NOTICE_HEAD',
  'UNUSABLE_NAME_NOTICE_REASON',
  'UNUSABLE_NAME_NOTICE_DESCRIPTION_END',
  'UNUSABLE_NAME_NOTICE_POINTER',
  'UNUSABLE_NAME_NOTICE_HOLD',
  'UNUSABLE_NAME_NOTICE_SEPARATOR',
  'LAUNCH_START_NOTICE_HEAD',
  'LAUNCH_START_NOTICE_SESSION_END',
  'LAUNCH_START_NOTICE_POINTER',
  'LAUNCH_START_NOTICE_HOLD',
  'LAUNCH_START_NOTICE_SEPARATOR',
  'LATCH_RECOVERY_REASON_ROW_READS_HEAD',
  'CONFLICT_RECOVERY_HEAD',
  'CONFLICT_RECOVERY_REASON_LEAD',
  'HOLD_RECOVERY_HEAD',
  'LATCH_RECOVERY_TAIL',
  'LATCH_RECHECK_INTERVAL_MS',
  'RECHECK_STEP_CLEAR_REPORTED_IN',
  'RECHECK_STEP_CLEAR_GONE',
  'RECHECK_STEP_SPAWN_RETRY',
  'RECHECK_STEP_FINISHED_ROW_RETRY',
  'RECHECK_STEP_TABLE',
  'RECHECK_STEP_NO_INFORMATION',
  'RECHECK_LINE_STEP_NOT_DECIDED',
  'RECHECK_CALL_NONE',
  'RECHECK_CALL_PROBE',
  'RECHECK_CALL_PENDING_READ_PANE',
  'RECHECK_CALL_PLAIN_SPAWN',
  'RECHECK_CALL_REUSE_SPAWN',
  'RECHECK_CALL_RESUME',
  'RECHECK_CALL_RESTART_DECISION',
  'RECHECK_CALL_FINISHED_ROW',
]

/** ad-description-phrases.ts's words the latch scenarios match in agent-director's descriptions and fmk-driver.ts's outcome line. */
const CASE_PHRASE_NAMES: readonly string[] = [
  'UNUSABLE_RECORDED_NAME_PHRASE',
  'CONFLICT_CONFLICTING_LABELS_PHRASE',
  'CONFLICT_PANE_NOT_FOUND_PHRASE',
  'CONFLICT_NOT_THIS_LAUNCH_PHRASE',
  'CONFLICT_LEFTOVER_PHRASE',
  'CONFLICT_NEVER_REPORTED_IN_PHRASE',
  'CONFLICT_OWN_ID_PHRASE',
  'CONFLICT_NO_VALID_ID_PHRASE',
  'CONFLICT_DIFFERENT_ID_PHRASE',
  'CONFLICT_ANOTHER_STORE_PHRASE',
  'PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE',
  'PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE',
  'NEW_ROW_ENDED_PHRASE',
  'NOTHING_WRITTEN_PHRASE',
]

/** A `constantEntry` for each of `names`, all of `relPath`. */
function constantEntries(relPath: string, names: readonly string[]): Record<string, Entry> {
  return Object.fromEntries(names.map((name) => [name, constantEntry(relPath, name)]))
}

/** Fails with a usage failure unless `args` holds `min` to `names.length` non-empty arguments. */
function expectSomeArguments(entry: string, args: readonly string[], names: readonly string[], min: number): void {
  const shown = names.map((n, i) => (i < min ? `<${n}>` : `[<${n}>]`)).join(' ')
  if (args.length < min || args.length > names.length) usageFail(`${entry} takes ${shown} (got ${args.length})`)
  const empty = args.findIndex((a) => a === '')
  if (empty >= 0) usageFail(`${entry}: <${names[empty]}> is empty`)
}

/** Export `name` of conflict-latch.ts, which must be an array of strings. */
async function latchStrings(context: EntryContext, name: string): Promise<readonly string[]> {
  const value = await packageExport(context, 'conflict-latch.ts', name)
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(PRINTER_FAIL_EXIT, `the installed package's src/conflict-latch.ts export ${name} is not an array of strings`)
  }
  return value as string[]
}

/** `value` when the package's LATCH_CASES holds it (a CONFLICT case only, with `conflictOnly`); a usage failure otherwise. */
async function latchCaseArgument(context: EntryContext, entry: string, value: string, conflictOnly = false): Promise<string> {
  const cases = await latchStrings(context, 'LATCH_CASES')
  if (!cases.includes(value)) usageFail(`${entry}: '${value}' is not a latch case (${cases.join(', ')})`)
  if (conflictOnly && (await latchStrings(context, 'HOLD_LATCH_CASES')).includes(value)) {
    usageFail(`${entry}: '${value}' is a hold case, which takes no CONFLICT notice`)
  }
  return value
}

/** `value` when the package's REFUSED_OPERATIONS holds it; a usage failure otherwise. */
async function refusedOperationArgument(context: EntryContext, entry: string, value: string): Promise<string> {
  const operations = await latchStrings(context, 'REFUSED_OPERATIONS')
  if (!operations.includes(value)) usageFail(`${entry}: '${value}' is not a refused operation (${operations.join(', ')})`)
  return value
}

/** The recorded row state for a word: the package's no-row or unreadable value for its kind, else `latchRowStateRead(word)`. */
async function rowStateArgument(context: EntryContext, word: string): Promise<unknown> {
  if (word === (await packageString(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_KIND_NO_ROW'))) {
    return await packageExport(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_NO_ROW')
  }
  if (word === (await packageString(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_KIND_UNREADABLE'))) {
    return await packageExport(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_UNREADABLE')
  }
  const read = await packageFunction<(state: string) => unknown>(context, 'conflict-latch.ts', 'latchRowStateRead')
  return read(word)
}

/** The SRJ-1005 reasons with no state, by the export that holds each. */
const RECOVERY_REASON_EXPORTS: readonly string[] = [
  'LATCH_RECOVERY_REASON_ROW_GONE',
  'LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED',
  'LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED',
  'LATCH_RECOVERY_REASON_CLEARED_BY_HAND',
]

/** The state-bearing reason's builder, by its export name. */
const ROW_READS_REASON = 'latchRecoveryReasonRowReads'

/** The reason the words `<reason> [<state>]` name: one of RECOVERY_REASON_EXPORTS (no state), or ROW_READS_REASON with its state. */
async function recoveryReasonArgument(context: EntryContext, entry: string, words: readonly string[]): Promise<unknown> {
  const [name, ...rest] = words
  if (name === ROW_READS_REASON && rest.length === 1 && rest[0] !== '') {
    return (await packageFunction<(state: string) => unknown>(context, 'conflict-latch.ts', ROW_READS_REASON))(rest[0])
  }
  if (name !== undefined && RECOVERY_REASON_EXPORTS.includes(name) && rest.length === 0) {
    return await packageExport(context, 'conflict-latch.ts', name)
  }
  usageFail(`${entry}: the reason must be one of ${RECOVERY_REASON_EXPORTS.join(', ')}, or ${ROW_READS_REASON} <state> (got '${words.join(' ')}')`)
}

/** `conflictNoticeText({ sessionName, latchCase, description })`: the CONFLICT notice body as src builds it. */
async function conflictNoticeBody(context: EntryContext, entry: string, latchCase: string, sessionName: string, description?: string): Promise<string> {
  const build = await packageFunction<(source: object) => unknown>(context, 'conflict-latch.ts', 'conflictNoticeText')
  const source = description === undefined ? { sessionName, latchCase } : { sessionName, latchCase, description }
  return builtString(entry, build(source))
}

/** The CONFLICT notice body's lines, split on the package's CONFLICT_NOTICE_LINE_SEPARATOR. */
async function conflictNoticeLines(context: EntryContext, entry: string, latchCase: string, sessionName: string): Promise<string[]> {
  const separator = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_LINE_SEPARATOR')
  return (await conflictNoticeBody(context, entry, latchCase, sessionName)).split(separator)
}

/** The persona prefix `formatPersonaNotice` adds: `formatPersonaNotice({ name, key }, '')`, the key `personaKey(name)` unless given. */
const personaNoticePrefix: Entry = {
  synopsis: '<persona-name> [<key>]',
  async print(args, context) {
    const entry = 'personaNoticePrefix'
    expectSomeArguments(entry, args, ['persona-name', 'key'], 1)
    const [name, given] = args
    const derive = await packageFunction<(name: string) => unknown>(context, 'persona-identity.ts', 'personaKey')
    const key = given ?? builtString(entry, derive(name))
    const format = await packageFunction<(persona: { name: string; key: string }, text: string) => unknown>(context, 'persona-notifier.ts', 'formatPersonaNotice')
    return builtString(entry, format({ name, key }, ''))
  },
}

/** `personaInstanceId(key)`: a persona's agent-director instance id. */
const personaInstanceId: Entry = {
  synopsis: '<key>',
  async print(args, context) {
    const entry = 'personaInstanceId'
    expectArguments(entry, args, ['key'])
    return builtString(entry, (await packageFunction<(key: string) => unknown>(context, 'persona-identity.ts', entry))(args[0]))
  },
}

/** The whole CONFLICT notice body for a CONFLICT case, a quoted session and, when given, agent-director's description. */
const conflictNoticeText: Entry = {
  synopsis: '<case> <session-name> [<description>]',
  async print(args, context) {
    const entry = 'conflictNoticeText'
    expectSomeArguments(entry, args, ['case', 'session-name', 'description'], 2)
    const latchCase = await latchCaseArgument(context, entry, args[0], true)
    return await conflictNoticeBody(context, entry, latchCase, args[1], args[2])
  },
}

/** The CONFLICT notice's first line (head, `"<session>"`, the case sentence when the case has one, tail), from `conflictNoticeText`. */
const conflictNoticeFirstLine: Entry = {
  synopsis: '<case> <session-name>',
  async print(args, context) {
    const entry = 'conflictNoticeFirstLine'
    expectArguments(entry, args, ['case', 'session-name'])
    const latchCase = await latchCaseArgument(context, entry, args[0], true)
    return (await conflictNoticeLines(context, entry, latchCase, args[1]))[0]
  },
}

/** The CONFLICT notice's list line for a session name (or the unsafe-name line in its place), from `conflictNoticeText`. */
const conflictNoticeListLine: Entry = {
  synopsis: '<session-name>',
  async print(args, context) {
    const entry = 'conflictNoticeListLine'
    expectArguments(entry, args, ['session-name'])
    const leftover = await packageString(context, 'conflict-latch.ts', 'LATCH_CASE_LEFTOVER')
    const lines = await conflictNoticeLines(context, entry, leftover, args[0])
    const line = lines[lines.length - 2]
    const head = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_LIST_LINE_HEAD')
    const unsafe = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_LIST_LINE_UNSAFE_NAME')
    if (line === undefined || !(line.startsWith(head) || line === unsafe)) {
      fail(PRINTER_FAIL_EXIT, `${entry}: the notice's line before the human-only line is not its list line`)
    }
    return line
  },
}

/** `conflictCaseSentence(case)`: SRJ-1004's case sentence; a failure for a case that has none. */
const conflictCaseSentence: Entry = {
  synopsis: '<case>',
  async print(args, context) {
    const entry = 'conflictCaseSentence'
    expectArguments(entry, args, ['case'])
    const latchCase = await latchCaseArgument(context, entry, args[0])
    const sentence = (await packageFunction<(latchCase: string) => unknown>(context, 'conflict-latch.ts', entry))(latchCase)
    if (sentence === undefined) fail(PRINTER_FAIL_EXIT, `${entry}: case '${latchCase}' has no case sentence`)
    return builtString(entry, sentence)
  },
}

/** `unusableNameNoticeText(key, description)`: SRJ-1019's notice body. */
const unusableNameNoticeText: Entry = {
  synopsis: '<key> <description>',
  async print(args, context) {
    const entry = 'unusableNameNoticeText'
    expectArguments(entry, args, ['key', 'description'])
    return builtString(entry, (await packageFunction<(key: string, d: string) => unknown>(context, 'conflict-latch.ts', entry))(args[0], args[1]))
  },
}

/** `launchStartNotRecordedNoticeText(key)`: SRJ-1020's notice body. */
const launchStartNotRecordedNoticeText: Entry = {
  synopsis: '<key>',
  async print(args, context) {
    const entry = 'launchStartNotRecordedNoticeText'
    expectArguments(entry, args, ['key'])
    return builtString(entry, (await packageFunction<(key: string) => unknown>(context, 'conflict-latch.ts', entry))(args[0]))
  },
}

/** `conflictRecoveryText(session, reason)`: the CONFLICT recovery notice body. */
const conflictRecoveryText: Entry = {
  synopsis: `<session-name> <${RECOVERY_REASON_EXPORTS.join('|')}|${ROW_READS_REASON} <state>>`,
  async print(args, context) {
    const entry = 'conflictRecoveryText'
    const [sessionName, ...reasonWords] = args
    if (sessionName === undefined || sessionName === '') usageFail(`${entry} takes <session-name> <reason> [<state>]`)
    const reason = await recoveryReasonArgument(context, entry, reasonWords)
    return builtString(entry, (await packageFunction<(s: string, r: unknown) => unknown>(context, 'conflict-latch.ts', entry))(sessionName, reason))
  },
}

/** `holdRecoveryText(reason)`: the hold recovery notice body. */
const holdRecoveryText: Entry = {
  synopsis: `<${RECOVERY_REASON_EXPORTS.join('|')}|${ROW_READS_REASON} <state>>`,
  async print(args, context) {
    const entry = 'holdRecoveryText'
    const reason = await recoveryReasonArgument(context, entry, args)
    return builtString(entry, (await packageFunction<(r: unknown) => unknown>(context, 'conflict-latch.ts', entry))(reason))
  },
}

/** `conflictLatchSetLine(key, record, previousCase)`: the latch-set server-log line, the record built from the arguments (no description). */
const conflictLatchSetLine: Entry = {
  synopsis: '<key> <case> <session-name> <refused-operation> <row-state> [<previous-case>]',
  async print(args, context) {
    const entry = 'conflictLatchSetLine'
    expectSomeArguments(entry, args, ['key', 'case', 'session-name', 'refused-operation', 'row-state', 'previous-case'], 5)
    const [key, caseWord, sessionName, operation, state, previous] = args
    const record = {
      sessionName,
      latchCase: await latchCaseArgument(context, entry, caseWord),
      refusedOperation: await refusedOperationArgument(context, entry, operation),
      rowState: await rowStateArgument(context, state),
    }
    const previousCase = previous === undefined ? undefined : await latchCaseArgument(context, entry, previous)
    const build = await packageFunction<(key: string, record: object, previous?: string) => unknown>(context, 'conflict-latch.ts', entry)
    return builtString(entry, build(key, record, previousCase))
  },
}

/** The printer's words for whether the recovery notice was posted. */
const POSTED_WORDS: Readonly<Record<string, boolean>> = { posted: true, 'not-posted': false }

/** `latchClearedLine(key, record, reason, posted)`: the clear's server-log line (the builder reads the record's case and session only). */
const latchClearedLine: Entry = {
  synopsis: `<key> <case> <session-name> <posted|not-posted> <${RECOVERY_REASON_EXPORTS.join('|')}|${ROW_READS_REASON} <state>>`,
  async print(args, context) {
    const entry = 'latchClearedLine'
    const [key, caseWord, sessionName, postedWord, ...reasonWords] = args
    if ([key, caseWord, sessionName, postedWord].some((a) => a === undefined || a === '')) {
      usageFail(`${entry} takes <key> <case> <session-name> <posted|not-posted> <reason> [<state>]`)
    }
    const posted = Object.hasOwn(POSTED_WORDS, postedWord) ? POSTED_WORDS[postedWord] : undefined
    if (posted === undefined) usageFail(`${entry}: <posted|not-posted> is '${postedWord}'`)
    const record = {
      sessionName,
      latchCase: await latchCaseArgument(context, entry, caseWord),
      refusedOperation: await packageString(context, 'conflict-latch.ts', 'REFUSED_OPERATION_NONE'),
      rowState: await packageExport(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_UNREADABLE'),
    }
    const reason = await recoveryReasonArgument(context, entry, reasonWords)
    const build = await packageFunction<(key: string, record: object, reason: unknown, posted: boolean) => unknown>(context, 'conflict-latch.ts', entry)
    return builtString(entry, build(key, record, reason, posted))
  },
}

/** `latchRecheckRoundLine(ref, case, step, call, answer)`: the re-check round's server-log line, `ref` the persona reference `renderPersonaRef` gives the name. */
const latchRecheckRoundLine: Entry = {
  synopsis: '<persona-name> <case> <step> <call> <answer>',
  async print(args, context) {
    const entry = 'latchRecheckRoundLine'
    expectArguments(entry, args, ['persona-name', 'case', 'step', 'call', 'answer'])
    const [name, caseWord, step, call, answer] = args
    const latchCase = await latchCaseArgument(context, entry, caseWord)
    const ref = (await packageFunction<(name: string) => unknown>(context, 'persona-identity.ts', 'renderPersonaRef'))(name)
    const build = await packageFunction<(ref: unknown, c: string, s: string, call: string, a: string) => unknown>(context, 'conflict-latch.ts', entry)
    return builtString(entry, build(builtString(entry, ref), latchCase, step, call, answer))
  },
}

/** `personaTmuxSessionName(key)`: the tmux session name a persona's launches ask for. */
const personaTmuxSessionName: Entry = {
  synopsis: '<key>',
  async print(args, context) {
    const entry = 'personaTmuxSessionName'
    expectArguments(entry, args, ['key'])
    return builtString(entry, (await packageFunction<(key: string) => unknown>(context, 'persona-identity.ts', entry))(args[0]))
  },
}

/** An entry printing ad-settings.ts's `name(DEFAULT_AD_SETTINGS_IN_EFFECT)` in decimal: a wait at agent-director's default settings, in milliseconds. No argument. */
function adSettingsDefaultMs(name: string): Entry {
  return {
    synopsis: '',
    async print(args, context) {
      expectArguments(name, args, [])
      const defaults = await packageExport(context, 'ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT')
      const value = (await packageFunction<(values: unknown) => unknown>(context, 'ad-settings.ts', name))(defaults)
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(PRINTER_FAIL_EXIT, `${name} gave ${String(value)}, not a finite number`)
      return String(value)
    },
  }
}

/** The printer's entries, by the name a script passes. Later scenarios add entries here. */
const ENTRIES: Readonly<Record<string, Entry>> = {
  // Scenario 8 (test-20-fmk-old-binary.sh).
  PHASE1_FLOOR_VERSION: constantEntry('ad-version-gate.ts', 'PHASE1_FLOOR_VERSION'),
  AD_BELOW_PHASE1_FLOOR: constantEntry('install-check-labels.ts', 'AD_BELOW_PHASE1_FLOOR'),
  buildBelowPhase1FloorMessage: belowPhase1FloorMessage,
  RUNTIME_RECHECK_PHRASE: constantEntry('ad-version-gate.ts', 'RUNTIME_RECHECK_PHRASE'),
  AD_VERSION_RECHECK_INTERVAL_MS: constantEntry('ad-version-gate.ts', 'AD_VERSION_RECHECK_INTERVAL_MS'),
  AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX: constantEntry('ad-version-gate.ts', 'AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX'),
  INVALID_FLAGS_HOLD_ALERT_TEXT: constantEntry('invalid-flags-hold.ts', 'INVALID_FLAGS_HOLD_ALERT_TEXT'),
  formatPersonaNotice: personaNotice,
  // The latch scenarios, E42–E43 (test-15 onward).
  ...constantEntries('conflict-latch.ts', LATCH_CONSTANT_NAMES),
  ...constantEntries('ad-description-phrases.ts', CASE_PHRASE_NAMES),
  personaNoticePrefix,
  personaInstanceId,
  conflictNoticeText,
  conflictNoticeFirstLine,
  conflictNoticeListLine,
  conflictCaseSentence,
  unusableNameNoticeText,
  launchStartNotRecordedNoticeText,
  conflictRecoveryText,
  holdRecoveryText,
  conflictLatchSetLine,
  latchClearedLine,
  latchRecheckRoundLine,
  // Scenario 19 (test-16-fmk-conflict.sh).
  personaTmuxSessionName,
  LATCH_ROW_STATE_KIND_NO_ROW: constantEntry('conflict-latch.ts', 'LATCH_ROW_STATE_KIND_NO_ROW'),
  adGraceMs: adSettingsDefaultMs('adGraceMs'),
  adLaunchBoundMs: adSettingsDefaultMs('adLaunchBoundMs'),
  // Scenario 25 (test-27-fmk-unusable-name.sh).
  AD_ERROR_CLASS_UNUSABLE_NAME: constantEntry('ad-error-class.ts', 'AD_ERROR_CLASS_UNUSABLE_NAME'),
}

/** The value entry `name` prints for `args`; a usage failure for no entry or an unknown one. */
async function entryValue(name: string | undefined, args: readonly string[]): Promise<string> {
  if (name === undefined || name === '') usageFail('no entry was named')
  const entry = Object.hasOwn(ENTRIES, name) ? ENTRIES[name] : undefined
  if (entry === undefined) usageFail(`unknown entry '${name}'`)
  return await entry.print(args, context)
}

const context: EntryContext = {
  async importPackageModule(relPath) {
    return await import(join(PKG_DIR, 'src', relPath))
  },
  entryValue,
}

async function main(argv: readonly string[]): Promise<void> {
  const [name, ...args] = argv
  let value: string
  try {
    value = await entryValue(name, args)
  } catch (err) {
    fail(PRINTER_FAIL_EXIT, `${name} threw: ${err instanceof Error ? err.message : String(err)}`)
  }
  await Bun.write(Bun.stdout, value)
  process.exit(0)
}

await main(process.argv.slice(2))
