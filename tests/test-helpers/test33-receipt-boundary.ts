/** Unit-only driver of test33's wait-then-assert boundaries (b.p9r). It runs
 * one verbatim slice of test-33-fmk-real-keys.sh with the actual real-scenario
 * and polling definitions; it never sources or starts an integration scenario.
 * Every `bun <fixture>` call evaluates that fixture's actual source, CLI entry
 * included, in this process. Only process/console, the CI-image guard and the
 * package location are replaced, so the source receipt matcher reads scratch
 * evidence. AD answers waiting, and only a synthetic watchdog clock advances:
 * no native agent, pane, packed package or wall-clock sleep is reached. */
import * as fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { assertNoLeak } from './credentials.ts'
import { hostSafeChildEnv } from './host-safe-env.ts'

const INTEGRATION = join(import.meta.dir, '../integration'), FIXTURES = join(INTEGRATION, 'fixtures')
const IMAGE = '/etc/cscb-ci-image', REPO = join(import.meta.dir, '../..')
const source = (name: string) => fs.readFileSync(join(INTEGRATION, name), 'utf8')
const guardedFs = { ...fs, existsSync: (path: fs.PathLike) => path === IMAGE || fs.existsSync(path) }

/** Each test33 leg that waits for receipts, then runs its case audit. */
export const TEST33_SLICES = {
  'reset-spacing': { after: 'real_wait_relaunch "${REAL_KEY}"\n', before: 'UNKNOWN_COUNT=4\n', preset: [] },
  'key-proof': { after: `real_dm "\${REAL_LABEL}" 'one swallowed text' "\${KEY_FAULT_TS}"\n`, before: 'real_wait_idle', preset: [] },
  // The loop's first unknown outcome, renumbered to a two-input fixture.
  'unknown-proof': { after: 'real_dm "${REAL_LABEL}" "unknown outcome ${outcome}" "${KEY_FAULT_TS}"\n', before: 'done\n',
    preset: ['UNKNOWN_COUNT=1', 'outcome=unknown-typed'] },
} as const
export type Test33Leg = keyof typeof TEST33_SLICES

function between(text: string, after: string, before: string) {
  const from = text.indexOf(after), to = text.indexOf(before, from + after.length)
  if (from < 0 || to < 0) throw new Error(`Missing test33 boundary after ${after.trim()}`)
  return text.slice(from + after.length, to)
}
function shellDefinitions(text: string) {
  return [...text.matchAll(/^\w+\(\) \{(?:[^\n]*\}\n|[\s\S]*?^\}\n)/gm)].map(m => m[0]).join('\n')
}

class ProcessExit extends Error {}
interface FixtureRun { out: string[]; err: string[]; exit?: number; modules: Map<string, Promise<Record<string, unknown>>> }
const compiled = new Map<string, string>()

/** Rewrite one fixture module into an async function of its imports, so its
 * own top-level code and `import.meta.main` entry run unchanged. */
function compile(path: string): string {
  const cached = compiled.get(path)
  if (cached) return cached
  const exports: string[] = []
  const text = fs.readFileSync(path, 'utf8')
    .replace(/^import (type )?(\{[^}]*\}|\* as \w+) from '([^']+)'\n/gm, (_, type: string | undefined, names: string, spec: string) => {
      if (type) return '\n'
      const binding = names.startsWith('*') ? names.slice(5)
        : names.replace(/\btype\s+\w+\s*,?/g, '').replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')
      return `const ${binding} = await __import(${JSON.stringify(spec)})\n`
    })
    .replace(/^export (?=(?:async )?(?:function|const|let|class|interface|type) )/gm, '')
    .replace(/\bimport\.meta\b/g, '__meta').replace(/\bimport\(/g, '__import(')
  for (const m of fs.readFileSync(path, 'utf8').matchAll(/^export (?:async )?(?:function\*?|const|let|class) (\w+)/gm)) exports.push(m[1]!)
  // A bare function expression would be dropped as an unused statement.
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `const __module = async function (__import, __meta, process, console) {\n${text}\nreturn { ${exports.join(', ')} }\n}`) + '\nreturn __module'
  compiled.set(path, js)
  return js
}

/** Fixtures carrying the CI-image guard share this run's process and console;
 * any other module (repo source, diagnostics) is the ordinary Bun module. */
function evaluate(path: string, run: FixtureRun, argv: string[] = []): Promise<Record<string, unknown>> {
  const main = argv.length > 0, found = run.modules.get(path)
  if (found && !main) return found
  const load = async (spec: string) => {
    if (spec === 'node:fs') return guardedFs
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      // Only Node built-ins (the fixtures need node:path): a package would
      // resolve from this checkout's node_modules, not the scenario's package.
      if (!spec.startsWith('node:')) throw new Error(`Unexpected bare import in test33 fixture ${path}: ${spec}`)
      return import(spec)
    }
    const target = resolve(dirname(path), spec)
    return fs.readFileSync(target, 'utf8').includes(IMAGE) ? evaluate(target, run) : import(target)
  }
  const fakeProcess = {
    argv: ['bun', path, ...argv], env: { CSCB_PKG_DIR: REPO }, execPath: process.execPath,
    exit(code = 0) { run.exit ??= code; throw new ProcessExit(`exit ${code}`) },
  }
  const record = (into: string[]) => (...values: unknown[]) => { if (run.exit === undefined) into.push(values.map(String).join(' ')) }
  const meta = { main, path, dir: dirname(path), url: `file://${path}` }
  const result = (new Function(compile(path))() as Function)(load, meta, fakeProcess, { log: record(run.out), error: record(run.err) })
  if (!main) run.modules.set(path, result)
  return result
}

/** Run `bun <fixture> <args>` as the fixture's own CLI would, in process. */
async function runFixture(file: string, args: string[]) {
  const path = resolve(INTEGRATION, file)
  if (dirname(path) !== FIXTURES) throw new Error(`Unexpected bun target in test33 slice: ${file}`)
  const run: FixtureRun = { out: [], err: [], modules: new Map() }
  try { await evaluate(path, run, args) } catch (error) { if (!(error instanceof ProcessExit)) throw error }
  return { code: run.exit ?? 0, out: run.out, err: run.err }
}

export interface Test33Result {
  code: number | null; signal: string | null; stderr: string; polls: number
  ready: number; calls: string[]; errors: string[]; outputs: string[]
}

/** `afterReady` runs once, after the first successful full receipt audit has
 * read its evidence and before the shell receives that success. There is no
 * scheduler timing window. `poll` runs each time the shell would sleep. */
export async function runTest33Slice(leg: Test33Leg, stateDir: string, hooks: {
  afterReady?(): Promise<void>
  poll?(polls: number): Promise<void>
} = {}): Promise<Test33Result> {
  const { after, before, preset } = TEST33_SLICES[leg]
  const script = source('test-33-fmk-real-keys.sh'), scenario = source('lib/scenario.sh')
  const slice = between(script, after, before)
  if (!slice.includes('real_wait_delivery') || !slice.includes(`case_assert ${leg}`)) throw new Error(`test33 ${leg} slice lacks its wait/assertion`)
  const functions = ['_scenario_poll_until', '_scenario_check_timeout', 'wait_until'].map(name => {
    const found = scenario.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
    if (!found) throw new Error(`Missing scenario polling function: ${name}`)
    return found[0]
  }).join('\n')
  const program = [
    'set -euo pipefail', 'exec 3>&1', 'exec 1>/dev/null',
    // Definitions only: neither scenario source-time setup nor native setup runs.
    shellDefinitions(source('lib/real-scenario.sh')), functions, shellDefinitions(script),
    'SCENARIO_ROOT="$HOME"', 'SLACK_STATE_DIR="$HOME"', 'SCENARIO_FIXTURES=fixtures', 'REAL_KEY=alpha', 'REAL_LABEL=alpha',
    'REAL_RECEIPTS="${SCENARIO_FIXTURES}/transcript-receipts.ts"', 'CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"',
    'SCENARIO_AD_SHIM_LOG="$HOME/shim.log"',
    'REAL_DELIVERY_WAIT_S=3', 'REAL_DELIVERY_MAX_WAIT_S=5', 'SCENARIO_POLL_S=1', ...preset,
    'bridge() { local answer; printf "%s\\n" "$1" >&3; IFS= read -r answer; printf "%s\\n" "$answer"; }',
    `_bridged() { local IFS=$'\\t' reply; reply="$(bridge "$*")"; printf '%s\\n' "\${reply#*$'\\t'}"; return "\${reply%%$'\\t'*}"; }`,
    'bun() { _bridged bun "$@"; }', 'real_ad() { _bridged ad "$@"; }', 'real_instance() { echo cscb_alpha; }',
    'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    '_scenario_now_ms() { bridge now; }', 'sleep() { bridge poll >/dev/null; }',
    slice,
  ].join('\n')
  const child = spawn('bash', ['-c', program], {
    env: hostSafeChildEnv(stateDir, { tools: ['bash', 'jq'] }),
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 4000,
  })
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let stderr = '', polls = 0, ready = 0
  const calls: string[] = [], errors: string[] = [], outputs: string[] = []
  child.stderr.on('data', data => { stderr += data })
  try {
    for await (const request of createInterface({ input: child.stdout })) {
      const [kind, ...words] = request.split('\t')
      let answer: string
      if (kind === 'now') answer = String(polls * 1000)
      else if (kind === 'poll') { polls++; await hooks.poll?.(polls); answer = 'ok' }
      else if (kind === 'ad') answer = words[0] === 'status' ? `0\t${JSON.stringify({ instance_id: 'cscb_alpha', state: 'waiting' })}` : '1\t'
      else if (kind === 'bun') {
        const [file, ...args] = words
        const [command, state, key] = args
        // A delivery watchdog's AD diagnostic reads only its scratch status file.
        const own = file === 'fixtures/real-observations.ts' ? args.length === 1 && command === join(stateDir, 'real-delivery-status.json')
          : state === stateDir && key === 'alpha'
        if (!own) throw new Error('test33 slice passed another state directory or persona')
        const result = await runFixture(file!, args)
        calls.push(`${command}:${result.code}`)
        errors.push(...result.err)
        outputs.push(...result.out)
        if (command === 'ready' && result.code === 0 && ++ready === 1) await hooks.afterReady?.()
        answer = `${result.code}\t${result.out.join(' ')}`
      } else throw new Error(`Unexpected test33 transport request: ${kind}`)
      child.stdin.write(answer.replaceAll('\n', ' ') + '\n')
    }
    const result = { ...await closed, stderr, polls, ready, calls, errors, outputs }
    assertNoLeak(result)
    if (result.signal) throw new Error(`test33 ${leg} slice exceeded its process timeout: ${JSON.stringify(result)}`)
    return result
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
}
