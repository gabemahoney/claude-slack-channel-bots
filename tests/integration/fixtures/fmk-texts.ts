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
 * one; an entry whose value can must be captured with a sentinel instead:
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
 *   Scenario 10 (test-22-fmk-wrong-server.sh):
 *   personaInstanceId <key>                      src/persona-identity.ts, `cscb_<key>`
 *   personaTmuxSessionName <key>                 src/persona-identity.ts, `slack_bot_<key>`
 *   CONFLICT_NOTICE_FIRST_LINE_HEAD              src/conflict-latch.ts, the CONFLICT notice's parts
 *   CONFLICT_NOTICE_POINTER_LINE                 (SRJ-1004) CSCB writes around agent-director's
 *   CONFLICT_NOTICE_HUMAN_ONLY_LINE              description
 *   conflictCaseSentence <latch-case>            src/conflict-latch.ts, a case's sentence (a case
 *                                                with none is a failure)
 *   LATCH_CASE_OWN_ID                            src/conflict-latch.ts, the "this row's own id" case
 *   conflictRecoveryText <session-name> <reason-export>
 *                                                src/conflict-latch.ts, the CONFLICT recovery
 *                                                notice's body; <reason-export> names one of the
 *                                                package's LATCH_RECOVERY_REASON_* values without
 *                                                a state (LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED,
 *                                                for one)
 *   LATCH_RECHECK_INTERVAL_MS                    src/conflict-latch.ts, in decimal
 *   RECHECK_CALL_PROBE RECHECK_CALL_RESUME       src/conflict-latch.ts, the call and verdict
 *   RECHECK_VERDICT_STILL_LATCHED                labels a re-check's round line carries
 *   PROBE_PANE_READ_LINES                        src/pane-read.ts, in decimal
 *   PANE_READ_PANE PANE_READ_GONE                src/pane-read.ts, a pane read's outcome kinds
 *   CONFLICT_OWN_ID_PHRASE STILL_STOPPING_PHRASE STILL_STARTING_PHRASE
 *                                                src/ad-description-phrases.ts
 *   AD_SETTINGS_RELATIVE_PATH AD_TMUX_TABLE      src/ad-settings.ts (the path re-exported from
 *                                                src/ad-config-file.ts)
 *   AD_SETTING_MINIMUMS                          src/ad-settings.ts: one `<key>=<minimum>` line
 *                                                per key whose minimum is a whole number, in the
 *                                                export's order, each key one of AD_TMUX_KEYS
 *   MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS          src/config.ts, in decimal: the longest permission
 *                                                poll interval a config may set
 *   sessionEndingCommandsIn                      reads a post's text on standard input and prints
 *                                                the names of the session-ending command forms
 *                                                (tests/test-helpers/session-ending-commands.ts,
 *                                                SRJ-1001) its CSCB-authored lines match, one per
 *                                                line, nothing when none: every line but the one
 *                                                that opens with the package's
 *                                                CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD (lines split
 *                                                at CONFLICT_NOTICE_LINE_SEPARATOR)
 *
 * An entry is one `Entry` in `ENTRIES`: its argument synopsis, the export it
 * prints and a `print` function from its arguments to the value. Constants
 * use `constantEntry`; a builder entry checks its own arguments with
 * `expectArguments` and loads its export with `packageFunction`
 * (`builderEntry` for a builder of string arguments only).
 *
 * The printer makes no agent-director call, starts no process or server,
 * opens no socket, reads no token and writes no file; only
 * `sessionEndingCommandsIn` reads its standard input. Its one module outside
 * the installed package is the import-free
 * tests/test-helpers/session-ending-commands.ts, loaded from this file's own
 * tree (/tests in the image).
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

/** An entry printing the output of the package builder `name` of `relPath` for its string arguments `argNames`. */
function builderEntry(relPath: string, name: string, argNames: readonly string[]): Entry {
  return {
    synopsis: argNames.map((n) => `<${n}>`).join(' '),
    async print(args, context) {
      expectArguments(name, args, argNames)
      const build = await packageFunction<(...parts: string[]) => unknown>(context, relPath, name)
      return builtString(name, build(...args))
    },
  }
}

/** `conflictRecoveryText(<session-name>, <the package's LATCH_RECOVERY_REASON_* value named>)`. */
const recoveryText: Entry = {
  synopsis: '<session-name> <reason-export>',
  async print(args, context) {
    const entry = 'conflictRecoveryText'
    expectArguments(entry, args, ['session-name', 'reason-export'])
    const [sessionName, reasonExport] = args
    if (!reasonExport.startsWith('LATCH_RECOVERY_REASON_')) {
      usageFail(`${entry}: <reason-export> must name a LATCH_RECOVERY_REASON_* value (got '${reasonExport}')`)
    }
    const reason = await packageExport(context, 'conflict-latch.ts', reasonExport)
    if (typeof reason !== 'object' || reason === null || typeof (reason as { kind?: unknown }).kind !== 'string') {
      fail(PRINTER_FAIL_EXIT, `the installed package's src/conflict-latch.ts export ${reasonExport} is not a recovery reason`)
    }
    const build = await packageFunction<(sessionName: string, reason: unknown) => unknown>(context, 'conflict-latch.ts', entry)
    return builtString(entry, build(sessionName, reason))
  },
}

/** Each `[tmux]` key whose minimum is a whole number, as `<key>=<minimum>` lines (AD_TMUX_KEYS checked). */
const settingMinimums: Entry = {
  synopsis: '',
  async print(args, context) {
    const entry = 'AD_SETTING_MINIMUMS'
    expectArguments(entry, args, [])
    const minimums = await packageExport(context, 'ad-settings.ts', entry)
    const keys = await packageExport(context, 'ad-settings.ts', 'AD_TMUX_KEYS')
    if (typeof minimums !== 'object' || minimums === null || !Array.isArray(keys)) {
      fail(PRINTER_FAIL_EXIT, `the installed package's src/ad-settings.ts ${entry} or AD_TMUX_KEYS is not of the kind this entry prints`)
    }
    const lines: string[] = []
    for (const [key, value] of Object.entries(minimums)) {
      if (typeof value !== 'bigint' && typeof value !== 'number') continue
      if (!keys.includes(key)) fail(PRINTER_FAIL_EXIT, `${entry} names ${key}, which is not one of AD_TMUX_KEYS`)
      lines.push(`${key}=${String(value)}`)
    }
    if (lines.length === 0) fail(PRINTER_FAIL_EXIT, `${entry} holds no whole-number minimum`)
    return lines.join('\n')
  },
}

/** The import-free session-ending forms helper, in this file's own tree (`/tests` in the image). */
const SESSION_ENDING_COMMANDS_PATH = join(import.meta.dir, '..', '..', 'test-helpers', 'session-ending-commands.ts')

/** The session-ending command forms a post's CSCB-authored lines match (the post read on standard input). */
const sessionEndingForms: Entry = {
  synopsis: '',
  async print(args, context) {
    const entry = 'sessionEndingCommandsIn'
    expectArguments(entry, args, [])
    const head = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD')
    const separator = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_LINE_SEPARATOR')
    const helper = (await import(SESSION_ENDING_COMMANDS_PATH)) as Record<string, unknown>
    const find = helper[entry]
    if (typeof find !== 'function') fail(PRINTER_FAIL_EXIT, `${SESSION_ENDING_COMMANDS_PATH} exports no function ${entry}`)
    const text = await Bun.stdin.text()
    const own = text.split(separator).filter((line) => !line.startsWith(head))
    const found = own.flatMap((line) => (find as (text: string) => string[])(line))
    return [...new Set(found)].join('\n')
  },
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
  // Scenario 10 (test-22-fmk-wrong-server.sh).
  personaInstanceId: builderEntry('persona-identity.ts', 'personaInstanceId', ['key']),
  personaTmuxSessionName: builderEntry('persona-identity.ts', 'personaTmuxSessionName', ['key']),
  CONFLICT_NOTICE_FIRST_LINE_HEAD: constantEntry('conflict-latch.ts', 'CONFLICT_NOTICE_FIRST_LINE_HEAD'),
  CONFLICT_NOTICE_POINTER_LINE: constantEntry('conflict-latch.ts', 'CONFLICT_NOTICE_POINTER_LINE'),
  CONFLICT_NOTICE_HUMAN_ONLY_LINE: constantEntry('conflict-latch.ts', 'CONFLICT_NOTICE_HUMAN_ONLY_LINE'),
  conflictCaseSentence: builderEntry('conflict-latch.ts', 'conflictCaseSentence', ['latch-case']),
  LATCH_CASE_OWN_ID: constantEntry('conflict-latch.ts', 'LATCH_CASE_OWN_ID'),
  conflictRecoveryText: recoveryText,
  LATCH_RECHECK_INTERVAL_MS: constantEntry('conflict-latch.ts', 'LATCH_RECHECK_INTERVAL_MS'),
  RECHECK_CALL_PROBE: constantEntry('conflict-latch.ts', 'RECHECK_CALL_PROBE'),
  RECHECK_CALL_RESUME: constantEntry('conflict-latch.ts', 'RECHECK_CALL_RESUME'),
  RECHECK_VERDICT_STILL_LATCHED: constantEntry('conflict-latch.ts', 'RECHECK_VERDICT_STILL_LATCHED'),
  PROBE_PANE_READ_LINES: constantEntry('pane-read.ts', 'PROBE_PANE_READ_LINES'),
  PANE_READ_PANE: constantEntry('pane-read.ts', 'PANE_READ_PANE'),
  PANE_READ_GONE: constantEntry('pane-read.ts', 'PANE_READ_GONE'),
  CONFLICT_OWN_ID_PHRASE: constantEntry('ad-description-phrases.ts', 'CONFLICT_OWN_ID_PHRASE'),
  STILL_STOPPING_PHRASE: constantEntry('ad-description-phrases.ts', 'STILL_STOPPING_PHRASE'),
  STILL_STARTING_PHRASE: constantEntry('ad-description-phrases.ts', 'STILL_STARTING_PHRASE'),
  AD_SETTINGS_RELATIVE_PATH: constantEntry('ad-settings.ts', 'AD_SETTINGS_RELATIVE_PATH'),
  AD_TMUX_TABLE: constantEntry('ad-settings.ts', 'AD_TMUX_TABLE'),
  AD_SETTING_MINIMUMS: settingMinimums,
  MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS: constantEntry('config.ts', 'MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS'),
  sessionEndingCommandsIn: sessionEndingForms,
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
