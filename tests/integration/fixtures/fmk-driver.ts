/**
 * fmk-driver.ts — the driver of the calls an fmk scenario forces (b.jg5
 * SRJ-1306). It drives production functions of the installed package (the
 * tarball under test) against the real agent-director and tmux of the
 * scenario's own HOME, as `driver.ts` does for test-4, for the calls a
 * scenario cannot get from the bot server alone: a `resume` in scenario 5, a
 * reuse spawn in scenarios 8 and 25, and a CSCB call made with another
 * `TMUX_TMPDIR` in scenario 26. Each forced call is one entry of
 * `FORCED_CALLS`, and each goes through CSCB's production code: the
 * package's exported forced-launch seams or its exported pane reader, never
 * a raw client call. Whether a forced call must also have effects in the bot
 * server is not this driver's to decide.
 *
 * REFUSAL
 * -------
 * Runs only in a cscb-ci image. Its first statement checks for the image
 * marker `/etc/cscb-ci-image`; without it, the driver prints
 * `FAIL: fmk-driver: refused: /etc/cscb-ci-image is absent …` on stderr and
 * exits 2, before it reads an argument or loads a module. Only `node:`
 * built-ins are imported statically: the package under test and the
 * agent-director client that package resolves are imported dynamically, after
 * the check, by the forced call that needs them, through the context's
 * `importPackageModule` and `importAgentDirectorClient`.
 *
 * HOW A SCENARIO RUNS IT
 * ----------------------
 * Through scenario.sh's `cscb_run`, so the driver is a recorded CSCB process
 * with the tmux shim first on its PATH, and with the scenario HOME, so the
 * client resolves that HOME's agent-director shim:
 *
 *   cscb_run env DRIVER_PERSONA=… DRIVER_PERSONA_CHANNEL=… \
 *     DRIVER_WORKING_DIRECTORY=… bun fmk-driver.ts <forced-call>
 *
 * The program `cscb_run` runs must be the driver's own process (`bun`,
 * directly or through `env`).
 *
 * USAGE
 * -----
 *   bun fmk-driver.ts <forced-call>
 *
 * With no forced call named, it prints
 * `FAIL: fmk-driver: no forced call was named …` on stderr and exits 64; with
 * an unknown one, `FAIL: fmk-driver: unknown forced call '<name>' …`, also
 * exit 64. A forced call takes no further argument.
 *
 * INPUTS (env)
 * ------------
 *   CSCB_PKG_DIR               the installed package (default
 *                              /test-repo/node_modules/claude-slack-channel-bots)
 *   DRIVER_PERSONA             the persona's name (required); its key is
 *                              derived by the package (`personaKey`)
 *   DRIVER_PERSONA_CHANNEL     the persona's one channel ID (required)
 *   DRIVER_WORKING_DIRECTORY   the persona's working directory (required)
 *   DRIVER_OTHER_TMUX_TMPDIR   read-pane-other-tmux-tmpdir only: the other
 *                              `TMUX_TMPDIR` for its one call (required there;
 *                              never the scenario's own)
 *   TMUX_TMPDIR                read-pane-other-tmux-tmpdir only: the
 *                              scenario's own (required there), put back
 *                              once the call settles
 *
 * PREPARATION (before every forced call, as driver.ts prepares)
 * --------------------------------------------------------------
 * A one-persona configuration through the package's persona resolver
 * (`resolvePersonaConfig`): the persona's name, its one channel, which also
 * takes permission prompts, its working directory, and a credentials_file
 * path that is never read (the driver opens no Slack connection); the
 * working directory anchors the configuration. Then the package's
 * agent-director startup gate (`runAgentDirectorStartupGate`, which installs
 * the client), whose refusal is reported as a DRIVER_FAIL line in place of
 * the gate's own exit and log entry, and the outage state
 * (`initOutageState`, its persona notice logged to stderr only). No latch,
 * notifier, retry timer or pre-launch hook is installed.
 *
 * FORCED CALLS AND OUTPUT CONTRACT
 * --------------------------------
 * Each forced call prints exactly one outcome line on stdout and exits 0,
 * whatever the call answered. CSCB's own lines go to stderr.
 *
 *   resume         the package's `_forceResumeForPersona`: one `resume` of
 *                  the persona's own row whatever its state (scenario 5).
 *   reuse-spawn    the package's `_forceReuseSpawnForPersona`: one reuse
 *                  spawn (`reuse_finished`) of the persona's own id
 *                  (scenarios 8 and 25).
 *     Their line:
 *       DRIVER: FORCED <call> called=<bool> action=<action> counted=<bool> latched=<bool> error=<name> class=<class> [unknown_name=<name>] description=<json> result=<json>
 *     with `error=none` and no class or description when the call returned
 *     success or was not made. `action` and `result` are what the
 *     production path answered; `error`, `class`, `unknown_name` and
 *     `description` the forced call's own error as CSCB classified it;
 *     `counted` whether the result was counted as a launch failure;
 *     `latched` whether the persona is latched afterwards (no latch is
 *     installed, so only a `latched` answer reads true).
 *
 *   read-pane-other-tmux-tmpdir
 *                  the package's `readPersonaOwnPane` (the persona's
 *                  own-pane read, a tmux-touching verb, 40 lines, no row
 *                  state read before it) with `TMUX_TMPDIR` set to
 *                  DRIVER_OTHER_TMUX_TMPDIR for that one call and put back
 *                  once it settles (scenario 26).
 *     Its line:
 *       DRIVER: FORCED read-pane-other-tmux-tmpdir tmux_tmpdir=<json> restored=<bool> outcome=<kind> …
 *     followed, for a pane, by `lines=<n> last_line=<json>`; for a failure,
 *     by `class=<class> description=<json>` (the description starts with the
 *     reported name) and `stopping=true` when its version re-check decided
 *     the stop; for a latched answer, by `cause=none`, or by the latching
 *     answer's `cause=<kind> error=<name> class=<class> [unknown_name=<name>]
 *     description=<json>`. `restored` says whether `TMUX_TMPDIR` reads the
 *     scenario's own again.
 *
 *   A failure before the forced call (a missing input, an argument, a
 *   resolver error, the gate's refusal, a package that lacks the export)
 *   prints `DRIVER_FAIL: <reason>` on one line and exits 1, as does anything
 *   the forced call throws.
 *
 * The driver makes no agent-director call of its own: every call it causes
 * is made by the package's production code for the forced call. It removes
 * no row and ends no session, before or after that call.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: fmk-driver: refused: /etc/cscb-ci-image is absent; this driver runs only in a cscb-ci image (/ci)')
  process.exit(2)
}

/** The name the driver's FAIL lines carry. */
const DRIVER_NAME = 'fmk-driver'

/** Exit status for a missing or unknown forced call (EX_USAGE). */
const USAGE_EXIT = 64

/** Exit status of a DRIVER_FAIL line. */
const DRIVER_FAIL_EXIT = 1

/** The installed package under test. */
const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

/** Never read: the driver opens no Slack connection. Outside any working directory a scenario uses. */
const UNUSED_CREDENTIALS_FILE = '/tmp/fmk-driver-unused-credentials.json'

/** What a forced call gets besides its arguments: the dynamic loaders. */
interface ForcedCallContext {
  /** Import a module of the installed package's `src/` (for example `session-manager.ts`). */
  importPackageModule(relPath: string): Promise<Record<string, unknown>>
  /** Import the agent-director client the installed package resolves. */
  importAgentDirectorClient(): Promise<Record<string, unknown>>
}

/** One forced call: runs with its arguments and returns the driver's exit status. */
type ForcedCall = (args: readonly string[], context: ForcedCallContext) => Promise<number>

/** The persona and its configuration, as the package resolved them (opaque to the driver). */
interface PreparedPersona {
  readonly persona: unknown
  readonly config: unknown
  readonly key: string
}

/** A forced launch's error, as the package's forced-launch seams answer it. */
interface ForcedLaunchError {
  readonly name: string
  readonly errorClass: string
  readonly description: string
  readonly unknownName?: string
}

/** What the package's forced-launch seams answer. */
interface ForcedLaunchOutcome {
  readonly called: boolean
  readonly result: { readonly action: string }
  readonly error?: ForcedLaunchError
  readonly counted: boolean
  readonly latched: boolean
}

/** What the package's own-pane reader answers. */
interface OwnPaneReadOutcome {
  readonly kind: string
  readonly pane?: string
  readonly errorClass?: string
  readonly description?: string
  readonly stopping?: boolean
  readonly cause?: { readonly kind: string; readonly errorClass: string; readonly description: string; readonly error?: unknown }
}

/** The forced-launch seams, by the forced call that runs each. */
const FORCED_LAUNCH_SEAMS = {
  resume: '_forceResumeForPersona',
  'reuse-spawn': '_forceReuseSpawnForPersona',
} as const

/** The forced call that reads the persona's own pane under another `TMUX_TMPDIR`. */
const OTHER_TMUX_TMPDIR_CALL = 'read-pane-other-tmux-tmpdir'

/** Prints `DRIVER_FAIL: <reason>` on one line (line breaks become spaces) and exits 1. */
function driverFail(reason: string): never {
  console.log(`DRIVER_FAIL: ${reason.replace(/\s*\n\s*/g, ' ')}`)
  process.exit(DRIVER_FAIL_EXIT)
}

/** The value of environment variable `name`; a DRIVER_FAIL when it is unset or empty. */
function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') driverFail(`${name} is not set`)
  return value
}

/** Export `name` of the package module `relPath`, which must be a function; a DRIVER_FAIL otherwise. */
async function packageFunction<F>(context: ForcedCallContext, relPath: string, name: string): Promise<F> {
  const mod = await context.importPackageModule(relPath)
  const value = mod[name]
  if (typeof value !== 'function') driverFail(`the installed package's src/${relPath} exports no function ${name}`)
  return value as F
}

/** Export `name` of the package module `relPath`, which must be defined; a DRIVER_FAIL otherwise. */
async function packageValue(context: ForcedCallContext, relPath: string, name: string): Promise<unknown> {
  const mod = await context.importPackageModule(relPath)
  const value = mod[name]
  if (value === undefined) driverFail(`the installed package's src/${relPath} exports no ${name}`)
  return value
}

/** Fails with a DRIVER_FAIL unless the forced call was given no argument. */
function expectNoArguments(call: string, args: readonly string[]): void {
  if (args.length > 0) driverFail(`${call} takes no argument (got ${args.length})`)
}

/**
 * The preparation every forced call makes first: the one-persona
 * configuration through the package's resolver, the startup gate (a refusal
 * is a DRIVER_FAIL) and the outage state.
 */
async function preparePersona(context: ForcedCallContext): Promise<PreparedPersona> {
  const name = requiredEnv('DRIVER_PERSONA')
  const channel = requiredEnv('DRIVER_PERSONA_CHANNEL')
  const workingDirectory = requiredEnv('DRIVER_WORKING_DIRECTORY')

  const resolvePersonaConfig = await packageFunction<(raw: unknown, configDir: string) => { personas: { key: string }[] }>(
    context,
    'config.ts',
    'resolvePersonaConfig',
  )
  const personaKey = await packageFunction<(name: string) => string>(context, 'persona-identity.ts', 'personaKey')
  let config: { personas: { key: string }[] }
  try {
    config = resolvePersonaConfig(
      {
        personas: [
          {
            name,
            credentials_file: UNUSED_CREDENTIALS_FILE,
            working_directory: workingDirectory,
            channels: [{ id: channel, delivery: 'all' }],
            permission_prompts: channel,
          },
        ],
        bind: '127.0.0.1',
        port: 3100,
      },
      workingDirectory,
    )
  } catch (err) {
    driverFail(`config: the package's resolver refused the persona: ${err instanceof Error ? err.message : String(err)}`)
  }
  const key = personaKey(name)
  const persona = config.personas.find((p) => p.key === key)
  if (config.personas.length !== 1 || persona === undefined) {
    driverFail(`config: expected one persona with key ${key}, got ${config.personas.length}`)
  }

  // The production gate installs the client. Its refusal would log a
  // startup-errors entry and exit; here it is one DRIVER_FAIL line instead.
  const runAgentDirectorStartupGate = await packageFunction<(deps: object) => Promise<unknown>>(
    context,
    'agent-director-startup.ts',
    'runAgentDirectorStartupGate',
  )
  let refusal = 'no reason given'
  await runAgentDirectorStartupGate({
    recordStartupError: (classLabel: string, message: string) => {
      refusal = `${classLabel}: ${message}`
    },
    exit: (): never => driverFail(`the agent-director startup gate refused: ${refusal}`),
  })

  // The launch and read paths go through the outage wrappers, which need the
  // outage state. Its persona notice is logged only (no Slack here).
  const initOutageState = await packageFunction<(deps: object) => void>(context, 'outage-state.ts', 'initOutageState')
  const getClient = await packageFunction<() => unknown>(context, 'agent-director-client.ts', 'getClient')
  initOutageState({
    getClient,
    notify: (noticeKey: string, text: string) => {
      console.error(`[${DRIVER_NAME}] outage-notice persona=${noticeKey}: ${text}`)
    },
  })
  return { persona, config, key }
}

/** The forced launch call's one outcome line. */
function forcedLaunchLine(call: string, outcome: ForcedLaunchOutcome): string {
  const parts = [
    `DRIVER: FORCED ${call}`,
    `called=${outcome.called}`,
    `action=${outcome.result.action}`,
    `counted=${outcome.counted}`,
    `latched=${outcome.latched}`,
  ]
  const { error } = outcome
  if (error === undefined) {
    parts.push('error=none')
  } else {
    parts.push(`error=${error.name}`, `class=${error.errorClass}`)
    if (error.unknownName !== undefined) parts.push(`unknown_name=${error.unknownName}`)
    parts.push(`description=${JSON.stringify(error.description)}`)
  }
  parts.push(`result=${JSON.stringify(outcome.result)}`)
  return parts.join(' ')
}

/** A forced `resume` or reuse spawn through the package's seam for `call`. */
function forcedLaunchCall(call: keyof typeof FORCED_LAUNCH_SEAMS): ForcedCall {
  return async (args, context) => {
    expectNoArguments(call, args)
    const prepared = await preparePersona(context)
    const seam = await packageFunction<(persona: unknown, config: unknown) => Promise<ForcedLaunchOutcome>>(
      context,
      'session-manager.ts',
      FORCED_LAUNCH_SEAMS[call],
    )
    const outcome = await seam(prepared.persona, prepared.config)
    console.log(forcedLaunchLine(call, outcome))
    return 0
  }
}

/** The name and `unknownName` of a value a pane read's latching answer kept, for its outcome line. */
function latchingErrorFields(value: unknown): string[] {
  const fields: string[] = []
  const errName = typeof value === 'object' && value !== null ? (value as { errName?: unknown }).errName : undefined
  fields.push(`error=${typeof errName === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(errName) ? errName : 'unknown'}`)
  const unknownName = typeof value === 'object' && value !== null ? (value as { unknownName?: unknown }).unknownName : undefined
  if (typeof unknownName === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(unknownName)) fields.push(`unknown_name=${unknownName}`)
  return fields
}

/** The fields of the pane read's outcome line after `outcome=<kind>`. */
function paneOutcomeFields(outcome: OwnPaneReadOutcome): string[] {
  if (typeof outcome.pane === 'string') {
    const lines = outcome.pane.split('\n')
    const lastLine = [...lines].reverse().find((line) => line.trim() !== '') ?? ''
    return [`lines=${lines.length}`, `last_line=${JSON.stringify(lastLine)}`]
  }
  if (outcome.errorClass !== undefined) {
    const fields = [`class=${outcome.errorClass}`, `description=${JSON.stringify(outcome.description ?? '')}`]
    if (outcome.stopping === true) fields.push('stopping=true')
    return fields
  }
  const { cause } = outcome
  if (cause === undefined) return ['cause=none']
  return [`cause=${cause.kind}`, ...latchingErrorFields(cause.error), `class=${cause.errorClass}`, `description=${JSON.stringify(cause.description)}`]
}

/**
 * Runs `read` with `TMUX_TMPDIR` set to `otherTmpdir`, and sets it back to
 * `ownTmpdir` once `read` settles, whatever it answers or throws.
 */
async function withOtherTmuxTmpdir<T>(otherTmpdir: string, ownTmpdir: string, read: () => Promise<T>): Promise<T> {
  process.env['TMUX_TMPDIR'] = otherTmpdir
  try {
    return await read()
  } finally {
    process.env['TMUX_TMPDIR'] = ownTmpdir
  }
}

/** The persona's own-pane read through the package's reader, under another `TMUX_TMPDIR` for that one call. */
const readPaneOtherTmuxTmpdir: ForcedCall = async (args, context) => {
  expectNoArguments(OTHER_TMUX_TMPDIR_CALL, args)
  const ownTmpdir = requiredEnv('TMUX_TMPDIR')
  const otherTmpdir = requiredEnv('DRIVER_OTHER_TMUX_TMPDIR')
  if (otherTmpdir === ownTmpdir) driverFail(`DRIVER_OTHER_TMUX_TMPDIR is the scenario's own TMUX_TMPDIR (${ownTmpdir})`)
  const prepared = await preparePersona(context)
  const readPersonaOwnPane = await packageFunction<(key: string, request: object) => Promise<OwnPaneReadOutcome>>(
    context,
    'session-manager.ts',
    'readPersonaOwnPane',
  )
  const nLines = await packageValue(context, 'pane-read.ts', 'FULL_PANE_READ_LINES')
  // The driver reads no row state before the call; a latch the read set
  // would record the row as unreadable (no latch is installed here).
  const lastRead = await packageValue(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_UNREADABLE')
  const outcome = await withOtherTmuxTmpdir(otherTmpdir, ownTmpdir, () =>
    readPersonaOwnPane(prepared.key, { nLines, lastRead, site: DRIVER_NAME }),
  )
  const restored = process.env['TMUX_TMPDIR'] === ownTmpdir
  console.log(
    [
      `DRIVER: FORCED ${OTHER_TMUX_TMPDIR_CALL}`,
      `tmux_tmpdir=${JSON.stringify(otherTmpdir)}`,
      `restored=${restored}`,
      `outcome=${outcome.kind}`,
      ...paneOutcomeFields(outcome),
    ].join(' '),
  )
  return 0
}

/** The forced calls, by the name the scenario passes. */
const FORCED_CALLS: Readonly<Record<string, ForcedCall>> = {
  resume: forcedLaunchCall('resume'),
  'reuse-spawn': forcedLaunchCall('reuse-spawn'),
  [OTHER_TMUX_TMPDIR_CALL]: readPaneOtherTmuxTmpdir,
}

const context: ForcedCallContext = {
  async importPackageModule(relPath) {
    return await import(join(PKG_DIR, 'src', relPath))
  },
  async importAgentDirectorClient() {
    return await import(Bun.resolveSync('agent-director', join(PKG_DIR, 'src')))
  },
}

function usageFail(detail: string): number {
  const known = Object.keys(FORCED_CALLS).sort()
  console.error(`FAIL: ${DRIVER_NAME}: ${detail}; usage: bun fmk-driver.ts <forced-call> (forced calls: ${known.length > 0 ? known.join(', ') : 'none'})`)
  return USAGE_EXIT
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv
  if (name === undefined || name === '') return usageFail('no forced call was named')
  const call = Object.hasOwn(FORCED_CALLS, name) ? FORCED_CALLS[name] : undefined
  if (call === undefined) return usageFail(`unknown forced call '${name}'`)
  try {
    return await call(args, context)
  } catch (err) {
    driverFail(`${name} threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  }
}

process.exit(await main(process.argv.slice(2)))
