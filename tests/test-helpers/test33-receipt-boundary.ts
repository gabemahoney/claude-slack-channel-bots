/** Unit-only driver of real scenarios' wait-then-assert boundaries (b.p9r):
 * test33's legs, test39's no-retype tail, test104's delivery tail and the AI
 * AC106 duplicate tail. It runs one verbatim slice of a real script with the
 * actual real-scenario and polling definitions; it never sources or starts an
 * integration scenario. Every `bun <fixture>` call evaluates that fixture's
 * actual source, CLI entry included, in this process. Only process/console, the
 * CI-image guard and the package location are replaced, so the source receipt
 * matcher reads scratch evidence. AD answers waiting, and only a synthetic
 * watchdog clock advances: no native agent, pane, packed package or wall-clock
 * sleep is reached. */
import * as fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { assertNoLeak } from './credentials.ts'
import { hostSafeChildEnv } from './host-safe-env.ts'

const TESTS = join(import.meta.dir, '..'), INTEGRATION = join(TESTS, 'integration'), FIXTURES = join(INTEGRATION, 'fixtures')
const IMAGE = '/etc/cscb-ci-image', REPO = join(TESTS, '..')
const source = (name: string) => fs.readFileSync(join(TESTS, name), 'utf8')
const guardedFs = { ...fs, existsSync: (path: fs.PathLike) => path === IMAGE || fs.existsSync(path) }

/** One verbatim slice of a real script under tests/. It starts after the last
 * of `after` (each found after the previous one) and ends before `before`. */
export interface RealSlice {
  script: string
  after: string | readonly string[]
  before: string
  /** Lines the slice must hold, so a moved boundary fails loudly instead of
   * silently running other lines. */
  requires: readonly string[]
  /** Shell lines run after the real definitions, before the slice: variables,
   * and stubs for script helpers that are not under test. */
  preset: readonly string[]
  /** Host tools the slice runs besides bash. */
  tools: readonly string[]
}

/** Each test33 leg that waits for receipts, then runs its case audit. */
export const TEST33_SLICES = {
  'reset-spacing': { after: 'real_wait_relaunch "${REAL_KEY}"\n', before: 'UNKNOWN_COUNT=4\n', preset: [] },
  'key-proof': { after: `real_dm "\${REAL_LABEL}" 'one swallowed text' "\${KEY_FAULT_TS}"\n`, before: 'real_wait_idle', preset: [] },
  // The loop's first unknown outcome, renumbered to a two-input fixture.
  'unknown-proof': { after: 'real_dm "${REAL_LABEL}" "unknown outcome ${outcome}" "${KEY_FAULT_TS}"\n', before: 'done\n',
    preset: ['UNKNOWN_COUNT=1', 'outcome=unknown-typed'] },
} as const
export type Test33Leg = keyof typeof TEST33_SLICES

/** Other real scripts whose last delivery wait is followed by a receipt audit
 * that re-reads newer evidence. Each slice keeps its own `real_dm` inputs. */
export const SITE_SLICES = {
  // The fidelity loop, renumbered to two plain inputs, and its tail. The
  // loop's own wait also holds the required wait line, so the tail's wait is
  // pinned by the static guard in transcript-receipts.test.ts, not here.
  test39: { script: 'integration/test-39-fmk-real-fidelity.sh', after: 'INPUT\n)\n', before: 'case_assert fidelity-shapes',
    requires: ['real_dm "${REAL_LABEL}" "${BODY}"', 'real_wait_delivery "${REAL_KEY}" "${COUNT}" no-retype'],
    preset: [`INPUTS=('"fidelity one"' '"fidelity two"')`], tools: ['jq', 'python3'] },
  test104: { script: 'real-agent/test-104-fmk-real-idle-compact.sh', after: 'real_fault send-keys no_enter unknown-untyped 1\n', before: 'real_finish',
    requires: ['real_dm "${REAL_LABEL}"', 'real_wait_delivery "${REAL_KEY}" 3'], preset: [], tools: [] },
  // AC106 after its duplicate copy exists: the counting query and its checks.
  ai106: { script: 'real-agent/ai-scenario.sh',
    after: ["'second exact DM copy never reached transcript' case_assert at-least-one-duplicate\n", 'real_wait_idle "${REAL_KEY}"\n'],
    before: 'elif [[ "${AI_CRITERION}" == 23 ]]',
    requires: ['real_dm "${REAL_LABEL}"', 'real_wait_delivery "${REAL_KEY}" 2', 'case_assert at-least-one-duplicate'],
    // ai_readback runs ai-readback.ts, which audits every receipt, then reads
    // the native reply. Only that audit is the race's subject; the reply needs
    // a native assistant turn, so the bridge runs the real audit alone.
    preset: ['EXPECTED="$HOME/ai-expected"', 'mkdir -p "${EXPECTED}"', 'ai_readback() { _bridged readback "$@"; }'], tools: ['mkdir'] },
} as const satisfies Record<string, RealSlice>
export type Site = keyof typeof SITE_SLICES

function between(text: string, after: string | readonly string[], before: string) {
  let at = 0
  for (const anchor of typeof after === 'string' ? [after] : after) {
    const found = text.indexOf(anchor, at)
    if (found < 0) throw new Error(`Missing real slice boundary after ${anchor.trim()}`)
    at = found + anchor.length
  }
  const to = text.indexOf(before, at)
  if (to < 0) throw new Error(`Missing real slice boundary before ${before.trim()}`)
  return text.slice(at, to)
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
      // Only node:path besides the guarded node:fs: another built-in (such as
      // node:child_process) could reach the host, and a package would resolve
      // from this checkout's node_modules, not the scenario's package.
      if (spec !== 'node:path') throw new Error(`Unexpected bare import in real slice fixture ${path}: ${spec}`)
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

/** Run `bun <fixture> <args>` as the fixture's own CLI would, in process.
 * `file` is relative to tests/integration, as a slice's `fixtures/…`. */
export async function runFixture(file: string, args: string[]) {
  const path = resolve(INTEGRATION, file)
  if (dirname(path) !== FIXTURES) throw new Error(`Unexpected bun target in real slice: ${file}`)
  const run: FixtureRun = { out: [], err: [], modules: new Map() }
  try { await evaluate(path, run, args) } catch (error) { if (!(error instanceof ProcessExit)) throw error }
  return { code: run.exit ?? 0, out: run.out, err: run.err }
}

export interface SliceResult {
  code: number | null; signal: string | null; stderr: string; polls: number
  ready: number; calls: string[]; errors: string[]; outputs: string[]
}
export type Test33Result = SliceResult

export interface SliceHooks {
  /** After each audit the slice runs (a fixture command, or ai_readback's
   * `readback`), before the shell receives its status. There is no scheduler
   * timing window. */
  afterAudit?(command: string, code: number): Promise<void>
  /** Each time the shell would sleep. */
  poll?(polls: number): Promise<void>
  /** `real_dm <label> <text> [ts]`: accept and deliver the input. */
  dm?(words: string[]): Promise<void>
}

/** A slice whose receipt waits block longer than this has hung. */
const SLICE_TIMEOUT_MS = 4000

export async function runRealSlice(slice: RealSlice, stateDir: string, hooks: SliceHooks = {}, timeout = SLICE_TIMEOUT_MS): Promise<SliceResult> {
  const script = source(slice.script), scenario = source('integration/lib/scenario.sh')
  const body = between(script, slice.after, slice.before)
  for (const line of slice.requires) if (!body.includes(line)) throw new Error(`${slice.script} slice lacks ${line}`)
  const functions = ['_scenario_poll_until', '_scenario_check_timeout', 'wait_until'].map(name => {
    const found = scenario.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
    if (!found) throw new Error(`Missing scenario polling function: ${name}`)
    return found[0]
  }).join('\n')
  const program = [
    'set -euo pipefail', 'exec 3>&1', 'exec 1>/dev/null',
    // Definitions only: neither scenario source-time setup nor native setup runs.
    shellDefinitions(source('integration/lib/real-scenario.sh')), functions, shellDefinitions(script),
    'SCENARIO_ROOT="$HOME"', 'SLACK_STATE_DIR="$HOME"', 'SCENARIO_FIXTURES=fixtures', 'REAL_KEY=alpha', 'REAL_LABEL=alpha',
    'REAL_RECEIPTS="${SCENARIO_FIXTURES}/transcript-receipts.ts"', 'CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"',
    'SCENARIO_AD_SHIM_LOG="$HOME/shim.log"',
    'REAL_DELIVERY_WAIT_S=3', 'REAL_DELIVERY_MAX_WAIT_S=5', 'SCENARIO_POLL_S=1', ...slice.preset,
    'bridge() { local answer; printf "%s\\n" "$1" >&3; IFS= read -r answer; printf "%s\\n" "$answer"; }',
    `_bridged() { local IFS=$'\\t' reply; reply="$(bridge "$*")"; printf '%s\\n' "\${reply#*$'\\t'}"; return "\${reply%%$'\\t'*}"; }`,
    'bun() { _bridged bun "$@"; }', 'real_ad() { _bridged ad "$@"; }', 'real_instance() { echo cscb_alpha; }',
    'real_dm() { _bridged dm "$@" >/dev/null; }',
    'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    '_scenario_now_ms() { bridge now; }', 'sleep() { bridge poll >/dev/null; }',
    body,
  ].join('\n')
  const child = spawn('bash', ['-c', program], {
    env: hostSafeChildEnv(stateDir, { tools: ['bash', ...slice.tools] }),
    stdio: ['pipe', 'pipe', 'pipe'], timeout,
  })
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let stderr = '', polls = 0, ready = 0
  const calls: string[] = [], errors: string[] = [], outputs: string[] = []
  const audited = async (command: string, result: { code: number; out: string[]; err: string[] }) => {
    calls.push(`${command}:${result.code}`)
    errors.push(...result.err)
    outputs.push(...result.out)
    if (command === 'ready' && result.code === 0) ready++
    await hooks.afterAudit?.(command, result.code)
    return `${result.code}\t${result.out.join(' ')}`
  }
  child.stderr.on('data', data => { stderr += data })
  try {
    for await (const request of createInterface({ input: child.stdout })) {
      const [kind, ...words] = request.split('\t')
      let answer: string
      if (kind === 'now') answer = String(polls * 1000)
      else if (kind === 'poll') { polls++; await hooks.poll?.(polls); answer = 'ok' }
      else if (kind === 'ad') answer = words[0] === 'status' ? `0\t${JSON.stringify({ instance_id: 'cscb_alpha', state: 'waiting' })}` : '1\t'
      else if (kind === 'dm') {
        if (words[0] !== 'alpha' || !hooks.dm) throw new Error('real slice sent a DM to another persona or without an input')
        await hooks.dm(words)
        answer = '0\t'
      } else if (kind === 'readback') {
        const [expected, seq] = words
        if (words.length !== 2 || dirname(expected!) !== join(stateDir, 'ai-expected') || !/^[1-9]\d*$/.test(seq!)) throw new Error('ai_readback passed another expectation or sequence')
        // ai-readback.ts's audit: every receipt, no expected count.
        answer = await audited('readback', await runFixture('fixtures/transcript-receipts.ts',
          ['audit', stateDir, 'alpha', join(stateDir, 'shim.log'), join(stateDir, '.claude/projects')]))
      } else if (kind === 'bun') {
        const [file, ...args] = words
        const [command, state, key] = args
        // A delivery watchdog's AD diagnostic reads only its scratch status file.
        const own = file === 'fixtures/real-observations.ts' ? args.length === 1 && command === join(stateDir, 'real-delivery-status.json')
          : state === stateDir && key === 'alpha'
        if (!own) throw new Error('real slice passed another state directory or persona')
        answer = await audited(command!, await runFixture(file!, args))
      } else throw new Error(`Unexpected real slice transport request: ${kind}`)
      child.stdin.write(answer.replaceAll('\n', ' ') + '\n')
    }
    const result = { ...await closed, stderr, polls, ready, calls, errors, outputs }
    assertNoLeak(result)
    if (result.signal) throw new Error(`${slice.script} slice exceeded its process timeout: ${JSON.stringify(result)}`)
    return result
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
}

/** `afterReady` runs once, after the first successful full receipt audit has
 * read its evidence and before the shell receives that success. `poll` runs
 * each time the shell would sleep. */
export async function runTest33Slice(leg: Test33Leg, stateDir: string, hooks: {
  afterReady?(): Promise<void>
  poll?(polls: number): Promise<void>
} = {}): Promise<Test33Result> {
  const { after, before, preset } = TEST33_SLICES[leg]
  let first = true
  return runRealSlice({ script: 'integration/test-33-fmk-real-keys.sh', after, before, preset, tools: [],
    requires: ['real_wait_delivery', `case_assert ${leg}`] }, stateDir, {
    afterAudit: async (command, code) => {
      if (command !== 'ready' || code !== 0 || !first) return
      first = false
      await hooks.afterReady?.()
    },
    poll: hooks.poll,
  })
}
