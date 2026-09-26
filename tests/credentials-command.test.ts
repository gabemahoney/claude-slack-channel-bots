/**
 * credentials-command.test.ts — the setup wizard's credentials command
 * (b.av2 SR-12, SR-1.4 part): `claude-slack-channel-bots credentials
 * <persona>`, which runs the packaged `scripts/write-credentials.sh` for the
 * persona's `credentials_file`.
 *
 * Most cases run the script itself, as shipped, for a temp path, as a child
 * shell (`<shell> scripts/write-credentials.sh <path>`, with `-f` for zsh):
 *
 * - in the case's own `mkdtempSync` directory (removed in `afterEach`), with an
 *   environment of only `PATH`, a temp `HOME` and the proxy variables pointing
 *   at a closed loopback port, under a small runner that sets `umask 000`
 *   first, so a 0600 file proves the script sets the mode itself (the runner
 *   can also run shell code before and after the script, in its own shell);
 * - with `PATH` holding only a temp bin: a stub `curl` that records its argv,
 *   stdin and exported environment per call and answers each Slack method as
 *   the case scripts it, and wrappers for `mkdir`, `mktemp`, `chmod`, `mv` and
 *   `rm` that record their argv (`chmod` also the mode each file had before
 *   it ran), run the case's hook if it set one (to fail the program or change
 *   the target mid-run) and then run the real program by absolute path. No
 *   real network call can happen, and a program the script needs beyond those
 *   fails the case ("command not found");
 * - with the inputs piped on stdin in the documented order: `yes` (only when
 *   the target exists), the bot token, the app token. The terminal cases run
 *   it under util-linux `script` instead (skipped when that is absent).
 *
 * The wizard's line itself is pinned as shipped (one fenced `bash` block of
 * one short line under `## Credentials command` in
 * `skills/setup-slack-channel-bots/SKILL.md`) and run end to end: filled in
 * as the skill says, padded with the trailing spaces a terminal copy adds,
 * through the real CLI (`bun src/cli.ts`, as the installed binary runs it)
 * over a temp state directory, which runs the script with `bash` from `PATH`
 * (a wrapper recording its argv), so the token is shown to reach no argv.
 *
 * Tokens come from `fakeToken`, so they carry `LEAK_SENTINEL`. Every run's
 * stdout, stderr, recorded argv and curl's environment pass `assertNoLeak`;
 * the recorded curl stdin carries a token by design and is compared, not
 * leak-checked. The stub and wrappers are generated at runtime and hold no
 * token.
 *
 * zsh rows (the script works under bash and zsh) are skipped when zsh is not
 * installed: success, one local rejection, writing and bad paths run under
 * both shells.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { CREDENTIALS_SCRIPT_PATH } from '../src/cli.ts'
import { checkPersonaCredentials } from '../src/persona-credentials.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  assertNoLeak,
  fakeToken,
  writeCredentialsFile,
} from './test-helpers/credentials.ts'
import { requiredSection, splitFences } from './test-helpers/markdown.ts'
import { makePersona, makePersonaConfigInput, writeConfigFile } from './test-helpers/persona-config.ts'

// ---------------------------------------------------------------------------
// The script, and the wizard's line from the skill
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, '..')
/** The script as the package ships it (package.json `files`); the CLI's own constant names it. */
const SCRIPT = join(REPO_ROOT, 'scripts', 'write-credentials.sh')
const CLI_SOURCE = join(REPO_ROOT, 'src', 'cli.ts')
const SKILL_PATH = join(REPO_ROOT, 'skills', 'setup-slack-channel-bots', 'SKILL.md')
const HEADING = '## Credentials command'
const PERSONA_PLACEHOLDER = '<persona>'

/**
 * The one line of the one fenced `bash` block in the `## Credentials command`
 * section. Throws naming what is wrong when the heading is missing, the
 * section holds any other number or kind of fenced block, or the block is not
 * one line holding the placeholder exactly once, so no case can pass
 * vacuously.
 */
function wizardLine(): string {
  const section = requiredSection(readFileSync(SKILL_PATH, 'utf-8'), HEADING, SKILL_PATH)
  const { blocks } = splitFences(section)
  if (blocks.length !== 1 || blocks[0].info !== 'bash') {
    const found = blocks.map((b) => `\`\`\`${b.info}`).join(', ') || 'none'
    throw new Error(`"${HEADING}" must hold exactly one fenced bash block; found: ${found}`)
  }
  const lines = blocks[0].body.split('\n').filter((line) => line.trim() !== '')
  if (lines.length !== 1 || lines[0].split(PERSONA_PLACEHOLDER).length !== 2) {
    throw new Error(`the "${HEADING}" block must be one line holding ${PERSONA_PLACEHOLDER} exactly once; found ${lines.length} lines`)
  }
  return lines[0]
}

/** The wizard's line with `persona` in place of the placeholder, as the skill fills it in. */
function lineFor(persona: string): string {
  return wizardLine().replace(PERSONA_PLACEHOLDER, () => persona)
}

// ---------------------------------------------------------------------------
// Sandbox: temp HOME, stub curl and argv-logging wrappers
// ---------------------------------------------------------------------------

/** Absolute path of a host program, resolved once with the test runner's PATH. */
function hostProgram(name: string): string {
  const path = Bun.which(name)
  if (path === null) throw new Error(`credentials-command tests need ${name} on the host`)
  return path
}

const BASH = hostProgram('bash')
const ZSH = Bun.which('zsh')
/** The shells the script must work in; zsh is null when not installed, and its rows skip. */
const SHELLS: [name: string, path: string | null][] = [
  ['bash', BASH],
  ['zsh', ZSH],
]
/** The describe title suffix for a shell's rows. */
const underShell = (name: string) => (name === 'bash' ? '(bash)' : `(${name}; skipped when ${name} is not installed)`)
/** util-linux `script` (the BSD one takes other flags), or null. */
const SCRIPT_UTIL = ((path) =>
  path !== null && spawnSync(path, ['--version'], { encoding: 'utf-8' }).stdout?.includes('util-linux') ? path : null)(
  Bun.which('script'),
)
const TIMEOUT = Bun.which('timeout')
const REAL_CURL = Bun.which('curl')
const WRAPPED = ['mkdir', 'mktemp', 'chmod', 'mv', 'rm'] as const
type Wrapped = (typeof WRAPPED)[number]
/** Nothing listens on port 1, so a curl that honours the proxy variables fails to connect. */
const CLOSED_PROXY = 'http://127.0.0.1:1'
const TEMP_PREFIX = '.cscb-credentials.'

interface Sandbox {
  root: string
  home: string
  bin: string
  /** Where the stub and wrappers record their calls, and where hooks live. */
  log: string
  /** Scripted Slack answers: `<method>.body` and `<method>.rc`. */
  slack: string
  cwd: string
}

/**
 * The stub `curl`: records argv (one per line), stdin and `export -p` as call
 * N, then answers the method named by the last argv from
 * `<slack>/<method>.body` (with `@TOKEN@` replaced by the bearer token it was
 * given, for echo cases) and exits with `<slack>/<method>.rc`. Only builtins,
 * so PATH needs nothing.
 */
function stubCurl(sb: Sandbox): string {
  return `#!${BASH}
log='${sb.log}'
slack='${sb.slack}'
n=1
while [ -e "$log/curl.$n.argv" ]; do n=$((n+1)); done
printf '%s\\n' "$@" > "$log/curl.$n.argv"
export -p > "$log/curl.$n.env"
input=''
IFS= read -r -d '' input || :
printf '%s' "$input" > "$log/curl.$n.stdin"
url=\${!#}
method=\${url##*/}
rc=0
[ -e "$slack/$method.rc" ] && read -r rc < "$slack/$method.rc"
body=''
[ -e "$slack/$method.body" ] && { IFS= read -r -d '' body < "$slack/$method.body" || :; }
tok=\${input#*Bearer }
tok=\${tok%%\\"*}
body=\${body//@TOKEN@/$tok}
printf '%s' "$body"
exit "$rc"
`
}

/**
 * A wrapper for `name`: appends `name<TAB>arg…` to `calls.log`, sources
 * `hook.<name>` when the case wrote one (it may `exit 1` or change the
 * target), and runs the real program. The `chmod` wrapper also records each
 * regular-file argument's mode as `ls -ld` shows it before chmod runs, so a
 * case can see the mode a file was created with.
 */
function wrapper(sb: Sandbox, name: Wrapped): string {
  const premode =
    name === 'chmod'
      ? `for a in "$@"; do
  if [ -f "$a" ]; then m=$('${hostProgram('ls')}' -ld -- "$a"); printf '%s\\t%s\\n' "$a" "\${m%% *}" >> "$log/premode.log"; fi
done
`
      : ''
  return `#!${BASH}
log='${sb.log}'
{ printf '%s' '${name}'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$log/calls.log"
if [ -e "$log/hook.${name}" ]; then . "$log/hook.${name}"; fi
${premode}exec '${hostProgram(name)}' "$@"
`
}

function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cscb-credentials-command-')))
  const sb: Sandbox = {
    root,
    home: join(root, 'home'),
    bin: join(root, 'bin'),
    log: join(root, 'log'),
    slack: join(root, 'slack'),
    cwd: join(root, 'cwd'),
  }
  for (const dir of [sb.home, sb.bin, sb.log, sb.slack, sb.cwd]) mkdirSync(dir)
  writeFileSync(join(sb.bin, 'curl'), stubCurl(sb), { mode: 0o755 })
  for (const name of WRAPPED) writeFileSync(join(sb.bin, name), wrapper(sb, name), { mode: 0o755 })
  scriptSlack(sb, 'auth.test', '{ "ok": true, "user_id": "U1" }')
  scriptSlack(sb, 'apps.connections.open', '{ "ok" : true, "url": "wss://wss-stub.invalid/link" }')
  return sb
}

/** Script the stub's answer for one Slack method: the body and curl's exit code. */
function scriptSlack(sb: Sandbox, method: string, body: string, rc = 0): void {
  writeFileSync(join(sb.slack, `${method}.body`), body)
  writeFileSync(join(sb.slack, `${method}.rc`), `${rc}\n`)
}

/** Shell code the wrapper for `name` sources before running the real program (its args are `"$@"`). */
function hook(sb: Sandbox, name: Wrapped, code: string): void {
  writeFileSync(join(sb.log, `hook.${name}`), `${code}\n`)
}

// ---------------------------------------------------------------------------
// Running the script
// ---------------------------------------------------------------------------

interface CurlCall {
  argv: string[]
  stdin: string
  /** `export -p` in the stub: the environment curl was given. */
  env: string
}

interface Run {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  curl: CurlCall[]
  /** Wrapped programs' argv, name first, in call order. */
  calls: string[][]
  /** `[file, ls mode]` for each file `chmod` was given, before it ran. */
  premodes: string[][]
}

interface RunOptions {
  shell?: string
  /** Options for the shell running the script, before the script's path (for example `-a`, `-x`). */
  flags?: string[]
  /** Shell code the runner runs before the script, in its own shell. */
  prelude?: string
  /** Shell code the runner runs after the script exits, in its own shell (the runner then exits with the script's status). */
  epilogue?: string
}

function readLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').slice(0, -1) : []
}

/** The child's whole environment: the sandbox PATH and HOME, and every proxy variable closed. */
function childEnv(sb: Sandbox): Record<string, string> {
  return { PATH: sb.bin, HOME: sb.home, https_proxy: CLOSED_PROXY, HTTPS_PROXY: CLOSED_PROXY, ALL_PROXY: CLOSED_PROXY }
}

/**
 * Write the runner a case starts: `umask 000`, the prelude, then its
 * arguments as a command (the shell, its flags, the script and the path),
 * then the epilogue, exiting with the script's status.
 */
function writeRunner(sb: Sandbox, opts: RunOptions): string {
  const runner = join(sb.root, 'run-credentials-script.sh')
  writeFileSync(runner, `umask 000\n${opts.prelude ?? ''}\n"$@"\ncscb_status=$?\n${opts.epilogue ?? ''}\nexit "$cscb_status"\n`)
  return runner
}

/** `<shell> [-f] [flags] <script> <credsPath>`: how the runner starts the script. */
function scriptCommand(credsPath: string, opts: RunOptions): string[] {
  const shell = opts.shell ?? BASH
  return [shell, ...(shell === ZSH ? ['-f'] : []), ...(opts.flags ?? []), SCRIPT, credsPath]
}

/** What the stub and wrappers recorded. */
function recorded(sb: Sandbox): Pick<Run, 'curl' | 'calls' | 'premodes'> {
  const curl: CurlCall[] = []
  for (let n = 1; existsSync(join(sb.log, `curl.${n}.argv`)); n++) {
    curl.push({
      argv: readLines(join(sb.log, `curl.${n}.argv`)),
      stdin: readFileSync(join(sb.log, `curl.${n}.stdin`), 'utf-8'),
      env: readFileSync(join(sb.log, `curl.${n}.env`), 'utf-8'),
    })
  }
  return {
    curl,
    calls: readLines(join(sb.log, 'calls.log')).map((line) => line.split('\t')),
    premodes: readLines(join(sb.log, 'premode.log')).map((line) => line.split('\t')),
  }
}

/** Run the script for `credsPath` under `umask 000` with stdin `input`. */
function runCommand(sb: Sandbox, credsPath: string, input: string, opts: RunOptions = {}): Run {
  const runner = writeRunner(sb, opts)
  const child = spawnSync(BASH, [runner, ...scriptCommand(credsPath, opts)], {
    cwd: sb.cwd,
    env: childEnv(sb),
    input,
    encoding: 'utf-8',
    timeout: 10_000,
  })
  return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, ...recorded(sb) }
}

/**
 * What every run must satisfy: it ran to its end (not killed by the time
 * limit), needed no program beyond the stub and the wrappers, and put no
 * token in its output, in any program's argv or in curl's environment.
 */
function expectSafe(run: Run): void {
  expect(run.signal).toBeNull()
  expect(run.stderr).not.toContain('command not found')
  assertNoLeak({
    stdout: run.stdout,
    stderr: run.stderr,
    curlArgv: run.curl.map((call) => call.argv),
    curlEnv: run.curl.map((call) => call.env),
    calls: run.calls,
    premodes: run.premodes,
  })
}

/** stdin for the script: one value per line. */
function lines(...values: string[]): string {
  return values.map((value) => `${value}\n`).join('')
}

/** The curl config line carrying `token` on curl's stdin. */
function bearer(token: string): string {
  return `header = "Authorization: Bearer ${token}"\n`
}

/**
 * The two Slack calls, in order, each with its own token on stdin only: `-q`
 * first (so no `~/.curlrc` is read), `--config -` (the config, so the token,
 * comes from stdin) and the method's URL last. Other flags are not pinned.
 */
function expectSlackCalls(run: Pick<Run, 'curl'>): void {
  expect(run.curl).toHaveLength(2)
  const expected: [string, string][] = [
    ['auth.test', bot],
    ['apps.connections.open', app],
  ]
  expected.forEach(([method, token], i) => {
    const { argv, stdin } = run.curl[i]
    expect(argv[0]).toBe('-q')
    expect(argv.some((arg, j) => arg === '--config' && argv[j + 1] === '-')).toBe(true)
    expect(argv.at(-1)).toBe(`https://slack.com/api/${method}`)
    expect(stdin === bearer(token)).toBe(true)
  })
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

/** Temp files the script left beside the target. */
function leftovers(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(TEMP_PREFIX)) : []
}

/** The failure lines on stderr (`bot_token: …` / `app_token: …`); prompts end in `): `, not `:`. */
function failureLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => /^(bot|app)_token: /.test(line))
}

const bot = fakeToken(BOT_TOKEN_PREFIX, 'bot')
const app = fakeToken(APP_TOKEN_PREFIX, 'app')
const BOT_OK = 'bot_token: ok (auth.test)'
const APP_OK = 'app_token: ok (apps.connections.open)'
const mustStart = (key: string, prefix: string) => `${key}: must start with ${prefix} followed by the rest of the token`
const badChars = (key: string) => `${key}: may hold only letters, digits and dashes`
const cannotWrite = (path: string) => `credentials file: cannot write ${path}; nothing written.\n`
const USAGE = 'usage: write-credentials.sh <credentials file path>\n'

let sb: Sandbox

beforeEach(() => {
  sb = makeSandbox()
})

afterEach(() => {
  rmSync(sb.root, { recursive: true, force: true })
})

/** The default target: in directories that don't exist yet, so creating the parent is covered. */
function target(): string {
  return join(sb.root, 'state', 'personas', 'p', 'credentials.json')
}

/** An existing credentials file with other (fake) tokens, mode 0644. Returns its path and bytes. */
function existing(): { path: string; bytes: Buffer } {
  const path = writeCredentialsFile(join(sb.root, 'state'), 'p.json', {
    bot_token: fakeToken(BOT_TOKEN_PREFIX, 'old'),
    app_token: fakeToken(APP_TOKEN_PREFIX, 'old'),
  })
  chmodSync(path, 0o644)
  return { path, bytes: readFileSync(path) }
}

// ---------------------------------------------------------------------------
// As shipped: the wizard's line and the script
// ---------------------------------------------------------------------------

describe('credentials command: as shipped', () => {
  test('the wizard gives one line, the CLI subcommand with the persona, at most 60 characters with a 13-character name, so a copy from an 80-column terminal keeps it whole', () => {
    expect(wizardLine()).toBe(`claude-slack-channel-bots credentials ${PERSONA_PLACEHOLDER}`)
    expect(lineFor('x'.repeat(13)).length).toBeLessThanOrEqual(60)
    expect(wizardLine()).not.toMatch(/\\\s*$/)
  })

  test('the CLI runs the script this file runs, the one the package ships', () => {
    expect(CREDENTIALS_SCRIPT_PATH).toBe(SCRIPT)
    const files: string[] = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).files
    expect(files).toContain('scripts/write-credentials.sh')
  })

  test('the script turns off tracing and automatic export before anything else runs, and calls curl by name through PATH, never by an absolute path', () => {
    const code = readFileSync(SCRIPT, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    expect(code[0]).toBe('set +xa')
    expect(code.join('\n')).not.toMatch(/\/curl\b/)
  })
})

describe('credentials command: usage', () => {
  test.each<[string, string[]]>([
    ['no path', []],
    ['two paths', ['/a/credentials.json', '/b/credentials.json']],
  ])('%s: exit 2 with the usage line, before any prompt, nothing done', (_label, args) => {
    const child = spawnSync(BASH, [SCRIPT, ...args], { cwd: sb.cwd, env: childEnv(sb), input: lines('yes', bot, app), encoding: 'utf-8', timeout: 10_000 })
    expect(child.status).toBe(2)
    expect(child.stderr).toBe(USAGE)
    expect(child.stdout).toBe('')
    expect(recorded(sb)).toEqual({ curl: [], calls: [], premodes: [] })
  })
})

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

/** The checks every successful write passes, for the file at `path`. */
function expectWritten(run: Run, path: string): void {
  expectSafe(run)
  expect(run.status).toBe(0)
  expectSlackCalls(run)
  expect(run.stdout).toBe(`${BOT_OK}\n${APP_OK}\nWrote ${path} with mode 0600. bot_token and app_token both validated.\n`)
  expect(modeOf(path)).toBe(0o600)
  expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ bot_token: bot, app_token: app })
  const check = checkPersonaCredentials({ index: 0, name: 'p', key: 'p', credentials_file: path }, { others: [] })
  assertNoLeak(check)
  expect(check.ok).toBe(true)
  if (check.ok) {
    expect(check.tokens.botToken === bot).toBe(true)
    expect(check.tokens.appToken === app).toBe(true)
  }
  // mkdir the parent, mktemp in it, chmod that temp file, mv it onto the target; no cleanup rm on success.
  const dir = dirname(path)
  expect(run.calls.map((call) => call[0])).toEqual(['mkdir', 'mktemp', 'chmod', 'mv'])
  const [mkdir, mktemp, chmod, mv] = run.calls
  expect(mkdir.at(-1)).toBe(dir)
  expect(dirname(mktemp.at(-1) ?? '')).toBe(dir)
  expect(basename(mktemp.at(-1) ?? '')).toStartWith(TEMP_PREFIX)
  const tmp = chmod.at(-1) ?? ''
  expect(dirname(tmp)).toBe(dir)
  expect(basename(tmp)).toStartWith(TEMP_PREFIX)
  expect(tmp).not.toBe(mktemp.at(-1))
  expect(mv.slice(-2)).toEqual([tmp, path])
  // Mode 0600 from creation, before chmod ran, despite the caller's umask 000.
  expect(run.premodes).toEqual([[tmp, '-rw-------']])
  expect(leftovers(dir)).toEqual([])
}

describe('credentials command: success', () => {
  test('writes a 0600 file with exactly bot_token and app_token after both Slack checks pass', () => {
    const path = target()
    const run = runCommand(sb, path, lines(bot, app))
    expectWritten(run, path)
    expect(readdirSync(dirname(path))).toEqual(['credentials.json'])
  })

  test('a ~/ path is expanded under HOME', () => {
    const path = join(sb.home, '.config', 'cscb', 'p.json')
    const run = runCommand(sb, '~/.config/cscb/p.json', lines(bot, app))
    expectWritten(run, path)
  })

  test('started with set -a and set -x on (bash -a -x): no token in curl environment or a trace', () => {
    const path = target()
    const run = runCommand(sb, path, lines(bot, app), { flags: ['-a', '-x'] })
    expectWritten(run, path)
  })

  test('a path with spaces and a single quote is written as given: it reaches the script as one argument', () => {
    const path = join(sb.root, "it's a dir", 'p credentials.json')
    const run = runCommand(sb, path, lines(bot, app))
    expectWritten(run, path)
  })

  test.skipIf(ZSH === null)('under zsh too (skipped when zsh is not installed)', () => {
    const path = target()
    const run = runCommand(sb, path, lines(bot, app), { shell: ZSH ?? BASH })
    expectWritten(run, path)
  })

  test.skipIf(ZSH === null)('under zsh started with set -a and set -x on (skipped when zsh is not installed)', () => {
    const path = target()
    const run = runCommand(sb, path, lines(bot, app), { shell: ZSH ?? BASH, flags: ['-a', '-x'] })
    expectWritten(run, path)
  })
})

// ---------------------------------------------------------------------------
// On a terminal: a stray Enter re-prompts
// ---------------------------------------------------------------------------

/**
 * One keystroke run a terminal session sends: `input` (sent as is, so a line
 * ends in `\n` and Ctrl-D is `\x04` alone) once `prompt` has been printed
 * `count` times and, when `echoOff`, the terminal's echo is off (so the
 * command's silent `read` is waiting).
 */
interface TerminalStep {
  prompt: string
  count: number
  input: string
  echoOff: boolean
}

/**
 * Feeds a terminal session step by step (see `TerminalStep`; each input is
 * read from its own file). After about 3 s a step sends its input anyway, so
 * a command that leaves echo on shows the token (a leak) rather than hanging.
 * Then it keeps its output open until the terminal is gone, since `script`
 * spins on an early EOF. Builtins except `stty` and `sleep`, by absolute path.
 */
function feeder(steps: [step: TerminalStep, inputFile: string][], typescript: string, ttyFile: string): string {
  const waits = steps
    .map(
      ([{ prompt, count, echoOff }, inputFile]) =>
        `wait_for '${prompt}' ${count} ${echoOff ? 1 : 0}; IFS= read -r -d '' v < '${inputFile}'; printf '%s' "$v"`,
    )
    .join('\n')
  return `wait_for() {
  i=0
  while [ "$i" -lt 150 ]; do
    i=$((i+1))
    if [ -s '${ttyFile}' ] && [ -e '${typescript}' ]; then
      IFS= read -r t < '${ttyFile}'
      s=$(<'${typescript}')
      r=\${s//"$1"/}
      a=$('${hostProgram('stty')}' -F "$t" -a)
      if [ $(( (\${#s} - \${#r}) / \${#1} )) -ge "$2" ] && { [ "$3" = 0 ] || [[ " \${a//$'\\n'/ } " == *" -echo "* ]]; }; then return 0; fi
    fi
    '${hostProgram('sleep')}' 0.02
  done
}
${waits}
i=0
while [ -e "$t" ] && [ "$i" -lt 500 ]; do i=$((i+1)); '${hostProgram('sleep')}' 0.02; done
`
}

interface TerminalRun {
  status: number | null
  signal: NodeJS.Signals | null
  /** Everything the terminal showed. */
  output: string
  curl: CurlCall[]
}

/**
 * Run the script for `credsPath` on a terminal under util-linux `script`, fed
 * by `steps`, and leak-check everything it showed, the typescript, curl's
 * argv and environment and the wrapped programs' argv. `timeout -s KILL`
 * bounds the session at 20 s: `script` outlives a plain SIGTERM.
 */
function runOnTerminal(credsPath: string, steps: TerminalStep[]): TerminalRun {
  const typescript = join(sb.root, 'typescript')
  const ttyFile = join(sb.root, 'tty')
  const runner = writeRunner(sb, { prelude: `'${hostProgram('tty')}' > '${ttyFile}'` })
  const command = [runner, ...scriptCommand(credsPath, {})].map((arg) => `'${arg}'`).join(' ')
  const fed = steps.map((step, i): [TerminalStep, string] => {
    const inputFile = join(sb.root, `in.${i}`)
    writeFileSync(inputFile, step.input)
    return [step, inputFile]
  })
  const feed = join(sb.root, 'feed.sh')
  writeFileSync(feed, feeder(fed, typescript, ttyFile))
  const session = `'${TIMEOUT}' -s KILL 20 '${SCRIPT_UTIL}' -qfec "'${BASH}' ${command}" '${typescript}'`
  const child = spawnSync(BASH, ['-c', `exec ${session} < <('${BASH}' '${feed}' 2>/dev/null)`], {
    cwd: sb.cwd,
    env: childEnv(sb),
    encoding: 'utf-8',
    timeout: 25_000,
  })
  const { curl, calls } = recorded(sb)
  assertNoLeak({
    output: child.stdout,
    stderr: child.stderr,
    typescript: existsSync(typescript) ? readFileSync(typescript, 'utf-8') : '',
    curl: curl.map(({ argv, env }) => ({ argv, env })),
    calls,
  })
  return { status: child.status, signal: child.signal, output: child.stdout, curl }
}

/** How many times `prompt` appears in `output`. */
function timesShown(output: string, prompt: string): number {
  return output.split(prompt).length - 1
}

const BOT_PROMPT = 'bot_token (Bot User OAuth Token'
const APP_PROMPT = 'app_token (app-level token'
const NO_TERMINAL = SCRIPT_UTIL === null || TIMEOUT === null

describe('credentials command: on a terminal (skipped without util-linux script and timeout)', () => {
  test.skipIf(NO_TERMINAL)(
    'a stray empty line before the bot token re-prompts, then succeeds without echo',
    () => {
      const path = target()
      const run = runOnTerminal(path, [
        { prompt: BOT_PROMPT, count: 1, input: '\n', echoOff: true },
        { prompt: BOT_PROMPT, count: 2, input: `${bot}\n`, echoOff: true },
        { prompt: APP_PROMPT, count: 1, input: `${app}\n`, echoOff: true },
      ])
      expect(run.signal).toBeNull()
      expect(run.status).toBe(0)
      expect(timesShown(run.output, BOT_PROMPT)).toBe(2)
      expect(run.output).toContain(`Wrote ${path} with mode 0600.`)
      expect(modeOf(path)).toBe(0o600)
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ bot_token: bot, app_token: app })
    },
    30_000,
  )

  test.skipIf(NO_TERMINAL)(
    'Ctrl-D at the bot prompt ends that answer: one bot prompt, no loop, bot_token empty, exit 1, nothing sent',
    () => {
      const path = target()
      const run = runOnTerminal(path, [
        { prompt: BOT_PROMPT, count: 1, input: '\x04', echoOff: true },
        { prompt: APP_PROMPT, count: 1, input: `${app}\n`, echoOff: true },
      ])
      expect(run.signal).toBeNull()
      expect(run.status).toBe(1)
      expect(timesShown(run.output, BOT_PROMPT)).toBe(1)
      expect(timesShown(run.output, APP_PROMPT)).toBe(1)
      expect(run.output).toContain('bot_token: empty')
      expect(run.output).toContain('Nothing written and nothing sent to Slack.')
      expect(run.curl).toEqual([])
      expect(existsSync(dirname(path))).toBe(false)
    },
    30_000,
  )

  test.skipIf(NO_TERMINAL)(
    'an empty answer at the yes prompt declines: one prompt, "Not replaced", exit 1, no token prompt, file untouched',
    () => {
      const { path, bytes } = existing()
      const yesPrompt = `${path} already exists. Type yes to replace it: `
      const run = runOnTerminal(path, [{ prompt: yesPrompt, count: 1, input: '\n', echoOff: false }])
      expect(run.signal).toBeNull()
      expect(run.status).toBe(1)
      expect(timesShown(run.output, yesPrompt)).toBe(1)
      expect(run.output).toContain(`Not replaced: ${path} is unchanged.`)
      expect(run.output).not.toContain(BOT_PROMPT)
      expect(run.curl).toEqual([])
      expect(readFileSync(path).equals(bytes)).toBe(true)
      expect(modeOf(path)).toBe(0o644)
    },
    30_000,
  )
})

// ---------------------------------------------------------------------------
// Local checks: nothing sent to Slack, nothing written
// ---------------------------------------------------------------------------

/** A local rejection: exit 1, exactly `messages` as failure lines, nothing sent, run or created. */
function expectRejected(run: Run, path: string, messages: string[]): void {
  expectSafe(run)
  expect(run.status).toBe(1)
  expect(failureLines(run.stderr)).toEqual(messages)
  expect(run.stderr).toContain('Nothing written and nothing sent to Slack.\n')
  expect(run.stdout).toBe('')
  expect(run.curl).toEqual([])
  expect(run.calls).toEqual([])
  expect(existsSync(dirname(path))).toBe(false)
}

describe('credentials command: local checks stop before any Slack call', () => {
  const botRows = (): [string, string, string, string][] => [
    ['bot_token empty', '', app, 'bot_token: empty'],
    ['bot_token without a prefix', fakeToken(''), app, mustStart('bot_token', BOT_TOKEN_PREFIX)],
    ['bot_token with the app prefix', fakeToken(APP_TOKEN_PREFIX), app, mustStart('bot_token', BOT_TOKEN_PREFIX)],
    ['bot_token that is only its prefix', BOT_TOKEN_PREFIX, app, mustStart('bot_token', BOT_TOKEN_PREFIX)],
    ['bot_token with a dot', `${fakeToken(BOT_TOKEN_PREFIX)}.x`, app, badChars('bot_token')],
    ['bot_token with a space', `${fakeToken(BOT_TOKEN_PREFIX)} x`, app, badChars('bot_token')],
  ]
  const appRows = (): [string, string, string, string][] => [
    ['app_token empty', bot, '', 'app_token: empty'],
    ['app_token without a prefix', bot, fakeToken(''), mustStart('app_token', APP_TOKEN_PREFIX)],
    ['app_token with the bot prefix', bot, fakeToken(BOT_TOKEN_PREFIX), mustStart('app_token', APP_TOKEN_PREFIX)],
    ['app_token that is only its prefix', bot, APP_TOKEN_PREFIX, mustStart('app_token', APP_TOKEN_PREFIX)],
    ['app_token with a dot', bot, `${fakeToken(APP_TOKEN_PREFIX)}.x`, badChars('app_token')],
    ['app_token with a space', bot, `${fakeToken(APP_TOKEN_PREFIX)} x`, badChars('app_token')],
  ]

  test.each([...botRows(), ...appRows()])('%s: exit 1, the key is named, no curl, no file', (_label, botIn, appIn, message) => {
    const path = target()
    const run = runCommand(sb, path, lines(botIn, appIn))
    expectRejected(run, path, [message])
  })

  test('both keys failing are both named', () => {
    const path = target()
    const run = runCommand(sb, path, lines(fakeToken(APP_TOKEN_PREFIX), ''))
    expectRejected(run, path, [mustStart('bot_token', BOT_TOKEN_PREFIX), 'app_token: empty'])
  })

  test('no input at all: both empty', () => {
    const path = target()
    const run = runCommand(sb, path, '')
    expectRejected(run, path, ['bot_token: empty', 'app_token: empty'])
  })

  test.skipIf(ZSH === null)('under zsh too (skipped when zsh is not installed)', () => {
    const path = target()
    const run = runCommand(sb, path, lines(fakeToken(''), app), { shell: ZSH ?? BASH })
    expectRejected(run, path, [mustStart('bot_token', BOT_TOKEN_PREFIX)])
  })
})

// ---------------------------------------------------------------------------
// The wizard's line, end to end: the real CLI finds the persona and runs the script
// ---------------------------------------------------------------------------

/**
 * Put the command's two programs on the sandbox PATH, each recording its argv
 * in `calls.log` first: `claude-slack-channel-bots`, which runs this
 * checkout's CLI with bun as the package's bin does, and `bash`, which the CLI
 * runs the script with, then the host bash.
 */
function installCli(): void {
  const logged = (name: string, run: string) =>
    `#!${BASH}\n{ printf '%s' '${name}'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> '${sb.log}/calls.log'\nexec ${run} "$@"\n`
  writeFileSync(join(sb.bin, 'claude-slack-channel-bots'), logged('claude-slack-channel-bots', `'${process.execPath}' '${CLI_SOURCE}'`), { mode: 0o755 })
  writeFileSync(join(sb.bin, 'bash'), logged('bash', `'${BASH}'`), { mode: 0o755 })
}

/** A state directory whose config.json declares one persona, `name`, with `credentialsFile`. */
function declare(name: string, credentialsFile: string): string {
  const stateDir = join(sb.root, 'state-dir')
  mkdirSync(stateDir)
  writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona({ name, credentials_file: credentialsFile }, sb.root)] }, sb.root))
  return stateDir
}

/** Run `line` as the operator pastes it at a bash prompt (under `umask 000`), with `input` on stdin. */
function runPasted(line: string, stateDir: string, input: string): Run {
  installCli()
  const pasted = join(sb.root, 'pasted.sh')
  writeFileSync(pasted, `umask 000\n${line}\n`)
  const child = spawnSync(BASH, [pasted], {
    cwd: sb.cwd,
    env: { ...childEnv(sb), SLACK_STATE_DIR: stateDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    input,
    encoding: 'utf-8',
    timeout: 30_000,
  })
  return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, ...recorded(sb) }
}

describe("credentials command: the wizard's line, through the real CLI", () => {
  test.each<[string, string, string]>([
    ['a name that is its own key, copied with trailing spaces', 'persona_p', `${lineFor('persona_p')}   `],
    ['a name with a space, single-quoted as the skill says', 'Dev Bot', lineFor(`'Dev Bot'`)],
  ])(
    '%s: the CLI names the persona and its file, runs the script with bash for that path, and the file is written; no token on any command line',
    (_label, name, line) => {
      const path = join(sb.home, '.config', 'cscb', 'p-credentials.json')
      const stateDir = declare(name, '~/.config/cscb/p-credentials.json')
      const run = runPasted(line, stateDir, lines(bot, app))

      expectSafe(run)
      expect(run.status).toBe(0)
      expectSlackCalls(run)
      expect(run.stdout).toBe(`${BOT_OK}\n${APP_OK}\nWrote ${path} with mode 0600. bot_token and app_token both validated.\n`)
      expect(run.stderr).toStartWith(`Credentials file of persona ${renderPersonaRef(name, personaKey(name))}: ${path}\n`)
      expect(modeOf(path)).toBe(0o600)
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ bot_token: bot, app_token: app })
      // The process list: the command as pasted, then bash running the packaged script for the expanded path.
      expect(run.calls.slice(0, 2)).toEqual([
        ['claude-slack-channel-bots', 'credentials', name],
        ['bash', CREDENTIALS_SCRIPT_PATH, path],
      ])
      expect(run.calls.slice(2).map((call) => call[0])).toEqual(['mkdir', 'mktemp', 'chmod', 'mv'])
      expect(leftovers(dirname(path))).toEqual([])
    },
    30_000,
  )

  test(
    'a persona config.json does not declare: exit 1 naming the declared ones, before any prompt; no script, no Slack call, no file',
    () => {
      const path = join(sb.home, '.config', 'cscb', 'p-credentials.json')
      const stateDir = declare('persona_p', path)
      const run = runPasted(lineFor('persona_q'), stateDir, lines(bot, app))

      expectSafe(run)
      expect(run.status).toBe(1)
      expect(run.stdout).toBe('')
      expect(run.stderr).toBe(
        `credentials: no persona in ${join(stateDir, 'config.json')} has that name or key; declare it there first (declared: ${renderPersonaRef('persona_p')})\n`,
      )
      expect(run.curl).toEqual([])
      expect(run.calls).toEqual([['claude-slack-channel-bots', 'credentials', 'persona_q']])
      expect(existsSync(path)).toBe(false)
    },
    30_000,
  )
})

// ---------------------------------------------------------------------------
// curl missing, or reading the operator's ~/.curlrc
// ---------------------------------------------------------------------------

describe('credentials command: curl', () => {
  test('curl not on PATH: exit 1 with the install message, before any prompt, no input read', () => {
    rmSync(join(sb.bin, 'curl'))
    const { path, bytes } = existing()
    const run = runCommand(sb, path, lines('yes', bot, app), {
      epilogue: `IFS= read -r first; [ "$first" = yes ] && printf 'stdin untouched\\n'`,
    })
    expectSafe(run)
    expect(run.stderr).toBe('curl: not found; install it, then run again\n')
    expect(run.stdout).toBe('stdin untouched\n')
    expect(run.calls).toEqual([])
    expect(readFileSync(path).equals(bytes)).toBe(true)
  })

  test.skipIf(REAL_CURL === null)(
    'a ~/.curlrc asking for a trace is not read (real curl, proxies closed: Slack unreachable)',
    () => {
      writeFileSync(join(sb.bin, 'curl'), `#!${BASH}\nexec '${REAL_CURL}' "$@"\n`, { mode: 0o755 })
      const trace = join(sb.root, 'curl-trace.txt')
      writeFileSync(join(sb.home, '.curlrc'), `trace-ascii = "${trace}"\n`)
      const path = target()
      const run = runCommand(sb, path, lines(bot, app))
      expectSafe(run)
      expect(existsSync(trace)).toBe(false)
      expect(run.status).toBe(1)
      expect(failureLines(run.stderr)).toEqual([
        'bot_token: failed (auth.test: could not reach Slack)',
        'app_token: failed (apps.connections.open: could not reach Slack)',
      ])
      expect(existsSync(dirname(path))).toBe(false)
    },
  )
})

// ---------------------------------------------------------------------------
// Slack validation failures: both checks made, nothing written
// ---------------------------------------------------------------------------

describe('credentials command: Slack validation', () => {
  type SlackAnswer = [body: string, rc: number]
  const OK: SlackAnswer = ['{"ok":true}', 0]
  const rows: [label: string, authTest: SlackAnswer, connectionsOpen: SlackAnswer, stdout: string, failures: string[]][] = [
    [
      'auth.test answers ok:false',
      ['{"ok":false,"error":"invalid_auth"}', 0],
      OK,
      `${APP_OK}\n`,
      ['bot_token: failed (auth.test: invalid_auth)'],
    ],
    [
      'apps.connections.open answers ok:false (spaced JSON)',
      OK,
      ['{ "ok": false, "error": "not_allowed_token_type" }', 0],
      `${BOT_OK}\n`,
      ['app_token: failed (apps.connections.open: not_allowed_token_type)'],
    ],
    [
      'both answer ok:false',
      ['{"ok":false,"error":"token_revoked"}', 0],
      ['{"ok":false,"error":"invalid_auth"}', 0],
      '',
      ['bot_token: failed (auth.test: token_revoked)', 'app_token: failed (apps.connections.open: invalid_auth)'],
    ],
    [
      'ok:false with "ok":true nested further on',
      ['{"ok":false,"error":"invalid_auth","meta":{"ok":true}}', 0],
      OK,
      `${APP_OK}\n`,
      ['bot_token: failed (auth.test: invalid_auth)'],
    ],
    [
      'a body where "ok":true is not the first field',
      OK,
      ['{"warning":"x","ok":true}', 0],
      `${BOT_OK}\n`,
      ['app_token: failed (apps.connections.open: unexpected response)'],
    ],
    [
      'curl cannot reach Slack (exit 6, no body) for both',
      ['', 6],
      ['', 6],
      '',
      ['bot_token: failed (auth.test: could not reach Slack)', 'app_token: failed (apps.connections.open: could not reach Slack)'],
    ],
    [
      'curl exits 0 with an empty body',
      ['', 0],
      OK,
      `${APP_OK}\n`,
      ['bot_token: failed (auth.test: could not reach Slack)'],
    ],
    [
      'curl times out (exit 28) after part of an ok body',
      OK,
      ['{"ok":true', 28],
      `${BOT_OK}\n`,
      ['app_token: failed (apps.connections.open: could not reach Slack)'],
    ],
    [
      'ok:false with no error code',
      OK,
      ['{"ok":false}', 0],
      `${BOT_OK}\n`,
      ['app_token: failed (apps.connections.open: unexpected response)'],
    ],
    [
      "Slack's error field echoes the token it was sent",
      ['{"ok":false,"error":"@TOKEN@"}', 0],
      OK,
      `${APP_OK}\n`,
      ['bot_token: failed (auth.test: unexpected response)'],
    ],
  ]

  test.each(rows)('%s: exit 1, reported per key, no file', (_label, authTest, connectionsOpen, stdout, failures) => {
    scriptSlack(sb, 'auth.test', ...authTest)
    scriptSlack(sb, 'apps.connections.open', ...connectionsOpen)
    const path = target()
    const run = runCommand(sb, path, lines(bot, app))
    expectSafe(run)
    expect(run.status).toBe(1)
    // Both checks are made, each with its own token, even when the first fails.
    expectSlackCalls(run)
    expect(run.stdout).toBe(stdout)
    expect(failureLines(run.stderr)).toEqual(failures)
    expect(run.stderr).toContain('Nothing written.\n')
    expect(run.calls).toEqual([])
    expect(existsSync(dirname(path))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Existing target file
// ---------------------------------------------------------------------------

describe('credentials command: existing file', () => {
  test.each([
    ['answered no', lines('no', bot, app)],
    ['answered YES (not exactly yes)', lines('YES', bot, app)],
    ['no answer (EOF)', ''],
  ])('%s: exit 1, file untouched, no token read', (_label, input) => {
    const { path, bytes } = existing()
    const run = runCommand(sb, path, input)
    expectSafe(run)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`${path} already exists. Type yes to replace it: `)
    expect(run.stderr).toContain(`Not replaced: ${path} is unchanged.\n`)
    expect(run.stderr).not.toContain('bot_token (')
    expect(run.stdout).toBe('')
    expect(run.curl).toEqual([])
    expect(run.calls).toEqual([])
    expect(readFileSync(path).equals(bytes)).toBe(true)
    expect(modeOf(path)).toBe(0o644)
  })

  test('answered yes: replaced with the new tokens, mode 0600', () => {
    const { path } = existing()
    const run = runCommand(sb, path, lines('yes', bot, app))
    expect(run.stderr).toContain(`${path} already exists. Type yes to replace it: `)
    expectWritten(run, path)
    expect(readdirSync(dirname(path))).toEqual(['p.json'])
  })

  test('answered yes but Slack refuses a token: file untouched', () => {
    scriptSlack(sb, 'auth.test', '{"ok":false,"error":"invalid_auth"}')
    const { path, bytes } = existing()
    const run = runCommand(sb, path, lines('yes', bot, app))
    expectSafe(run)
    expect(run.status).toBe(1)
    expect(run.curl).toHaveLength(2)
    expect(failureLines(run.stderr)).toEqual(['bot_token: failed (auth.test: invalid_auth)'])
    expect(run.calls).toEqual([])
    expect(readFileSync(path).equals(bytes)).toBe(true)
    expect(modeOf(path)).toBe(0o644)
  })
})

// ---------------------------------------------------------------------------
// Write failures and a target that changes mid-run: nothing written, no temp left
// ---------------------------------------------------------------------------

for (const [shellName, shell] of SHELLS) {
  describe.skipIf(shell === null)(`credentials command: writing ${underShell(shellName)}`, () => {
    const run = (path: string, input: string) => runCommand(sb, path, input, { shell: shell ?? BASH })

    test.each([
      ['mkdir', (path: string) => `credentials file: cannot create the directory ${dirname(path)}\n`],
      ['mktemp', cannotWrite],
      ['chmod', cannotWrite],
      ['mv', cannotWrite],
    ] as [Wrapped, (path: string) => string][])(
      '%s fails: exit 1, the target unchanged, no temp file left',
      (name, message) => {
        const { path, bytes } = existing()
        hook(sb, name, 'exit 1')
        const result = run(path, lines('yes', bot, app))
        expectSafe(result)
        expect(result.status).toBe(1)
        expect(result.stdout).toBe(`${BOT_OK}\n${APP_OK}\n`)
        expect(result.stderr).toEndWith(message(path))
        expect(readFileSync(path).equals(bytes)).toBe(true)
        expect(modeOf(path)).toBe(0o644)
        expect(leftovers(dirname(path))).toEqual([])
      },
    )

    test('the written file is empty after the rename: exit 1, cannot write, no success line', () => {
      const path = target()
      hook(sb, 'mv', `for a in "$@"; do case "$a" in */${TEMP_PREFIX}*) : > "$a" ;; esac; done`)
      const result = run(path, lines(bot, app))
      expectSafe(result)
      expect(result.status).toBe(1)
      expect(result.stdout).toBe(`${BOT_OK}\n${APP_OK}\n`)
      expect(result.stderr).toEndWith(cannotWrite(path))
      expect(leftovers(dirname(path))).toEqual([])
    })

    const mkdir = hostProgram('mkdir')
    const rm = hostProgram('rm')
    const ln = hostProgram('ln')
    const changed = (path: string) => `credentials file: ${path} changed; nothing written.\n`
    // Each row: whether the target exists at the start, and what the chmod hook does to it (`$T` is the target).
    test.each([
      ['a directory appears where there was nothing', false, `'${mkdir}' "$T"`],
      ['a file appears where there was nothing', false, `: > "$T"`],
      ['the existing file vanishes', true, `'${rm}' -f "$T"`],
      ['the existing file becomes a symlink', true, `'${rm}' -f "$T"; '${ln}' -s "$T.other" "$T"`],
      ['the existing file becomes a directory', true, `'${rm}' -f "$T"; '${mkdir}' "$T"`],
    ])('%s before the rename: exit 1, "changed; nothing written", no rename, no temp left', (_label, exists, change) => {
      const path = exists ? existing().path : target()
      hook(sb, 'chmod', `T='${path}'; ${change}`)
      const result = run(path, exists ? lines('yes', bot, app) : lines(bot, app))
      expectSafe(result)
      expect(result.status).toBe(1)
      expect(result.stderr).toEndWith(changed(path))
      expect(result.calls.map((call) => call[0])).not.toContain('mv')
      expect(leftovers(dirname(path))).toEqual([])
      if (existsSync(path) && lstatSync(path).isFile()) expect(readFileSync(path, 'utf-8')).not.toContain(bot)
    })

    // The mv hook makes the target a directory just before the real mv runs, so the rename lands inside it.
    test.each([
      ['where there was nothing', false, `'${mkdir}' "$T"`],
      ['in place of the existing file', true, `'${rm}' -f "$T"; '${mkdir}' "$T"`],
    ])(
      'a directory appears %s as mv runs: exit 1, "changed; nothing written", no temp file left inside it',
      (_label, exists, change) => {
        const path = exists ? existing().path : target()
        hook(sb, 'mv', `T='${path}'; ${change}`)
        const result = run(path, exists ? lines('yes', bot, app) : lines(bot, app))
        expectSafe(result)
        expect(result.status).toBe(1)
        expect(result.stdout).toBe(`${BOT_OK}\n${APP_OK}\n`)
        expect(result.stderr).toEndWith(changed(path))
        expect(result.calls.map((call) => call[0])).toContain('mv')
        expect(lstatSync(path).isDirectory()).toBe(true)
        expect(readdirSync(path)).toEqual([])
        expect(leftovers(dirname(path))).toEqual([])
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Bad path: exit 2 before reading any input
// ---------------------------------------------------------------------------

for (const [shellName, shell] of SHELLS) {
  describe.skipIf(shell === null)(`credentials command: bad path ${underShell(shellName)}`, () => {
    const NOT_A_FILE = 'the path must be absolute or start with ~/ and name a file'

    const IS_A_DIRECTORY = () => `${sb.home} is a directory`

    // Paths and messages are built per case: the sandbox exists only inside a test.
    test.each([
      ['a relative path', () => 'credentials.json', () => NOT_A_FILE],
      ["another user's ~", () => '~other/credentials.json', () => NOT_A_FILE],
      ['a trailing slash', () => `${join(sb.root, 'state', 'p')}/`, () => NOT_A_FILE],
      ['an existing directory', () => sb.home, IS_A_DIRECTORY],
      ['~ alone (HOME, a directory)', () => '~', IS_A_DIRECTORY],
    ])('%s: exit 2, no prompt, nothing done', (_label, credsPath, message) => {
      const run = runCommand(sb, credsPath(), lines('yes', bot, app), { shell: shell ?? BASH })
      expectSafe(run)
      expect(run.status).toBe(2)
      expect(run.stderr.split('\n').filter((line) => line !== '')).toEqual([expect.stringContaining(message())])
      expect(run.stderr).toStartWith('credentials file: ')
      expect(run.stdout).toBe('')
      expect(run.curl).toEqual([])
      expect(run.calls).toEqual([])
      expect(readdirSync(sb.home)).toEqual([])
      expect(readdirSync(sb.cwd)).toEqual([])
    })
  })
}
