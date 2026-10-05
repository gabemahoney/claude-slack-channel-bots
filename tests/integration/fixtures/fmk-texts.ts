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
 *                  `driver.ts` and `fmk-driver.ts` read it; the agent-director
 *                  client is the one that package resolves, as `fmk-driver.ts`
 *                  resolves it
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
 *   classifyAdError <err-name>                   src/ad-error-class.ts: CSCB's class
 *                                                (`errorClass`) for an instance of the
 *                                                installed agent-director client's error
 *                                                class <err-name>, built as the client
 *                                                builds one from an error envelope (verb,
 *                                                name, description); for the classes the
 *                                                client builds from an envelope only
 *   DEFAULT_AD_SETTINGS <table> <key>            src/ad-settings.ts: agent-director's default
 *                                                for `[<table>] <key>` (for example `tmux
 *                                                starting_session_seconds`), in decimal
 *   CLIENT_DEV_SENTINEL_VERSION                  src/ad-version-gate.ts, the client's
 *                                                development sentinel version
 *   AD_SYSTEM_INSTALL_UNREACHABLE                src/install-check-labels.ts, the class label
 *   UNREACHABLE_REASON_UNPARSEABLE_VERSION       src/ad-version-gate.ts, the
 *                                                ErrSystemInstallUnreachable reason of a
 *                                                version that does not parse
 *   meetsPhase1Floor <version>                   src/ad-version-gate.ts: whether <version>
 *                                                meets CSCB's Phase 1 floor, `true` or `false`
 *   AD_SETTINGS_LOG_PREFIX                       src/ad-settings.ts, the prefix of the
 *                                                settings reader's log lines
 *   buildAdSettingsValuesLine <path> [<key>=<integer>…]
 *                                                src/ad-settings.ts: the values line for the
 *                                                settings file <path>, the nine [tmux] values
 *                                                DEFAULT_AD_SETTINGS' own but for each given
 *                                                <key>
 *   AD_SETTINGS_RELATIVE_PATH                    src/ad-settings.ts, the settings file's path
 *                                                relative to a HOME
 *   AD_TMUX_TABLE                                src/ad-settings.ts, the timing keys' table
 *   AD_PAUSE_TABLE                               src/ad-settings.ts, `pause`'s table
 *   AD_PAUSE_TIMEOUT_KEY                         src/ad-settings.ts, `pause`'s wait key
 *   AD_TMUX_KEYS                                 src/ad-settings.ts: the nine [tmux] keys, in
 *                                                order, joined by single spaces
 *   AD_SETTING_MINIMUMS <key> [<part>]           src/ad-settings.ts: agent-director's minimum
 *                                                for [tmux] <key>, in decimal; for a minimum
 *                                                with parts (pending_grace_seconds), the
 *                                                named <part> (`floor` or `addend`)
 *   pendingGraceMinimumSeconds <create-timeout-ms> <pipe-close-wait-ms>
 *                                                src/ad-settings.ts: the grace period's
 *                                                minimum, in decimal
 *   adGraceMs [<key>=<integer>…]                 src/ad-settings.ts: G, in decimal
 *   adAlertThresholdMs [<key>=<integer>…]        src/ad-settings.ts: the alert threshold, in
 *                                                decimal
 *   adLaunchBoundMs [<key>=<integer>…]           src/ad-settings.ts: B, in decimal. These
 *                                                three take an AdSettingsInEffect built from
 *                                                the arguments: the [tmux] values
 *                                                DEFAULT_AD_SETTINGS' own but for each given
 *                                                <key>, and DEFAULT_AD_SETTINGS_IN_EFFECT's
 *                                                pauseTimeout
 *   wholeMinutes <ms>                            src/ad-settings.ts: <ms> in whole minutes,
 *                                                rounded down, in decimal
 *   STILL_STOPPING_PHRASE                        src/ad-description-phrases.ts
 *   STILL_STARTING_PHRASE                        src/ad-description-phrases.ts
 *   stuckLaunchRelaunchingText <persona-key> <launch-bound-ms>
 *                                                src/pending-row.ts: the stuck-launch post's
 *                                                relaunching text for the persona with key
 *                                                <persona-key> and B <launch-bound-ms>
 *                                                (posted as a persona notice: wrap it in
 *                                                formatPersonaNotice)
 *   DIALOG_POLL_INTERVAL_MS                      src/session-manager.ts, the dialog approver's
 *                                                pace before G, in decimal
 *   DIALOG_SLOW_POLL_INTERVAL_MS                 src/session-manager.ts, the dialog approver's
 *                                                slow pace from G, in decimal
 *   STARTUP_ERROR_SPAWN_FAILED                   src/session-manager.ts, the startup-errors
 *                                                label of a launch failure
 *   LIVE_ROW_SEQUENCE_LOG_PREFIX                 src/live-row-sequence.ts, the prefix of the
 *                                                live-row sequence's lines
 *   liveRowSequenceWaitArmedLine <persona-ref> <launch-start-ms> <grace-ms>
 *                                                src/live-row-sequence.ts: the step-2 wait's
 *                                                armed line for the persona <persona-ref> (as
 *                                                the server renders it, `"<name>" (key=<key>)`),
 *                                                a launch start in epoch milliseconds and G
 *   liveRowSequenceWaitEndedLine <persona-ref>   src/live-row-sequence.ts: the step-2 wait's
 *                                                end line
 *   liveRowSequenceRunLine <persona-ref> <step> <run-number> <placement-export>
 *                                                src/live-row-sequence.ts: the live-row
 *                                                sequence's line for one `find-missing` run
 *                                                of the persona <persona-ref> (as the server
 *                                                renders it, `"<name>" (key=<key>)`) at step
 *                                                <step> (3 or 4), run <run-number>, with the
 *                                                placement the package exports as
 *                                                <placement-export> (a `LIVE_ROW_RUN_…`
 *                                                name, for example LIVE_ROW_RUN_NOT_JUDGED)
 *
 * In every `<key>=<integer>` argument <key> is one of the package's
 * AD_TMUX_KEYS and <integer> an integer in decimal; an unknown key, a key
 * given twice or a value that is not an integer is a usage failure (exit 64).
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
  /** Import the agent-director client the installed package resolves. */
  importAgentDirectorClient(): Promise<Record<string, unknown>>
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

/** An error class's constructor as the client builds an error from an envelope. */
type EnvelopeErrorClass = new (verb: string, errName: string, errDescription: string) => unknown

/**
 * `classifyAdError(<an instance of the client's class <err-name>>).errorClass`:
 * CSCB's class for that agent-director error. The instance is built as the
 * client builds one from an envelope (`spawn`, the name, a description).
 */
const adErrorClass: Entry = {
  synopsis: '<err-name>',
  async print(args, context) {
    const entry = 'classifyAdError'
    expectArguments(entry, args, ['err-name'])
    const [errName] = args
    const client = await context.importAgentDirectorClient()
    const base = client['AgentDirectorError']
    const errorClass = Object.hasOwn(client, errName) ? client[errName] : undefined
    if (typeof base !== 'function' || typeof errorClass !== 'function' || !(errorClass.prototype instanceof base)) {
      fail(PRINTER_FAIL_EXIT, `the installed agent-director client exports no error class ${errName}`)
    }
    const instance = new (errorClass as EnvelopeErrorClass)('spawn', errName, `${PRINTER_NAME}: ${errName}`)
    const classify = await packageFunction<(value: unknown) => { readonly errorClass?: unknown }>(context, 'ad-error-class.ts', entry)
    return builtString(entry, classify(instance).errorClass)
  },
}

/**
 * `DEFAULT_AD_SETTINGS[<table>][<key>]` in decimal: agent-director's default
 * for one setting as CSCB records it (an integer, a `bigint` in the package).
 */
const adSettingDefault: Entry = {
  synopsis: '<table> <key>',
  async print(args, context) {
    const entry = 'DEFAULT_AD_SETTINGS'
    expectArguments(entry, args, ['table', 'key'])
    const [table, key] = args
    const defaults = await packageExport(context, 'ad-settings.ts', entry)
    if (typeof defaults !== 'object' || defaults === null) fail(PRINTER_FAIL_EXIT, `the installed package's src/ad-settings.ts export ${entry} is not an object`)
    const tables = defaults as Record<string, unknown>
    const values = Object.hasOwn(tables, table) ? tables[table] : undefined
    if (typeof values !== 'object' || values === null) usageFail(`${entry}: the installed package records no table '${table}'`)
    const keyed = values as Record<string, unknown>
    const value = Object.hasOwn(keyed, key) ? keyed[key] : undefined
    if (value === undefined) usageFail(`${entry}: the installed package records no key '${key}' in table '${table}'`)
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
    fail(PRINTER_FAIL_EXIT, `the installed package's ${entry}.${table}.${key} is a ${typeof value}, not an integer`)
  },
}

/** `meetsPhase1Floor(<version>)`: `true` or `false`. */
const phase1Floor: Entry = {
  synopsis: '<version>',
  async print(args, context) {
    const entry = 'meetsPhase1Floor'
    expectArguments(entry, args, ['version'])
    const [version] = args
    const meets = await packageFunction<(version: string) => unknown>(context, 'ad-version-gate.ts', entry)
    const value = meets(version)
    if (typeof value !== 'boolean') fail(PRINTER_FAIL_EXIT, `${entry} answered a ${typeof value}, not a boolean`)
    return String(value)
  },
}

/** A value in decimal: a `bigint`, or a `number` that is a safe integer; a failure for anything else. */
function decimal(entry: string, value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  fail(PRINTER_FAIL_EXIT, `${entry} gave ${typeof value === 'number' ? String(value) : `a ${typeof value}`}, not an integer`)
}

/** Fails with a usage failure unless `text` is an integer in decimal (an optional `-`, then digits); answers it as a `bigint`. */
function integerArgument(entry: string, name: string, text: string): bigint {
  if (!/^-?[0-9]+$/.test(text)) usageFail(`${entry}: <${name}> '${text}' is not an integer`)
  return BigInt(text)
}

/** The package's `AD_TMUX_KEYS`: the nine `[tmux]` keys, in order. */
async function packageTmuxKeys(context: EntryContext): Promise<readonly string[]> {
  const keys = await packageExport(context, 'ad-settings.ts', 'AD_TMUX_KEYS')
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !/^[a-z_]+$/.test(k))) {
    fail(PRINTER_FAIL_EXIT, "the installed package's src/ad-settings.ts export AD_TMUX_KEYS is not an array of key names")
  }
  return keys as string[]
}

/**
 * The nine `[tmux]` values: `DEFAULT_AD_SETTINGS.tmux`, each key a
 * `<key>=<integer>` argument names taking that value instead. A key not in
 * `AD_TMUX_KEYS`, a key given twice or a value that is not an integer is a
 * usage failure.
 */
async function tmuxValuesFrom(entry: string, pairs: readonly string[], context: EntryContext): Promise<Record<string, bigint>> {
  const keys = await packageTmuxKeys(context)
  const defaults = await packageExport(context, 'ad-settings.ts', 'DEFAULT_AD_SETTINGS')
  const tmux = typeof defaults === 'object' && defaults !== null ? (defaults as Record<string, unknown>)['tmux'] : undefined
  if (typeof tmux !== 'object' || tmux === null) fail(PRINTER_FAIL_EXIT, "the installed package's src/ad-settings.ts export DEFAULT_AD_SETTINGS has no tmux table")
  const values: Record<string, bigint> = {}
  for (const key of keys) {
    const value = (tmux as Record<string, unknown>)[key]
    if (typeof value !== 'bigint') fail(PRINTER_FAIL_EXIT, `the installed package's DEFAULT_AD_SETTINGS.tmux.${key} is a ${typeof value}, not a bigint`)
    values[key] = value
  }
  const given = new Set<string>()
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    if (eq < 0 || !keys.includes(key)) usageFail(`${entry}: '${pair}' is not <key>=<integer> for a [tmux] key (${keys.join(', ')})`)
    if (given.has(key)) usageFail(`${entry}: ${key} is given twice`)
    given.add(key)
    values[key] = integerArgument(entry, key, pair.slice(eq + 1))
  }
  return values
}

/** The values in effect for `<key>=<integer>` arguments: those `[tmux]` values (`tmuxValuesFrom`) and `DEFAULT_AD_SETTINGS_IN_EFFECT`'s `pauseTimeout`. */
async function settingsInEffectFrom(entry: string, pairs: readonly string[], context: EntryContext): Promise<object> {
  const tmux = await tmuxValuesFrom(entry, pairs, context)
  const inEffect = await packageExport(context, 'ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT')
  const pauseTimeout = typeof inEffect === 'object' && inEffect !== null ? (inEffect as Record<string, unknown>)['pauseTimeout'] : undefined
  if (typeof pauseTimeout !== 'object' || pauseTimeout === null) fail(PRINTER_FAIL_EXIT, "the installed package's src/ad-settings.ts export DEFAULT_AD_SETTINGS_IN_EFFECT has no pauseTimeout")
  return { tmux, pauseTimeout }
}

/** `<name>(<the values in effect for the <key>=<integer> arguments>)` in decimal: a derived wait of `src/ad-settings.ts`. */
function derivedWaitEntry(name: string): Entry {
  return {
    synopsis: '[<key>=<integer>…]',
    async print(args, context) {
      const values = await settingsInEffectFrom(name, args, context)
      const derive = await packageFunction<(values: object) => unknown>(context, 'ad-settings.ts', name)
      return decimal(name, derive(values))
    },
  }
}

/** `buildAdSettingsValuesLine(<path>, <the [tmux] values for the <key>=<integer> arguments>)`: the server's values line. */
const adSettingsValuesLine: Entry = {
  synopsis: '<path> [<key>=<integer>…]',
  async print(args, context) {
    const entry = 'buildAdSettingsValuesLine'
    const [path, ...pairs] = args
    if (path === undefined || path === '') usageFail(`${entry} takes <path> [<key>=<integer>…] (no <path> given)`)
    const values = await tmuxValuesFrom(entry, pairs, context)
    const build = await packageFunction<(path: string, values: object) => unknown>(context, 'ad-settings.ts', entry)
    return builtString(entry, build(path, values))
  },
}

/** `AD_TMUX_KEYS`, the nine keys in order, joined by single spaces. */
const adTmuxKeys: Entry = {
  synopsis: '',
  async print(args, context) {
    expectArguments('AD_TMUX_KEYS', args, [])
    return (await packageTmuxKeys(context)).join(' ')
  },
}

/** `AD_SETTING_MINIMUMS[<key>]` in decimal, or `AD_SETTING_MINIMUMS[<key>][<part>]` for a key whose minimum has parts (`floor`, `addend`). */
const adSettingMinimum: Entry = {
  synopsis: '<key> [<part>]',
  async print(args, context) {
    const entry = 'AD_SETTING_MINIMUMS'
    const [key, part] = args
    if (args.length < 1 || args.length > 2 || args.some((a) => a === '')) usageFail(`${entry} takes <key> [<part>] (got ${args.length} argument${args.length === 1 ? '' : 's'})`)
    const minimums = await packageExport(context, 'ad-settings.ts', entry)
    if (typeof minimums !== 'object' || minimums === null) fail(PRINTER_FAIL_EXIT, `the installed package's src/ad-settings.ts export ${entry} is not an object`)
    const byKey = minimums as Record<string, unknown>
    const value = Object.hasOwn(byKey, key) ? byKey[key] : undefined
    if (value === undefined) usageFail(`${entry}: the installed package records no minimum for '${key}'`)
    if (typeof value === 'object' && value !== null) {
      const parts = value as Record<string, unknown>
      if (part === undefined) usageFail(`${entry}: the minimum of '${key}' has parts (${Object.keys(parts).join(', ')}); name one`)
      if (!Object.hasOwn(parts, part)) usageFail(`${entry}: the minimum of '${key}' has no part '${part}'`)
      return decimal(`${entry}.${key}.${part}`, parts[part])
    }
    if (part !== undefined) usageFail(`${entry}: the minimum of '${key}' has no parts`)
    return decimal(`${entry}.${key}`, value)
  },
}

/** `pendingGraceMinimumSeconds(<create-timeout-ms>, <pipe-close-wait-ms>)` in decimal. */
const graceMinimum: Entry = {
  synopsis: '<create-timeout-ms> <pipe-close-wait-ms>',
  async print(args, context) {
    const entry = 'pendingGraceMinimumSeconds'
    expectArguments(entry, args, ['create-timeout-ms', 'pipe-close-wait-ms'])
    const [create, pipe] = args
    const minimum = await packageFunction<(create: bigint, pipe: bigint) => unknown>(context, 'ad-settings.ts', entry)
    return decimal(entry, minimum(integerArgument(entry, 'create-timeout-ms', create), integerArgument(entry, 'pipe-close-wait-ms', pipe)))
  },
}

/** `wholeMinutes(<ms>)` in decimal. */
const minutesOf: Entry = {
  synopsis: '<ms>',
  async print(args, context) {
    const entry = 'wholeMinutes'
    expectArguments(entry, args, ['ms'])
    const ms = integerArgument(entry, 'ms', args[0])
    const minutes = await packageFunction<(ms: number) => unknown>(context, 'ad-settings.ts', entry)
    return decimal(entry, minutes(Number(ms)))
  },
}

/** `stuckLaunchRelaunchingText(<persona-key>, <launch-bound-ms>)`: the stuck-launch post's relaunching text. */
const relaunchingText: Entry = {
  synopsis: '<persona-key> <launch-bound-ms>',
  async print(args, context) {
    const entry = 'stuckLaunchRelaunchingText'
    expectArguments(entry, args, ['persona-key', 'launch-bound-ms'])
    const [key, bound] = args
    const ms = integerArgument(entry, 'launch-bound-ms', bound)
    const build = await packageFunction<(key: string, launchBoundMs: number) => unknown>(context, 'pending-row.ts', entry)
    return builtString(entry, build(key, Number(ms)))
  },
}

/** `liveRowSequenceWaitArmedLine(<persona-ref>, <launch-start-ms>, <grace-ms>)`: the step-2 wait's armed line. */
const liveRowWaitArmedLine: Entry = {
  synopsis: '<persona-ref> <launch-start-ms> <grace-ms>',
  async print(args, context) {
    const entry = 'liveRowSequenceWaitArmedLine'
    expectArguments(entry, args, ['persona-ref', 'launch-start-ms', 'grace-ms'])
    const [ref, start, grace] = args
    const startMs = integerArgument(entry, 'launch-start-ms', start)
    const graceMs = integerArgument(entry, 'grace-ms', grace)
    const build = await packageFunction<(ref: string, launchStartMs: number, graceMs: number) => unknown>(context, 'live-row-sequence.ts', entry)
    return builtString(entry, build(ref, Number(startMs), Number(graceMs)))
  },
}

/** `liveRowSequenceWaitEndedLine(<persona-ref>)`: the step-2 wait's end line. */
const liveRowWaitEndedLine: Entry = {
  synopsis: '<persona-ref>',
  async print(args, context) {
    const entry = 'liveRowSequenceWaitEndedLine'
    expectArguments(entry, args, ['persona-ref'])
    const build = await packageFunction<(ref: string) => unknown>(context, 'live-row-sequence.ts', entry)
    return builtString(entry, build(args[0]))
  },
}

/**
 * `liveRowSequenceRunLine(<persona-ref>, <step>, <run-number>, <the package's <placement-export>>)`:
 * the live-row sequence's line for one `find-missing` run.
 */
const liveRowRunLine: Entry = {
  synopsis: '<persona-ref> <step> <run-number> <placement-export>',
  async print(args, context) {
    const entry = 'liveRowSequenceRunLine'
    expectArguments(entry, args, ['persona-ref', 'step', 'run-number', 'placement-export'])
    const [ref, stepText, runText, placementExport] = args
    const step = integerArgument(entry, 'step', stepText)
    if (step !== 3n && step !== 4n) usageFail(`${entry}: <step> must be 3 or 4 (got '${stepText}')`)
    const run = integerArgument(entry, 'run-number', runText)
    if (!/^LIVE_ROW_RUN_[A-Z_]+$/.test(placementExport)) usageFail(`${entry}: <placement-export> '${placementExport}' is not a LIVE_ROW_RUN_… name`)
    const placement = await packageString(context, 'live-row-sequence.ts', placementExport)
    const build = await packageFunction<(ref: string, step: number, run: number, placement: string) => unknown>(context, 'live-row-sequence.ts', entry)
    return builtString(entry, build(ref, Number(step), Number(run), placement))
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
  classifyAdError: adErrorClass,
  DEFAULT_AD_SETTINGS: adSettingDefault,
  // Scenario 23 (test-20-fmk-old-binary.sh).
  CLIENT_DEV_SENTINEL_VERSION: constantEntry('ad-version-gate.ts', 'CLIENT_DEV_SENTINEL_VERSION'),
  AD_SYSTEM_INSTALL_UNREACHABLE: constantEntry('install-check-labels.ts', 'AD_SYSTEM_INSTALL_UNREACHABLE'),
  UNREACHABLE_REASON_UNPARSEABLE_VERSION: constantEntry('ad-version-gate.ts', 'UNREACHABLE_REASON_UNPARSEABLE_VERSION'),
  meetsPhase1Floor: phase1Floor,
  // Scenario 24 (test-26-fmk-timing-settings.sh).
  AD_SETTINGS_LOG_PREFIX: constantEntry('ad-settings.ts', 'AD_SETTINGS_LOG_PREFIX'),
  buildAdSettingsValuesLine: adSettingsValuesLine,
  AD_SETTINGS_RELATIVE_PATH: constantEntry('ad-settings.ts', 'AD_SETTINGS_RELATIVE_PATH'),
  AD_TMUX_TABLE: constantEntry('ad-settings.ts', 'AD_TMUX_TABLE'),
  AD_PAUSE_TABLE: constantEntry('ad-settings.ts', 'AD_PAUSE_TABLE'),
  AD_PAUSE_TIMEOUT_KEY: constantEntry('ad-settings.ts', 'AD_PAUSE_TIMEOUT_KEY'),
  AD_TMUX_KEYS: adTmuxKeys,
  AD_SETTING_MINIMUMS: adSettingMinimum,
  pendingGraceMinimumSeconds: graceMinimum,
  adGraceMs: derivedWaitEntry('adGraceMs'),
  adAlertThresholdMs: derivedWaitEntry('adAlertThresholdMs'),
  adLaunchBoundMs: derivedWaitEntry('adLaunchBoundMs'),
  wholeMinutes: minutesOf,
  STILL_STOPPING_PHRASE: constantEntry('ad-description-phrases.ts', 'STILL_STOPPING_PHRASE'),
  STILL_STARTING_PHRASE: constantEntry('ad-description-phrases.ts', 'STILL_STARTING_PHRASE'),
  stuckLaunchRelaunchingText: relaunchingText,
  DIALOG_POLL_INTERVAL_MS: constantEntry('session-manager.ts', 'DIALOG_POLL_INTERVAL_MS'),
  DIALOG_SLOW_POLL_INTERVAL_MS: constantEntry('session-manager.ts', 'DIALOG_SLOW_POLL_INTERVAL_MS'),
  STARTUP_ERROR_SPAWN_FAILED: constantEntry('session-manager.ts', 'STARTUP_ERROR_SPAWN_FAILED'),
  LIVE_ROW_SEQUENCE_LOG_PREFIX: constantEntry('live-row-sequence.ts', 'LIVE_ROW_SEQUENCE_LOG_PREFIX'),
  liveRowSequenceWaitArmedLine: liveRowWaitArmedLine,
  liveRowSequenceWaitEndedLine: liveRowWaitEndedLine,
  liveRowSequenceRunLine: liveRowRunLine,
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
  async importAgentDirectorClient() {
    return await import(Bun.resolveSync('agent-director', join(PKG_DIR, 'src')))
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
