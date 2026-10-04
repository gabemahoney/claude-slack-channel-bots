/**
 * args.ts — the /ci-live command line.
 *
 *   bun ci-live/run.ts [--dry-run] [--provision-only] [--stage apps|install|tokens|channels]
 *                      [--only <check ids>] [--keep-container] [--clean] [--create-apps]
 *                      [--agent-director-binary <path>]
 *   bun ci-live/run.ts login [--second]
 *   bun ci-live/run.ts config-token --rotate
 *   bun ci-live/run.ts apps --list|--delete-strays
 *   bun ci-live/run.ts mailbox --latest|--forwarding [--show-body]
 *
 * Pure: parses an argv array into options or a usage error. A usage error
 * never echoes an argument it does not know (it could be a pasted secret):
 * it names the argument's position, or the argument itself only when it is a
 * plain `--flag-name`. The `--agent-director-binary` path is never echoed.
 */

export const STAGES = ['apps', 'install', 'tokens', 'channels'] as const
export type Stage = (typeof STAGES)[number]

export interface RunOptions {
  command: 'run' | 'login' | 'mailbox' | 'config-token' | 'apps'
  dryRun: boolean
  provisionOnly: boolean
  /** Run only this provisioning stage (implies `provisionOnly`). */
  stage: Stage | null
  /** Check ids to run (others are SKIPPED (not selected)); empty = all. */
  only: string[]
  keepContainer: boolean
  /** Remove the results dir on PASS. */
  clean: boolean
  /**
   * `--create-apps`: a real run may create the four test apps although no
   * apps.json exists (a new VM would otherwise create duplicates). Set only
   * when given.
   */
  createApps?: boolean
  /**
   * `--agent-director-binary <path>`: the agent-director binary the live
   * image is built with, staged as given (lib/agent-director-binary.ts
   * validates it by reading only; nothing runs it on the host). A run only,
   * dry or real; never with `--provision-only` or `--stage`, which build no
   * image. Set only when given: without it the runner searches the host.
   */
  agentDirectorBinary?: string
  /** `login --second`: sign the second workspace user in instead of the test human. Set only when given. */
  second?: boolean
  /**
   * `mailbox`: which message it shows, the newest (`--latest`) or the newest
   * Gmail forwarding confirmation (`--forwarding`). Set only for `mailbox`.
   */
  mailboxView?: 'latest' | 'forwarding'
  /** `mailbox … --show-body`: print the message's body too. Set only when given. */
  showBody?: boolean
  /** `config-token --rotate`: rotate the configuration token pair once. Set only for `config-token`. */
  rotate?: boolean
  /**
   * `apps`: list the apps the test human sees at api.slack.com/apps
   * (`--list`), or also delete the stray test apps (`--delete-strays`). Set
   * only for `apps`.
   */
  appsAction?: 'list' | 'delete-strays'
}

export const USAGE =
  'usage: bun ci-live/run.ts [--dry-run] [--provision-only] [--stage apps|install|tokens|channels] ' +
  '[--only <check ids, comma-separated>] [--keep-container] [--clean] [--create-apps] ' +
  '[--agent-director-binary <path>]\n' +
  '       bun ci-live/run.ts login [--second]\n' +
  '       bun ci-live/run.ts config-token --rotate\n' +
  '       bun ci-live/run.ts apps --list|--delete-strays\n' +
  '       bun ci-live/run.ts mailbox --latest|--forwarding [--show-body]'

/** An argument a usage error may repeat: a plain `--flag-name`, nothing that could be a value. */
const ECHOABLE_ARGUMENT_RE = /^--[a-z-]+$/

/** How a usage error names argument `index` (0-based) of the argv. */
function argumentRef(arg: string, index: number): string {
  return ECHOABLE_ARGUMENT_RE.test(arg) ? JSON.stringify(arg) : `#${index + 1}`
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** A check id as the testplan names it: `S2`, `1`, `29a`, `HOST`, `preflight`, `install`. */
const CHECK_ID_RE = /^[A-Za-z0-9-]{1,16}$/

/** The option that names the agent-director binary a run stages in the live image. */
export const AGENT_DIRECTOR_BINARY_OPTION = '--agent-director-binary'

/**
 * A maintenance command builds no image: it refuses `--agent-director-binary`
 * by its position in the argv (never echoing the path after it).
 */
function refuseAgentDirectorBinary(command: string, argv: readonly string[]): void {
  const at = argv.indexOf(AGENT_DIRECTOR_BINARY_OPTION)
  if (at >= 0) {
    throw new UsageError(`${command} builds no image: it does not take ${AGENT_DIRECTOR_BINARY_OPTION} (argument #${at + 1})`)
  }
}

export function parseArgs(argv: readonly string[]): RunOptions {
  const options: RunOptions = {
    command: 'run',
    dryRun: false,
    provisionOnly: false,
    stage: null,
    only: [],
    keepContainer: false,
    clean: false,
  }
  if (argv[0] === 'login' || argv[0] === 'config-token' || argv[0] === 'apps' || argv[0] === 'mailbox') {
    refuseAgentDirectorBinary(argv[0], argv)
  }
  if (argv[0] === 'login') {
    options.command = 'login'
    const rest = argv.slice(1)
    if (rest.length === 1 && rest[0] === '--second') options.second = true
    else if (rest.length > 0) throw new UsageError('login takes no arguments other than --second')
    return options
  }
  if (argv[0] === 'config-token') {
    options.command = 'config-token'
    const rest = argv.slice(1)
    if (rest.length !== 1 || rest[0] !== '--rotate') {
      throw new UsageError('config-token takes --rotate (rotate the configuration token pair once) and nothing else')
    }
    options.rotate = true
    return options
  }
  if (argv[0] === 'apps') {
    options.command = 'apps'
    const rest = argv.slice(1)
    const [action] = rest
    if (rest.length !== 1 || (action !== '--list' && action !== '--delete-strays')) {
      throw new UsageError('apps takes --list (the apps in the test workspace) or --delete-strays (also delete the stray test apps), and nothing else')
    }
    options.appsAction = action === '--list' ? 'list' : 'delete-strays'
    return options
  }
  if (argv[0] === 'mailbox') {
    options.command = 'mailbox'
    const views = new Set<'latest' | 'forwarding'>()
    const given = new Set<string>()
    argv.slice(1).forEach((arg, i) => {
      if (arg !== '--latest' && arg !== '--forwarding' && arg !== '--show-body') {
        throw new UsageError(`mailbox takes only --latest or --forwarding, and --show-body (unknown argument ${argumentRef(arg, i + 1)})`)
      }
      // As `login --second --second` is refused: a flag given twice is a mistyped command.
      if (given.has(arg)) throw new UsageError(`mailbox takes ${arg} only once`)
      given.add(arg)
      if (arg === '--latest') views.add('latest')
      else if (arg === '--forwarding') views.add('forwarding')
      else options.showBody = true
    })
    if (views.size > 1) throw new UsageError('mailbox takes --latest or --forwarding, not both')
    const view = [...views][0]
    if (!view) {
      throw new UsageError('mailbox needs --latest (the newest message in the test mailbox) or --forwarding (the newest Gmail forwarding confirmation)')
    }
    options.mailboxView = view
    return options
  }
  let index = 0
  const next = (): string | undefined => argv[index++]
  /** Where `--agent-director-binary` was given (0-based), or -1. */
  let binaryAt = -1
  while (index < argv.length) {
    const at = index
    const arg = next() as string
    switch (arg) {
      case '--dry-run':
        options.dryRun = true
        break
      case '--provision-only':
        options.provisionOnly = true
        break
      case '--keep-container':
        options.keepContainer = true
        break
      case '--clean':
        options.clean = true
        break
      case '--create-apps':
        options.createApps = true
        break
      case '--stage': {
        const value = next()
        if (!value || !(STAGES as readonly string[]).includes(value)) {
          throw new UsageError(`--stage needs one of ${STAGES.join(', ')}`)
        }
        options.stage = value as Stage
        options.provisionOnly = true
        break
      }
      case AGENT_DIRECTOR_BINARY_OPTION: {
        if (binaryAt >= 0) {
          throw new UsageError(`${AGENT_DIRECTOR_BINARY_OPTION} is given twice (arguments #${binaryAt + 1} and #${at + 1}): give it once`)
        }
        binaryAt = at
        const value = next()
        // A missing value, an empty one, or the next flag taken as the value.
        if (value === undefined || value === '' || value.startsWith('-')) {
          throw new UsageError(`${AGENT_DIRECTOR_BINARY_OPTION} (argument #${at + 1}) needs the path of the agent-director binary to stage in the live image`)
        }
        options.agentDirectorBinary = value
        break
      }
      case '--only': {
        const value = next()
        const ids = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (ids.length === 0 || !ids.every((id) => CHECK_ID_RE.test(id))) {
          throw new UsageError('--only needs a comma-separated list of check ids (for example 1,2,S2)')
        }
        options.only.push(...ids)
        break
      }
      default:
        throw new UsageError(`unknown argument ${argumentRef(arg, at)}`)
    }
  }
  if (options.dryRun && options.stage !== null) {
    throw new UsageError('--stage runs one real provisioning stage; it does not combine with --dry-run')
  }
  if (binaryAt >= 0 && options.provisionOnly) {
    throw new UsageError(
      `${AGENT_DIRECTOR_BINARY_OPTION} (argument #${binaryAt + 1}) stages the binary the live image is built with; ` +
        `${options.stage !== null ? '--stage' : '--provision-only'} builds no image, so they do not combine`,
    )
  }
  return options
}
