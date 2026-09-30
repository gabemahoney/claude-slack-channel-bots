/**
 * sr99-guarded-exit.test.ts — tests for bug b.vqy.
 *
 * Bug b.vqy: the SR-99.0 EXIT trap in the release scripts fired on the script's
 * OWN deliberate exits, so every guarded SR path printed its specific SR-X.Y
 * diagnostic and then a contradictory "SR-99.0 (uncaught) … state of the release
 * is indeterminate" right after it.
 *
 * The fix gives each affected script an `SR_GUARDED_EXIT` flag plus an
 * `sr_exit()` wrapper that raises the flag before exiting; the trap only speaks
 * when the flag is still 0. SR-99.0 therefore keeps firing for genuinely
 * unguarded failures (AC-2) and stays silent on guarded ones (AC-1/AC-4).
 *
 * Everything here runs the REAL scripts, but only on paths that fail before any
 * release machinery is touched (bad argument; missing/corrupt manifest in a
 * throwaway temp git repo), or runs a COPY of a script in a temp dir with an
 * injected `false` immediately after the trap install. Nothing publishes,
 * installs, pushes, or touches the caller's working tree.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')

/** Scripts the fix touched — each installs the SR-99.0 trap and has guarded exits. */
const GUARDED_SCRIPTS = [
  'publish-promote.sh',
  'publish-prepare.sh',
  'preflight.sh',
  'smoke-check.sh',
  'install-local.sh',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunResult {
  code: number
  stderr: string
}

/**
 * Tools every script run needs: `bash` itself and `basename`, which the SR-99.0
 * trap calls to name the script in its diagnostic.
 */
const SCRIPT_TOOLS = ['bash', 'basename']

/**
 * Tools the publish-promote.sh precondition paths reach: `dirname` (SCRIPT_DIR),
 * `git` (repo-root discovery and the dirty-tree snapshot), `grep` (the dirty-file
 * checks) and `jq` (manifest reads).
 */
const PROMOTE_TOOLS = [...SCRIPT_TOOLS, 'dirname', 'git', 'grep', 'jq']

/**
 * Run a bash script, capturing stderr and the exit code (never throws). The
 * child gets the suite's temp HOME and a PATH holding only the named tools.
 */
function runScript(scriptAbs: string, args: string[], cwd: string, tools: string[] = SCRIPT_TOOLS): RunResult {
  try {
    execFileSync('bash', [scriptAbs, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: hostSafeChildEnv(childHome, { tools }),
    })
    return { code: 0, stderr: '' }
  } catch (e: any) {
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stderr: String(e.stderr ?? ''),
    }
  }
}

/** How many `SR-99.0` diagnostics appear in this stderr. */
function countSr99(stderr: string): number {
  return (stderr.match(/SR-99\.0/g) ?? []).length
}

/** Every distinct `SR-X.Y` identifier mentioned, in first-seen order. */
function srCodes(stderr: string): string[] {
  const seen = new Set<string>()
  for (const m of stderr.matchAll(/SR-\d+\.\d+/g)) seen.add(m[0])
  return [...seen]
}

let tmpRoot: string
/** HOME for every child process: a temp dir under tmpRoot, removed with it. */
let childHome: string

/** A throwaway git repo (no commits needed — nothing here ever commits). */
function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpRoot, 'repo-'))
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe', env: hostSafeChildEnv(childHome, { tools: ['git'] }) })
  return dir
}

/**
 * Copy a script into a temp dir with `false` injected immediately after its
 * first trap installation, simulating an unguarded `set -e` death at a site
 * with no SR wrapper. The injected failure runs before any argument parsing or
 * real work, so the copy can never reach release machinery.
 */
function copyWithInjectedFailure(scriptName: string, destDir: string): string {
  const lines = readFileSync(join(SCRIPTS_DIR, scriptName), 'utf-8').split('\n')
  const trapLine = lines.findIndex((l) => l.startsWith('trap ') && l.includes(' EXIT'))
  if (trapLine < 0) throw new Error(`no trap installation found in ${scriptName}`)
  lines.splice(trapLine + 1, 0, 'false  # injected unguarded failure (b.vqy test)')
  const dest = join(destDir, scriptName)
  writeFileSync(dest, lines.join('\n'))
  return dest
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'b-vqy-'))
  childHome = mkdtempSync(join(tmpRoot, 'home-'))
})
afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// AC-4 / AC-1 — guarded paths print exactly one diagnostic
// ---------------------------------------------------------------------------

describe('b.vqy: a guarded SR exit prints its own diagnostic and no SR-99.0', () => {
  test('preflight.sh with an invalid bump argument: one SR-X.Y block, no SR-99.0', () => {
    const { code, stderr } = runScript(join(SCRIPTS_DIR, 'preflight.sh'), ['banana'], tmpRoot)
    expect(code).toBe(2) // AC-6: exit code unchanged
    expect(stderr).toContain('SR-1.2 (argument)')
    expect(srCodes(stderr)).toEqual(['SR-1.2']) // exactly one SR identifier
    expect(countSr99(stderr)).toBe(0)
  })

  test('publish-promote.sh with no manifest: precondition diagnostic only, no SR-99.0', () => {
    const repo = initTempRepo()
    const { code, stderr } = runScript(join(SCRIPTS_DIR, 'publish-promote.sh'), [], repo, PROMOTE_TOOLS)
    expect(code).toBe(1)
    expect(stderr).toContain('no .publish-state.json')
    expect(countSr99(stderr)).toBe(0)
  })

  test('publish-promote.sh with a corrupt manifest: precondition diagnostic only, no SR-99.0', () => {
    // Regression test for the structural half of the fix: `_jq_manifest` used to
    // `exit 1` from inside a command substitution, where the guard flag would be
    // set in the subshell only and lost. It now `return 1`s and the call site
    // does `|| sr_exit 1` in the script's own shell.
    const repo = initTempRepo()
    writeFileSync(join(repo, '.publish-state.json'), 'not json{')
    const { code, stderr } = runScript(join(SCRIPTS_DIR, 'publish-promote.sh'), [], repo, PROMOTE_TOOLS)
    expect(code).toBe(1)
    expect(stderr).toContain("jq failed to read '.bump_kind'")
    expect(countSr99(stderr)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC-2 — genuinely unguarded failures still get SR-99.0
// ---------------------------------------------------------------------------

describe('b.vqy: an unguarded failure still produces exactly one SR-99.0', () => {
  test.each(GUARDED_SCRIPTS)('%s dies at an injected unguarded `false`', (scriptName) => {
    const dir = mkdtempSync(join(tmpRoot, 'inject-'))
    const copy = copyWithInjectedFailure(scriptName, dir)
    const { code, stderr } = runScript(copy, [], dir)
    expect(code).not.toBe(0)
    expect(countSr99(stderr)).toBe(1)
    expect(stderr).toContain('at command: false')
  })
})

// ---------------------------------------------------------------------------
// Teeth check — the assertions above would fail on the pre-fix trap
// ---------------------------------------------------------------------------

describe('b.vqy: the no-double-diagnostic assertion has teeth', () => {
  test('a pre-fix-shaped script (unguarded trap + deliberate exit) emits both diagnostics', () => {
    // Self-contained reproduction of the pre-fix shape: the original trap
    // condition (`if [ $rc -ne 0 ]` with no guard flag) plus a guarded SR path
    // that prints its own diagnostic and exits non-zero.
    const dir = mkdtempSync(join(tmpRoot, 'prefix-'))
    const script = join(dir, 'prefix-shape.sh')
    writeFileSync(
      script,
      [
        'set -euo pipefail',
        `trap 'rc=$?; if [ $rc -ne 0 ]; then echo "SR-99.0 (uncaught): exited with code $rc at command: \${BASH_COMMAND}." >&2; fi' EXIT`,
        'echo "SR-6.1 (registry verification): the release succeeded." >&2',
        'exit 60',
        '',
      ].join('\n'),
    )
    const { code, stderr } = runScript(script, [], dir)
    expect(code).toBe(60)
    // Both diagnostics present — exactly the contradiction b.vqy reports, and
    // exactly what the guarded-path tests above assert must not happen.
    expect(srCodes(stderr)).toEqual(['SR-6.1', 'SR-99.0'])
    expect(countSr99(stderr)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Rot guard — no deliberate non-zero exit may bypass sr_exit
// ---------------------------------------------------------------------------

/**
 * Script source with quoted-string bodies and `#` comments blanked out, in that
 * order: a `#` inside a string (`echo "see step #3" ; exit 1`) is not a comment,
 * so stripping comments first would truncate the line and hide the `exit`.
 */
function stripCommentsAndStrings(script: string): string[] {
  return script.split('\n').map((raw) =>
    raw
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/#.*$/, ''),
  )
}

/** Line indices spanned by the `sr_exit()` definition, whose own `exit` is the wrapper. */
function srExitBodyLines(stripped: string[]): Set<number> {
  const start = stripped.findIndex((l) => /^\s*sr_exit\s*\(\)/.test(l))
  if (start < 0) return new Set()
  const end = stripped.findIndex((l, i) => i > start && /^\s*}\s*$/.test(l))
  const span = new Set<number>()
  for (let i = start; i <= (end < 0 ? stripped.length - 1 : end); i++) span.add(i)
  return span
}

/**
 * Lines with a deliberate `exit` whose argument is not the literal `0` — every
 * one of those must go through sr_exit instead. A variable argument counts:
 * `exit "${PREFLIGHT_EXIT}"` and `exit "${SMOKE_EXIT}"` were two of the actual
 * pre-fix offenders, and matching only literal digits would have missed them.
 * The `exit "$1"` inside the sr_exit definition itself is excluded.
 */
function bareNonZeroExits(script: string): string[] {
  const stripped = stripCommentsAndStrings(script)
  const wrapper = srExitBodyLines(stripped)
  return stripped
    .map((line, i) => ({ line: line.trim(), i }))
    .filter(({ i }) => !wrapper.has(i))
    .filter(({ line }) => {
      const m = line.match(/(?:^|[;&|])\s*exit\s+([^\s;&|]+)/)
      return m !== null && m[1] !== '0'
    })
    .map(({ line, i }) => `${i + 1}: ${line}`)
}

function releaseScripts(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.sh'))
    .filter((f) => readFileSync(join(SCRIPTS_DIR, f), 'utf-8').includes('SR-99.0 (uncaught)'))
}

describe('b.vqy: rot guard on every script that installs the SR-99.0 trap', () => {
  test('the fixed scripts are all discovered by the scanner (scanner sanity)', () => {
    const found = releaseScripts()
    for (const s of GUARDED_SCRIPTS) expect(found).toContain(s)
  })

  test.each(GUARDED_SCRIPTS)('%s routes every deliberate non-zero exit through sr_exit', (name) => {
    const script = readFileSync(join(SCRIPTS_DIR, name), 'utf-8')
    expect(script).toContain('SR_GUARDED_EXIT=0')
    expect(script).toContain('sr_exit()')
    expect(bareNonZeroExits(script)).toEqual([])
  })

  test('every SR-99.0 trap in a script that uses sr_exit is guarded by the flag', () => {
    for (const name of releaseScripts()) {
      const script = readFileSync(join(SCRIPTS_DIR, name), 'utf-8')
      const usesSrExit = /^\s*(\|\|\s*)?sr_exit\s/m.test(script)
      const traps = script.split('\n').filter((l) => l.startsWith('trap ') && l.includes('SR-99.0'))
      expect(traps.length).toBeGreaterThan(0)
      if (!usesSrExit) continue // e.g. sanitize-global.sh: all deliberate exits are 0
      for (const trapLine of traps) {
        expect(trapLine).toContain('"${SR_GUARDED_EXIT:-0}" != "1"')
      }
    }
  })

  test('no script that installs the SR-99.0 trap has a bare non-zero exit', () => {
    const offenders: Record<string, string[]> = {}
    for (const name of releaseScripts()) {
      const bare = bareNonZeroExits(readFileSync(join(SCRIPTS_DIR, name), 'utf-8'))
      if (bare.length) offenders[name] = bare
    }
    expect(offenders).toEqual({})
  })

  test('rot guard has teeth: literal, variable and after-a-string exits are flagged, quoted/commented ones are not', () => {
    const fixture = [
      'if [ -z "$x" ]; then',
      '  echo "run: exit 1 by hand" >&2',
      '  exit 1',
      'fi',
      '# exit 2 in a comment',
      'exit 0',
      'echo "see step #3" ; exit 1', // the `#` lives in a string, not a comment
      'exit "${SOME_EXIT}"', // the publish-prepare.sh / smoke-check.sh shape
      'exit $rc',
      'sr_exit() {',
      '  exit "$1"',
      '}',
    ].join('\n')
    expect(bareNonZeroExits(fixture)).toEqual([
      '3: exit 1',
      '7: echo "" ; exit 1',
      '8: exit ""',
      '9: exit $rc',
    ])
  })
})
