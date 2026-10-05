/**
 * switch-over.ts — what test-13-fmk-switch-over.sh reads from a package
 * directory, so the script retypes no runbook title, settings key, default,
 * minimum or margin (b.jg5 SRJ-1108, SRJ-1402; ruling Q13): the steps of the
 * README's switch-over runbook, and agent-director's settings in effect as
 * that package reads them.
 *
 * REFUSAL
 * -------
 * Runs only in a cscb-ci image. Its first statement checks for the image
 * marker `/etc/cscb-ci-image`; without it, it prints
 * `FAIL: switch-over: refused: /etc/cscb-ci-image is absent …` on stderr and
 * exits 2, before it reads an argument or loads a module. Only `node:`
 * built-ins are imported statically: the package, the step reader
 * (`tests/test-helpers/runbooks.ts`) and the Markdown reader it uses are
 * imported dynamically, after the check. No host `bun test` file runs or
 * imports this file.
 *
 * USAGE
 * -----
 *   bun --no-install switch-over.ts steps <pkg-dir>
 *   bun --no-install switch-over.ts settings <pkg-dir>
 *
 * <pkg-dir> is a package directory of claude-slack-channel-bots (the build
 * staged at the runbook's step 1, or the one installed at its step 7). It
 * writes nothing. Output is one named value per line, `<name> <value>`, the
 * name one word and the value the rest of the line.
 *
 * `steps` reads `<pkg-dir>/README.md`, finds the section whose heading title
 * is that package's own `PHASE1_RUNBOOK_SECTION_TITLE`
 * (`src/ad-version-gate.ts`), and reads its steps through the one step
 * reader, `runbookSteps` (`tests/test-helpers/runbooks.ts`):
 *
 *   section <the section's title>
 *   step <n> <step n's heading title, as written>      (one line per step, in order)
 *
 * `settings` reads agent-director's settings for the current HOME through
 * that package's own reader (`createAdSettingsReader`, `src/ad-settings.ts`)
 * and prints, in this order:
 *
 *   file <the settings file's path>
 *   file_exists <true|false>
 *   <table>.<key> <value>                (the nine [tmux] values in effect, in the package's key order)
 *   <table>.<key> <seconds>              ([pause] timeout_seconds when used)
 *   <table>.<key> not-used <found>       ([pause] timeout_seconds when not used)
 *   minimum.<key> <value>                (one line per window that has a minimum)
 *   call_timeout_need_ms <ms>            (the need, margin included: adCallTimeoutNeed)
 *   call_timeout_need_set_by <verb>      (or `unused-pause-value`)
 *   grace_ms <ms>                        (G: adGraceMs)
 *   launch_bound_ms <ms>                 (B, CSCB's launch bound: adLaunchBoundMs)
 *
 * Each minimum is the smallest value of its key that the package's own rule
 * accepts with every other key at its value in effect: the reader is run
 * over the values in effect, with that one key changed, through its
 * file-system seam (no file is written). So a minimum that the package
 * derives from other keys (`pending_grace_seconds`') comes out as the
 * package derives it.
 *
 * Exit status: 0 on success; 1, with one `FAIL: switch-over: <why>` line on
 * stderr, when the section or a step is missing or out of order, when the
 * package lacks an export, or when the settings read is refused; 2 when
 * refused outside the image; 64 for a usage error.
 *
 * SPDX-License-Identifier: MIT
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: switch-over: refused: /etc/cscb-ci-image is absent; this fixture runs only in a cscb-ci image (/ci)')
  process.exit(2)
}

/** Exit status for a usage error (EX_USAGE). */
const USAGE_EXIT = 64

/** Exit status of a FAIL line. */
const FAIL_EXIT = 1

/** The step reader and the Markdown reader it uses, beside this file's tree. */
const RUNBOOKS_MODULE = join(import.meta.dir, '..', '..', 'test-helpers', 'runbooks.ts')
const MARKDOWN_MODULE = join(import.meta.dir, '..', '..', 'test-helpers', 'markdown.ts')

/** Prints `FAIL: switch-over: <why>` on one line and exits 1. */
function fail(why: string): never {
  console.error(`FAIL: switch-over: ${why.replace(/\s*\n\s*/g, ' ')}`)
  process.exit(FAIL_EXIT)
}

/** Prints one named value. */
function put(name: string, value: string | number | bigint | boolean): void {
  console.log(`${name} ${String(value)}`)
}

/** Import a module of the package's `src/`. */
async function packageModule(pkgDir: string, relPath: string): Promise<Record<string, unknown>> {
  try {
    return (await import(join(pkgDir, 'src', relPath))) as Record<string, unknown>
  } catch (err) {
    fail(`cannot import ${pkgDir}/src/${relPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Export `name` of a module, which must be defined. */
function exported<T>(mod: Record<string, unknown>, where: string, name: string): T {
  const value = mod[name]
  if (value === undefined) fail(`${where} exports no ${name}`)
  return value as T
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

/** One heading as the Markdown reader gives it. */
interface Heading {
  readonly line: number
  readonly level: number
  readonly title: string
  readonly text: string
}

/** One step as the step reader gives it. */
interface RunbookStep {
  readonly number: number
  readonly title: string
}

async function steps(pkgDir: string): Promise<number> {
  const gate = await packageModule(pkgDir, 'ad-version-gate.ts')
  const title = exported<string>(gate, `${pkgDir}/src/ad-version-gate.ts`, 'PHASE1_RUNBOOK_SECTION_TITLE')
  const markdown = (await import(MARKDOWN_MODULE)) as Record<string, unknown>
  const runbooks = (await import(RUNBOOKS_MODULE)) as Record<string, unknown>
  const headings = exported<(text: string) => Heading[]>(markdown, MARKDOWN_MODULE, 'headings')
  const findSection = exported<(text: string, match: string) => string | undefined>(markdown, MARKDOWN_MODULE, 'findSection')
  const runbookSteps = exported<(section: string, options: { name?: string }) => RunbookStep[]>(runbooks, RUNBOOKS_MODULE, 'runbookSteps')

  const readmePath = join(pkgDir, 'README.md')
  let readme: string
  try {
    readme = readFileSync(readmePath, 'utf8')
  } catch (err) {
    fail(`cannot read ${readmePath}: ${err instanceof Error ? err.message : String(err)}`)
  }
  // The section is found by its title, at whatever level it is written.
  const matches = headings(readme).filter((h) => h.title === title)
  if (matches.length !== 1) fail(`${readmePath} has ${matches.length} headings titled "${title}", not one`)
  const section = findSection(readme, matches[0].text)
  if (section === undefined) fail(`${readmePath} has no section "${matches[0].text}"`)
  let found: RunbookStep[]
  try {
    found = runbookSteps(section, { name: `${readmePath} "${matches[0].text}"` })
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
  put('section', title)
  for (const step of found) console.log(`step ${step.number} ${step.title}`)
  return 0
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/** `[pause] timeout_seconds` as the package's reader gives it. */
type PauseTimeout = { readonly kind: 'used'; readonly seconds: bigint } | { readonly kind: 'not-used'; readonly found: string }

/** The settings in effect as the package's reader gives them. */
interface SettingsInEffect {
  readonly tmux: Readonly<Record<string, bigint>>
  readonly pauseTimeout: PauseTimeout
}

/** One read's outcome as the package's reader gives it. */
type ReadOutcome = { readonly kind: 'accepted'; readonly values: SettingsInEffect } | { readonly kind: 'refused'; readonly reason: string }

/** The reader's file-system seam (`PersonaConfigFs` in the package's `src/config.ts`). */
interface ReaderFs {
  openFile(path: string): number
  fstatFile(fd: number): { isFile(): boolean; isDirectory(): boolean; size?: number }
  readFileFd(fd: number, maxBytes?: number): Buffer
  closeFile(fd: number): void
}

type CreateReader = (deps: { home: () => string; fs?: Partial<ReaderFs>; log: (line: string) => void }) => { read(): ReadOutcome }

/** A file-system seam that answers `text` for any path, as one regular file. */
function virtualFile(text: string): ReaderFs {
  const bytes = Buffer.from(text, 'utf8')
  return {
    openFile: () => 0,
    fstatFile: () => ({ isFile: () => true, isDirectory: () => false, size: bytes.length }),
    readFileFd: (_fd, maxBytes) => (maxBytes === undefined || maxBytes >= bytes.length ? bytes : bytes.subarray(0, maxBytes)),
    closeFile: () => {},
  }
}

async function settings(pkgDir: string): Promise<number> {
  const where = `${pkgDir}/src/ad-settings.ts`
  const mod = await packageModule(pkgDir, 'ad-settings.ts')
  const createReader = exported<CreateReader>(mod, where, 'createAdSettingsReader')
  const relativePath = exported<string>(mod, where, 'AD_SETTINGS_RELATIVE_PATH')
  const tmuxTable = exported<string>(mod, where, 'AD_TMUX_TABLE')
  const pauseTable = exported<string>(mod, where, 'AD_PAUSE_TABLE')
  const pauseKey = exported<string>(mod, where, 'AD_PAUSE_TIMEOUT_KEY')
  const tmuxKeys = exported<readonly string[]>(mod, where, 'AD_TMUX_KEYS')
  const minimums = exported<Readonly<Record<string, unknown>>>(mod, where, 'AD_SETTING_MINIMUMS')
  const callTimeoutNeed = exported<(values: SettingsInEffect) => { needMs: bigint; setBy: { kind: string; verb?: string } }>(
    mod,
    where,
    'adCallTimeoutNeed',
  )
  const graceMs = exported<(values: SettingsInEffect) => number>(mod, where, 'adGraceMs')
  const launchBoundMs = exported<(values: SettingsInEffect) => number>(mod, where, 'adLaunchBoundMs')

  const home = process.env.HOME
  if (home === undefined || home === '') fail('HOME is not set')
  const path = join(home, relativePath)
  const quiet = () => {}
  const outcome = createReader({ home: () => home, log: quiet }).read()
  if (outcome.kind !== 'accepted') fail(`the package's reader refused the read of ${path}: ${outcome.reason}`)
  const values = outcome.values

  // A minimum: the smallest value of `key` the package's rule accepts with
  // every other key at its value in effect, found over [1, value in effect]
  // (the value in effect is accepted; the rule reads 0 as the default).
  const accepts = (key: string, value: bigint): boolean => {
    const lines = [`[${tmuxTable}]`, ...tmuxKeys.map((k) => `${k} = ${k === key ? value : values.tmux[k]}`)]
    const probe = createReader({ home: () => home, fs: virtualFile(`${lines.join('\n')}\n`), log: quiet }).read()
    return probe.kind === 'accepted'
  }
  const minimumOf = (key: string): bigint => {
    let low = 1n
    let high = values.tmux[key]
    if (!accepts(key, high)) fail(`the package's rule refuses ${key} = ${high}, its value in effect`)
    while (low < high) {
      const mid = (low + high) / 2n
      if (accepts(key, mid)) high = mid
      else low = mid + 1n
    }
    return high
  }

  put('file', path)
  put('file_exists', existsSync(path))
  for (const key of tmuxKeys) {
    const value = values.tmux[key]
    if (typeof value !== 'bigint') fail(`the package's values in effect hold no ${tmuxTable}.${key}`)
    put(`${tmuxTable}.${key}`, value)
  }
  const pause = values.pauseTimeout
  put(`${pauseTable}.${pauseKey}`, pause.kind === 'used' ? pause.seconds : `not-used ${pause.found}`)
  for (const key of Object.keys(minimums)) {
    if (!tmuxKeys.includes(key)) fail(`${where}'s AD_SETTING_MINIMUMS names ${key}, which is not one of its ${tmuxTable} keys`)
    put(`minimum.${key}`, minimumOf(key))
  }
  const need = callTimeoutNeed(values)
  put('call_timeout_need_ms', need.needMs)
  put('call_timeout_need_set_by', need.setBy.kind === 'verb' && need.setBy.verb !== undefined ? need.setBy.verb : need.setBy.kind)
  put('grace_ms', graceMs(values))
  put('launch_bound_ms', launchBoundMs(values))
  return 0
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const SUBCOMMANDS: Readonly<Record<string, (pkgDir: string) => Promise<number>>> = { steps, settings }

function usageFail(detail: string): number {
  console.error(`FAIL: switch-over: ${detail}; usage: bun switch-over.ts <${Object.keys(SUBCOMMANDS).join('|')}> <pkg-dir>`)
  return USAGE_EXIT
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, pkgDir, ...rest] = argv
  if (name === undefined || !Object.hasOwn(SUBCOMMANDS, name)) return usageFail(`unknown subcommand '${name ?? ''}'`)
  if (pkgDir === undefined || pkgDir === '' || rest.length > 0) return usageFail(`${name} takes one package directory`)
  if (!existsSync(join(pkgDir, 'package.json'))) fail(`${pkgDir} holds no package.json`)
  return await SUBCOMMANDS[name](pkgDir)
}

process.exit(await main(process.argv.slice(2)))
