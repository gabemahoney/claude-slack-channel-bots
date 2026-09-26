/**
 * args.ts — the /ci-live command line.
 *
 *   bun ci-live/run.ts [--dry-run] [--provision-only] [--stage apps|install|tokens|channels]
 *                      [--only <check ids>] [--keep-container] [--clean] [--create-apps]
 *   bun ci-live/run.ts login [--second]
 *   bun ci-live/run.ts mailbox --latest|--forwarding [--show-body]
 *
 * Pure: parses an argv array into options or a usage error. A usage error
 * never echoes an argument it does not know (it could be a pasted secret):
 * it names the argument's position, or the argument itself only when it is a
 * plain `--flag-name`.
 */

export const STAGES = ['apps', 'install', 'tokens', 'channels'] as const
export type Stage = (typeof STAGES)[number]

export interface RunOptions {
  command: 'run' | 'login' | 'mailbox'
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
  /** `login --second`: sign the second workspace user in instead of the test human. Set only when given. */
  second?: boolean
  /**
   * `mailbox`: which message it shows, the newest (`--latest`) or the newest
   * Gmail forwarding confirmation (`--forwarding`). Set only for `mailbox`.
   */
  mailboxView?: 'latest' | 'forwarding'
  /** `mailbox … --show-body`: print the message's body too. Set only when given. */
  showBody?: boolean
}

export const USAGE =
  'usage: bun ci-live/run.ts [--dry-run] [--provision-only] [--stage apps|install|tokens|channels] ' +
  '[--only <check ids, comma-separated>] [--keep-container] [--clean] [--create-apps]\n' +
  '       bun ci-live/run.ts login [--second]\n' +
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
  if (argv[0] === 'login') {
    options.command = 'login'
    const rest = argv.slice(1)
    if (rest.length === 1 && rest[0] === '--second') options.second = true
    else if (rest.length > 0) throw new UsageError('login takes no arguments other than --second')
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
  return options
}
