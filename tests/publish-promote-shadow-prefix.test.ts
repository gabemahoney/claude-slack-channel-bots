/**
 * publish-promote-shadow-prefix.test.ts — behavioral + guard tests for bug b.r6x.
 *
 * Bug b.r6x: Phase 7 of `scripts/publish-promote.sh` assumed the only global
 * install that can exist is the one under `${BUN_INSTALL:-$HOME/.bun}/install/global`.
 * On the 0.10.0 release host a stale install in a SECOND bun prefix
 * (`~/.cache/.bun`) won on PATH through a `~/.local/bin` shim, so promote
 * installed correctly, then failed its own SR-7.4 check with a diagnostic
 * blaming this prefix's layout — sending the operator after the wrong cause.
 *
 * The fix takes the AC-2 "accurate diagnostic" option (report, never delete):
 *   - SR-7.0 warns BEFORE the install when the command already resolves outside
 *     the canonical prefix (warn only; it does not exit).
 *   - SR-7.4's outside-prefix arm emits the same report and still exits 72.
 *   - SR-7.4b closes the fresh-prefix trust gap (AC-7), non-fatally.
 *
 * Tests follow the extraction pattern of publish-promote-sr61-poll-window.test.ts
 * and publish-promote-bun-g-cwd.test.ts: the load-bearing blocks are lifted
 * VERBATIM from the script at test time (so they cannot drift) and spliced into
 * a tiny bash harness.
 *
 * SAFETY: every scenario runs against a throwaway prefix tree under `mkdtemp`,
 * and every bash child gets its environment from `hostSafeChildEnv`: `HOME` is
 * that tree, and `PATH` is the tree's own directories (first) plus the
 * directories of the system tools the harness names (`bun` is never named, but
 * a named tool's directory, e.g. `/usr/bin`, can also hold the real `bun`).
 * No test can resolve the operator's real `~/.bun`, `~/.cache/.bun`,
 * `~/.local/bin` or the live global install. Nothing here executes a real
 * `bun install -g` / `bun remove -g` / `bun pm -g trust`: the SR-7.4b and
 * sanitize tests put a recording stub named `bun` in a directory that comes
 * FIRST on that PATH, so `bun` resolves to the stub — proved by the PATH-order
 * cases ("the child PATH puts the test directories first").
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  symlinkSync,
  chmodSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { hostSafeChildEnv, type HostSafeChildEnvOptions } from './test-helpers/host-safe-env.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const PROMOTE_SCRIPT = join(REPO_ROOT, 'scripts/publish-promote.sh')
const SANITIZE_SCRIPT = join(REPO_ROOT, 'scripts/sanitize-global.sh')
const PKG = 'claude-slack-channel-bots'
/**
 * Tools the helper + SR-7.0 / SR-7.4 harnesses run by name (`command`,
 * `printf` and `[` are bash builtins). Never `bun`: the shadow checks must see
 * only the fake prefix tree's `claude-slack-channel-bots`, never a real one.
 */
const SHADOW_TOOLS = ['bash', 'readlink', 'dirname', 'sed'] as const
/** Tools the SR-7.4b harness runs besides the stub `bun` (whose shebang needs bash). */
const SR74B_TOOLS = ['bash', 'jq'] as const
/** Tools sanitize-global.sh and its stub `bun` run by name. */
const SANITIZE_TOOLS = ['bash', 'head', 'tr', 'basename', 'node'] as const

function readPromote(): string {
  return readFileSync(PROMOTE_SCRIPT, 'utf-8')
}

/**
 * A self-contained reproduction of the PRE-FIX Phase 7 shape, embedded here on
 * purpose: reading it back out of git (`git show HEAD:…`) would make the guards
 * below self-destruct the moment the fix is committed, because HEAD would then
 * be the FIXED script. Same technique as tests/publish-promote-bun-g-cwd.test.ts
 * and tests/sr99-guarded-exit.test.ts.
 *
 * It carries the two properties the guards care about: no helper / SR-7.0 /
 * SR-7.4b sections at all, and an SR-7.4 arm whose diagnostic blames THIS
 * prefix's layout ("symlink farm") with no shim, chain or repoint remediation.
 */
const PRE_FIX_PHASE7 = [
  '# SR-7.1 — sanitize the bun-1.3.13 empty-string-dependency-key poison from the global package.json',
  'bash "${REPO_ROOT}/scripts/sanitize-global.sh" || sr_exit 70',
  '',
  '# SR-7.2 — remove any existing global install (tolerate non-zero exit; nothing may be installed).',
  '(cd "$HOME" && bun remove -g claude-slack-channel-bots) > /dev/null 2>&1 || true',
  '',
  '# SR-7.3 — install the just-published version from npm',
  'if ! (cd "$HOME" && bun install -g "claude-slack-channel-bots@${NEXT_VERSION}"); then',
  '  sr_exit 71',
  'fi',
  '',
  '# SR-7.4 — verify the install: bin resolves under the global install prefix',
  'INSTALLED_BIN_PATH="$(command -v claude-slack-channel-bots || true)"',
  'RESOLVED_BIN="$(readlink -f "${INSTALLED_BIN_PATH}")"',
  'case "${RESOLVED_BIN}" in',
  '  "${GLOBAL_DIR}"/*) ;;',
  '  *)',
  `    echo "SR-7.4 (post-publish verification): resolved bin '\${RESOLVED_BIN}' is not under '\${GLOBAL_DIR}/' — a worktree-pointing symlink farm would resolve outside this prefix and fail this check. State: the release IS published. \${MANIFEST} is preserved. Operator recovery: have the operator run 'bun remove -g claude-slack-channel-bots' followed by 'bun install -g claude-slack-channel-bots@\${NEXT_VERSION}' to replace the symlink farm with a real-copy install, then 'claude-slack-channel-bots clean_restart', then delete \${MANIFEST}. Do NOT rerun /publish promote." >&2`,
  '    sr_exit 72',
  '    ;;',
  'esac',
  '',
  '# SR-7.5 — belt-and-suspenders: post-verify working-tree snapshot.',
  '',
].join('\n')

/**
 * Lift the half-open source range [startMatch, boundaryMatch) out of a script.
 * Section boundaries (the next `# SR-x.y ` banner) are used rather than a
 * closing `fi`, so the extraction survives blocks that contain sibling ifs.
 */
function extractSection(script: string, startMatch: RegExp, boundaryMatch: RegExp): string {
  const lines = script.split('\n')
  const start = lines.findIndex((l) => startMatch.test(l))
  if (start < 0) throw new Error(`start marker not found: ${startMatch}`)
  const boundary = lines.findIndex((l, i) => i > start && boundaryMatch.test(l))
  if (boundary < 0) throw new Error(`boundary marker not found: ${boundaryMatch}`)
  return lines.slice(start, boundary).join('\n')
}

let HELPERS: string
let SR70: string
let SR74_ARM: string
let SR74B: string

beforeAll(() => {
  const script = readPromote()
  HELPERS = extractSection(script, /^# Phase 7 prefix resolution/, /^# SR-7\.0 — /)
  SR70 = extractSection(script, /^# SR-7\.0 — /, /^# SR-7\.2 — /)
  SR74_ARM = extractSection(script, /^case "\$\{RESOLVED_BIN\}" in/, /^INSTALLED_PKG_JSON=/)
  SR74B = extractSection(script, /^# SR-7\.4b — /, /^# SR-7\.5 — /)
  // Sanity: we captured the pieces under test, not empty slices.
  expect(HELPERS).toContain('cscb_shadow_report()')
  expect(SR70).toContain('cscb_is_outside_prefix')
  expect(SR74_ARM).toContain('sr_exit 72')
  expect(SR74B).toContain('trustedDependencies')
})

// ---------------------------------------------------------------------------
// Fake-prefix fixtures
// ---------------------------------------------------------------------------

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * `hostSafeChildEnv` options with `tools` REQUIRED: omitting it would fall back
 * to the helper's default tools (which include `bun`), silently putting their
 * directories on the harness PATH.
 */
type RunBashChild = HostSafeChildEnvOptions & { tools: readonly string[] }

/**
 * Run a bash harness with `home` as HOME and a host-safe PATH: `child.pathDirs`
 * (the test's fake-prefix or stub directories) first, then the dirs of
 * `child.tools`. Never inherits the real env.
 */
function runBash(body: string, home: string, child: RunBashChild): RunResult {
  const r = spawnSync('bash', ['-c', body], {
    env: hostSafeChildEnv(home, { tools: child.tools, pathDirs: child.pathDirs, extras: child.extras }),
    encoding: 'utf-8',
  })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const tmpDirs: string[] = []

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'r6x-'))
  tmpDirs.push(dir)
  return dir
}

function writeExec(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function link(from: string, to: string): void {
  mkdirSync(dirname(from), { recursive: true })
  symlinkSync(to, from)
}

/**
 * Build a bun-prefix-shaped install tree under `prefix` and return the path of
 * the prefix's own bin symlink (`<prefix>/bin/<pkg>` → the installed cli.ts).
 */
function makePrefixInstall(prefix: string): string {
  const cli = join(prefix, 'install/global/node_modules', PKG, 'src/cli.ts')
  writeExec(cli, '#!/usr/bin/env bun\n')
  const bin = join(prefix, 'bin', PKG)
  link(bin, cli)
  return bin
}

/** A repo-checkout cli.ts, the thing the stale ~/.cache/.bun farm pointed at. */
function makeRepoCli(home: string): string {
  const cli = join(home, 'fakerepo/src/cli.ts')
  writeExec(cli, '#!/usr/bin/env bun\n')
  return cli
}

interface Sr70Opts {
  /** Directories prepended to PATH, in order. */
  pathDirs?: string[]
  /** Value for BUN_INSTALL; omitted means unset (the default ~/.bun prefix). */
  bunInstall?: string
}

/** Run helpers + SR-7.0 against a sandboxed HOME. */
function runSr70(home: string, opts: Sr70Opts = {}): RunResult {
  return runBash(['set -euo pipefail', HELPERS, SR70, 'exit 0'].join('\n'), home, {
    tools: SHADOW_TOOLS,
    pathDirs: opts.pathDirs ?? [],
    extras: opts.bunInstall ? { BUN_INSTALL: opts.bunInstall } : {},
  })
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Harness environment: the test's directories win on PATH
// ---------------------------------------------------------------------------

describe('b.r6x harness: the child PATH puts the test directories first', () => {
  test.each([
    { harness: 'SR-7.0 / SR-7.4', tools: SHADOW_TOOLS },
    { harness: 'SR-7.4b', tools: SR74B_TOOLS },
    { harness: 'sanitize-global.sh', tools: SANITIZE_TOOLS },
  ])('$harness: the given dirs lead PATH in order and a stub there is what the child runs', ({ tools }) => {
    const home = makeHome()
    const stubBin = join(home, 'stub-bin')
    const shimDir = join(home, '.local/bin')
    writeExec(join(stubBin, 'bun'), '#!/usr/bin/env bash\nexit 0\n')
    const r = runBash('printf "%s\\n" "$PATH"; command -v bun', home, {
      tools,
      pathDirs: [stubBin, shimDir],
    })
    expect(r.code).toBe(0)
    const [path, bun] = r.stdout.split('\n')
    expect(path!.split(':').slice(0, 2)).toEqual([stubBin, shimDir])
    expect(bun).toBe(join(stubBin, 'bun'))
  })
})

// ---------------------------------------------------------------------------
// SR-7.0 — pre-install shadow detection (AC-1, AC-2)
// ---------------------------------------------------------------------------

describe('b.r6x: SR-7.0 detects an install shadowing the canonical prefix on PATH', () => {
  test('the ticket layout (.local/bin shim → .cache/.bun → repo cli) is reported in full', () => {
    // Reproduces the state observed on the 0.10.0 release host.
    const home = makeHome()
    makePrefixInstall(join(home, '.bun')) // canonical, correct install
    const stale = join(home, '.cache/.bun')
    const repoCli = makeRepoCli(home)
    mkdirSync(join(stale, 'install/global'), { recursive: true })
    mkdirSync(join(stale, 'install/cache/some-package'), { recursive: true }) // bun's shared download cache
    const staleBin = join(stale, 'bin', PKG)
    link(staleBin, repoCli)
    const shim = join(home, '.local/bin', PKG)
    link(shim, staleBin)

    const r = runSr70(home, { pathDirs: [join(home, '.local/bin'), join(home, '.bun/bin')] })

    expect(r.code).toBe(0) // SR-7.0 warns, it does not abort the release
    // Names the path on PATH, every hop of the chain, and the true target.
    expect(r.stderr).toContain(shim)
    expect(r.stderr).toContain(`${shim} -> ${staleBin} -> ${repoCli}`)
    expect(r.stderr).toContain(repoCli)
    // Names the prefix that was expected, and the stale prefix it derived.
    expect(r.stderr).toContain(join(home, '.bun/install/global'))
    expect(r.stderr).toContain(`rm -rf ${join(stale, 'install/global')}`)
    expect(r.stderr).toContain(`rm -f  ${staleBin}`)
    // AC-4: the shim is REPOINTED, never deleted.
    expect(r.stderr).toContain(`ln -sfn ${join(home, '.bun/bin', PKG)} ${shim}`)
    expect(r.stderr).not.toContain(`rm -f  ${shim}`)
    // AC-3: bun's shared download cache is never named as a deletion target.
    const removals = r.stderr.split('\n').filter((l) => /^\s*rm\s/.test(l))
    expect(removals.filter((l) => l.includes('install/cache'))).toEqual([])
  })

  test('a stale prefix whose own bin is the thing on PATH gets no redundant rm -f', () => {
    const home = makeHome()
    makePrefixInstall(join(home, '.bun'))
    const staleBin = makePrefixInstall(join(home, '.cache/.bun'))

    const r = runSr70(home, { pathDirs: [join(home, '.cache/.bun/bin')] })

    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`rm -rf ${join(home, '.cache/.bun/install/global')}`)
    // The path on PATH is the stale bin itself: the ln -sfn below repoints it,
    // so deleting it first would break the only reachable name (AC-4).
    expect(r.stderr).not.toMatch(/^\s*rm -f/m)
    expect(r.stderr).toContain(`ln -sfn ${join(home, '.bun/bin', PKG)} ${staleBin}`)
  })

  test('a shim that is not a bun prefix is never mistaken for one (no rm of the shim)', () => {
    // ~/.local/bin/<pkg> matches the <prefix>/bin/<pkg> shape by accident. If it
    // were treated as a bun prefix the report would tell the operator to delete
    // the very shim AC-4 says to repoint — and to rm -rf ~/.local/install/global.
    const home = makeHome()
    makePrefixInstall(join(home, '.bun'))
    const repoCli = makeRepoCli(home)
    const shim = join(home, '.local/bin', PKG)
    link(shim, repoCli)

    const r = runSr70(home, { pathDirs: [join(home, '.local/bin')] })

    expect(r.code).toBe(0)
    expect(r.stderr).toContain(shim)
    expect(r.stderr).toContain(repoCli)
    expect(r.stderr).not.toMatch(/^\s*rm /m) // nothing at all is proposed for deletion
    expect(r.stderr).toContain(`ln -sfn ${join(home, '.bun/bin', PKG)} ${shim}`)
  })

  test('a healthy install resolving under the canonical prefix is silent', () => {
    const home = makeHome()
    makePrefixInstall(join(home, '.bun'))
    const r = runSr70(home, { pathDirs: [join(home, '.bun/bin')] })
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })

  test('a command that is not on PATH at all is silent', () => {
    const home = makeHome()
    makePrefixInstall(join(home, '.bun'))
    const r = runSr70(home, { pathDirs: [] }) // nothing from the fake tree on PATH
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })

  test('BUN_INSTALL override defines the canonical prefix in both directions', () => {
    const home = makeHome()
    const custom = join(home, 'custom-prefix')
    makePrefixInstall(custom)
    makePrefixInstall(join(home, '.bun'))

    // Resolving under the overridden prefix is healthy → silent.
    const ok = runSr70(home, {
      pathDirs: [join(custom, 'bin')],
      bunInstall: custom,
    })
    expect(ok.stderr).toBe('')

    // The same ~/.bun install that is canonical by default is now the shadow.
    const shadowed = runSr70(home, {
      pathDirs: [join(home, '.bun/bin')],
      bunInstall: custom,
    })
    expect(shadowed.code).toBe(0)
    expect(shadowed.stderr).toContain(join(custom, 'install/global'))
    expect(shadowed.stderr).toContain(`rm -rf ${join(home, '.bun/install/global')}`)
  })
})

// ---------------------------------------------------------------------------
// SR-7.0 — prefix identity is normalized, not spelled (AC-2)
// ---------------------------------------------------------------------------
//
// cscb_shadow_prefix compares `readlink -f`-normalized paths on both sides. A
// literal string comparison would call an ALIASED spelling of the canonical
// prefix a second prefix and tell the operator to `rm -rf` the tree promote just
// installed — the single most damaging thing this report could get wrong.

describe('b.r6x: an aliased spelling of the canonical prefix is not a second prefix', () => {
  test('resolving through a directory symlink to the canonical prefix stays silent', () => {
    const home = makeHome()
    makePrefixInstall(join(home, '.bun'))
    link(join(home, '.bun-alias'), join(home, '.bun')) // dir symlink to canonical
    const r = runSr70(home, { pathDirs: [join(home, '.bun-alias/bin')] })
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('') // healthy install, reached by another name
  })

  test('a chain hop through an alias of the canonical prefix proposes no rm -rf', () => {
    // The install-local.sh farm shape: the canonical prefix's own bin points at a
    // repo checkout, and PATH reaches it through an aliased spelling. The resolved
    // path is outside the prefix (so the report fires) but the only prefix in the
    // chain IS the canonical one — nothing may be proposed for deletion.
    const home = makeHome()
    mkdirSync(join(home, '.bun/install/global'), { recursive: true })
    const repoCli = makeRepoCli(home)
    link(join(home, '.bun/bin', PKG), repoCli)
    link(join(home, '.bun-alias'), join(home, '.bun'))
    const shim = join(home, '.local/bin', PKG)
    link(shim, join(home, '.bun-alias/bin', PKG))

    const r = runSr70(home, { pathDirs: [join(home, '.local/bin')] })

    expect(r.code).toBe(0)
    expect(r.stderr).toContain(repoCli) // the report still fires
    expect(r.stderr).not.toMatch(/^\s*rm /m) // but names NO deletion target
    expect(r.stderr).toContain('does not look like another bun global prefix')
    expect(r.stderr).toContain(`ln -sfn ${join(home, '.bun/bin', PKG)} ${shim}`)
  })

  test('an unnormalized `bin/..` hop into the canonical prefix proposes no rm -rf', () => {
    const home = makeHome()
    const repoCli = makeRepoCli(home)
    // <canonical>/install/global/.../cli.ts is itself a symlink into the repo,
    // reached from the prefix bin by a relative, unnormalized target.
    const installed = join(home, '.bun/install/global/node_modules', PKG, 'src/cli.ts')
    link(installed, repoCli)
    link(join(home, '.bun/bin', PKG), `../install/global/node_modules/${PKG}/src/cli.ts`)

    const r = runSr70(home, { pathDirs: [join(home, '.bun/bin')] })

    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`${join(home, '.bun/bin')}/..`) // the raw hop is in the chain
    expect(r.stderr).not.toMatch(/^\s*rm /m)
    expect(r.stderr).toContain('does not look like another bun global prefix')
  })

  test('a genuine second prefix is still reported when the chain also passes an alias', () => {
    const home = makeHome()
    mkdirSync(join(home, '.bun/install/global'), { recursive: true })
    const staleBin = makePrefixInstall(join(home, '.cache/.bun'))
    link(join(home, '.bun/bin', PKG), staleBin)
    link(join(home, '.bun-alias'), join(home, '.bun'))
    const shim = join(home, '.local/bin', PKG)
    link(shim, join(home, '.bun-alias/bin', PKG))

    const r = runSr70(home, { pathDirs: [join(home, '.local/bin')] })

    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`rm -rf ${join(home, '.cache/.bun/install/global')}`)
    // Normalization narrows the report; it does not disarm it. Neither spelling
    // of the canonical prefix is ever proposed for deletion.
    expect(r.stderr).not.toContain(`rm -rf ${join(home, '.bun/install/global')}`)
    expect(r.stderr).not.toContain(`rm -rf ${join(home, '.bun-alias/install/global')}`)
  })
})

// ---------------------------------------------------------------------------
// AC-3 — what the report proposes when the stale prefix holds other packages
// ---------------------------------------------------------------------------

describe('b.r6x AC-3: a stale prefix with unrelated dependencies', () => {
  test('the rm -rf is emitted unconditionally, and the manifest is never read', () => {
    // PINNED CURRENT BEHAVIOR, not an endorsement. cscb_shadow_report proposes
    // `rm -rf <stale>/install/global` without inspecting that prefix's manifest,
    // so a prefix that also holds unrelated global packages gets the same advice.
    // That is tolerable only because the report is advice to a human and the
    // script is forbidden from executing it (AC-2: report, never delete). If a
    // future change ever lets automation run these commands, this test must be
    // revisited FIRST: an unconditional rm -rf would then destroy other packages.
    const home = makeHome()
    makePrefixInstall(join(home, '.bun'))
    const stale = join(home, '.cache/.bun')
    const staleBin = makePrefixInstall(stale)
    writeFileSync(
      join(stale, 'install/global/package.json'),
      JSON.stringify({ dependencies: { [PKG]: '0.1.0', 'unrelated-global-pkg': '3.0.0' } }, null, 2),
    )

    const r = runSr70(home, { pathDirs: [join(home, '.cache/.bun/bin')] })

    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`rm -rf ${join(stale, 'install/global')}`)
    // No narrower alternative is offered, and the other package is not named:
    // the operator is expected to look before running the command.
    expect(r.stderr).not.toContain('unrelated-global-pkg')
    expect(r.stderr).not.toContain('bun remove -g')
    // The remediation still repoints rather than deletes the PATH entry (AC-4).
    expect(r.stderr).toContain(`ln -sfn ${join(home, '.bun/bin', PKG)} ${staleBin}`)
  })
})

// ---------------------------------------------------------------------------
// SR-7.4 — the exit-72 arm (AC-6, AC-9)
// ---------------------------------------------------------------------------

describe('b.r6x: SR-7.4 outside-prefix arm reports the shadow and still exits 72', () => {
  test('exit code is unchanged and the diagnostic names found vs expected', () => {
    const home = makeHome()
    makePrefixInstall(join(home, '.bun'))
    const repoCli = makeRepoCli(home)
    const shim = join(home, '.local/bin', PKG)
    link(shim, repoCli)

    const harness = [
      'set -euo pipefail',
      'sr_exit() { exit "$1"; }',
      'NEXT_VERSION=9.9.9',
      `MANIFEST=${JSON.stringify(join(home, '.publish-state.json'))}`,
      HELPERS,
      `INSTALLED_BIN_PATH=${JSON.stringify(shim)}`,
      `RESOLVED_BIN=${JSON.stringify(repoCli)}`,
      SR74_ARM,
      'exit 0',
    ].join('\n')

    const r = runBash(harness, home, { tools: SHADOW_TOOLS })

    expect(r.code).toBe(72) // AC-9: exit-code values unchanged
    expect(r.stderr).toContain('SR-7.4')
    expect(r.stderr).toContain(shim) // what was found on PATH
    expect(r.stderr).toContain(repoCli) // what it really resolves to
    expect(r.stderr).toContain(join(home, '.bun/install/global')) // what was expected
    expect(r.stderr).toContain(`ln -sfn ${join(home, '.bun/bin', PKG)} ${shim}`)
  })

  test('an install resolving under the canonical prefix falls through the arm, exit 0', () => {
    const home = makeHome()
    const bin = makePrefixInstall(join(home, '.bun'))
    const resolved = join(home, '.bun/install/global/node_modules', PKG, 'src/cli.ts')
    const harness = [
      'set -euo pipefail',
      'sr_exit() { exit "$1"; }',
      'NEXT_VERSION=9.9.9',
      'MANIFEST=/dev/null',
      HELPERS,
      `INSTALLED_BIN_PATH=${JSON.stringify(bin)}`,
      `RESOLVED_BIN=${JSON.stringify(resolved)}`,
      SR74_ARM,
      'exit 0',
    ].join('\n')
    const r = runBash(harness, home, { tools: SHADOW_TOOLS })
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })
})

// ---------------------------------------------------------------------------
// SR-7.4b — postinstall trust gap (AC-7)
// ---------------------------------------------------------------------------
//
// Driven against a stub `bun` at the front of PATH that records its argv and
// CWD. No real `bun pm -g trust` ever runs.

/** The warning's consequence sentence for a missing state-dir config.json. */
const SR74B_CONFIG_CONSEQUENCE =
  "Without config.json 'claude-slack-channel-bots start' fails with 'missing prerequisite: config.json'."
/** The warning's consequence sentence for a missing ~/.claude/slack-mcp.json. */
const SR74B_MCP_CONSEQUENCE =
  "Without slack-mcp.json, persona sessions launched with the default mcp_config_path cannot reach the server's MCP endpoint."

interface Sr74bOpts {
  /** Write a global manifest, and whether it lists the package as trusted. */
  manifest?: 'trusted' | 'untrusted' | 'absent'
  /**
   * Create the files SR-7.4b checks for: the state dir's config.json and
   * ~/.claude/slack-mcp.json. `true` writes both; the object form picks each.
   */
  artifacts?: boolean | { config: boolean; mcp: boolean }
  /** Write a leftover file with this name into the state dir (not an artifact). */
  leftover?: string
  /** Point SLACK_STATE_DIR at a temp state dir instead of ~/.claude/…/slack. */
  stateDirOverride?: boolean
  /** Exit code of the stub `bun`. */
  bunExit?: number
}

interface Sr74bRun extends RunResult {
  /** Full argv of every stubbed `bun` call. */
  bunCalls: string[]
  /** CWD of every stubbed `bun` call. */
  bunCwds: string[]
  /** The sandboxed HOME this run used, and the paths derived from it. */
  home: string
  stateDir: string
  mcpConfig: string
}

function runSr74b(opts: Sr74bOpts = {}): Sr74bRun {
  const home = makeHome()
  const globalDir = join(home, '.bun/install/global')
  mkdirSync(globalDir, { recursive: true })
  const manifest = opts.manifest ?? 'trusted'
  if (manifest !== 'absent') {
    writeFileSync(
      join(globalDir, 'package.json'),
      JSON.stringify(
        manifest === 'trusted'
          ? { dependencies: { [PKG]: '9.9.9' }, trustedDependencies: [PKG] }
          : { dependencies: { [PKG]: '9.9.9' } },
        null,
        2,
      ),
    )
  }

  const stateDir = opts.stateDirOverride
    ? join(home, 'state')
    : join(home, '.claude/channels/slack')
  const mcpConfig = join(home, '.claude/slack-mcp.json')
  const artifacts =
    typeof opts.artifacts === 'object'
      ? opts.artifacts
      : { config: !!opts.artifacts, mcp: !!opts.artifacts }
  if (artifacts.config) {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'config.json'), '{}\n')
  }
  if (artifacts.mcp) {
    mkdirSync(dirname(mcpConfig), { recursive: true })
    writeFileSync(mcpConfig, '{}\n')
  }
  if (opts.leftover) {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, opts.leftover), '{}\n')
  }

  const stubBin = join(home, 'stub-bin')
  const log = join(home, 'bun-calls')
  writeFileSync(log, '')
  writeExec(
    join(stubBin, 'bun'),
    [
      '#!/usr/bin/env bash',
      `printf '%s\\t%s\\n' "$*" "$PWD" >> ${JSON.stringify(log)}`,
      `exit ${opts.bunExit ?? 0}`,
    ].join('\n') + '\n',
  )

  const harness = [
    'set -euo pipefail',
    'NEXT_VERSION=9.9.9',
    `GLOBAL_DIR=${JSON.stringify(globalDir)}`,
    SR74B,
    'exit 0',
  ].join('\n')

  const r = runBash(harness, home, {
    tools: SR74B_TOOLS,
    pathDirs: [stubBin],
    extras: opts.stateDirOverride ? { SLACK_STATE_DIR: stateDir } : {},
  })
  const lines = readFileSync(log, 'utf-8').split('\n').filter(Boolean)
  return {
    ...r,
    bunCalls: lines.map((l) => l.split('\t')[0]!),
    bunCwds: lines.map((l) => l.split('\t')[1]!),
    home,
    stateDir,
    mcpConfig,
  }
}

describe('b.r6x: SR-7.4b closes the fresh-prefix postinstall trust gap', () => {
  test('a trusted manifest with config.json + MCP config present and no access.json runs no bun and warns nothing', () => {
    // b.av2 SR-12: pins the fix for a false warning on every release after
    // postinstall stopped creating access.json.
    const r = runSr74b({ manifest: 'trusted', artifacts: true })
    expect(readdirSync(r.stateDir)).toEqual(['config.json'])
    expect(r.code).toBe(0)
    expect(r.bunCalls).toEqual([])
    expect(r.stderr).toBe('')
  })

  test('an untrusted manifest triggers `bun pm -g trust`, from $HOME', () => {
    const r = runSr74b({ manifest: 'untrusted', artifacts: true })
    expect(r.code).toBe(0)
    expect(r.bunCalls).toEqual([`pm -g trust ${PKG}`])
    // b.bpp: every global bun call runs with $HOME as CWD so bun cannot resolve
    // (and rewrite) the repo's own package.json.
    expect(r.bunCwds).toEqual([r.home])
    expect(r.stderr).toBe('')
  })

  test('a manifest with no trustedDependencies at all (fresh prefix) also trusts', () => {
    const r = runSr74b({ manifest: 'absent', artifacts: true })
    expect(r.code).toBe(0)
    expect(r.bunCalls).toEqual([`pm -g trust ${PKG}`])
  })

  test('missing artifacts warn and name every missing path, but do not fail the release', () => {
    const r = runSr74b({ manifest: 'trusted', artifacts: false })
    expect(r.code).toBe(0) // non-fatal by design: the release IS delivered
    expect(r.stderr).toContain(join(r.stateDir, 'config.json'))
    expect(r.stderr).toContain(r.mcpConfig)
    // b.av2 SR-12: postinstall no longer creates access.json, so it is not on the list.
    expect(r.stderr).not.toContain('access.json')
  })

  // Each missing file gets its own consequence sentence, and only a missing
  // file gets one: a warning that always printed both would blame the MCP
  // config for a missing config.json (and vice versa).
  test.each([
    { missing: 'config.json only', config: false, mcp: true, configLine: true, mcpLine: false },
    { missing: 'slack-mcp.json only', config: true, mcp: false, configLine: false, mcpLine: true },
    { missing: 'both files', config: false, mcp: false, configLine: true, mcpLine: true },
  ])(
    'missing $missing: the warning states the consequence for each missing file only',
    ({ config, mcp, configLine, mcpLine }) => {
      const r = runSr74b({ manifest: 'trusted', artifacts: { config, mcp } })
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('SR-7.4b (postinstall trust): WARNING')
      expect(r.stderr.includes(SR74B_CONFIG_CONSEQUENCE)).toBe(configLine)
      expect(r.stderr.includes(SR74B_MCP_CONSEQUENCE)).toBe(mcpLine)
    },
  )

  test('b.av2 SR-12: a leftover access.json does not stand in for a missing config.json', () => {
    const r = runSr74b({
      manifest: 'trusted',
      artifacts: { config: false, mcp: true },
      leftover: 'access.json',
    })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('SR-7.4b (postinstall trust): WARNING')
    expect(r.stderr).toContain(join(r.stateDir, 'config.json'))
    expect(r.stderr).not.toContain(r.mcpConfig)
    expect(r.stderr).not.toContain('access.json')
  })

  test('SLACK_STATE_DIR overrides where the artifacts are looked for', () => {
    const present = runSr74b({ manifest: 'trusted', artifacts: true, stateDirOverride: true })
    expect(readdirSync(present.stateDir)).toEqual(['config.json'])
    expect(present.code).toBe(0)
    expect(present.stderr).toBe('')
    const missing = runSr74b({ manifest: 'trusted', artifacts: false, stateDirOverride: true })
    expect(missing.code).toBe(0)
    expect(missing.stderr).toContain(join(missing.stateDir, 'config.json'))
    expect(missing.stderr).not.toContain('access.json')
    // The default location is not consulted when the override is set.
    expect(missing.stderr).not.toContain(join(missing.home, '.claude/channels/slack'))
  })

  test('a failing `bun pm -g trust` is tolerated: still exit 0', () => {
    const r = runSr74b({ manifest: 'untrusted', artifacts: true, bunExit: 1 })
    expect(r.code).toBe(0)
    expect(r.bunCalls).toEqual([`pm -g trust ${PKG}`])
  })
})

// ---------------------------------------------------------------------------
// sanitize-global.sh — AC-5 (scoped to the canonical prefix, still exits 0)
// ---------------------------------------------------------------------------

describe('b.r6x AC-5: sanitize-global.sh stays canonical-prefix-scoped and exits 0', () => {
  /**
   * A stub `bun` that reports a PRE-sunset version and hands `bun -e` to node.
   *
   * Without it the script's runtime sunset check (bun >= 1.3.14 → exit 0 before
   * reading anything) short-circuits on any current host, and an "exits 0"
   * assertion would pass without the sanitize body ever running. The stub's
   * directory comes first on PATH, so `bun` resolves to the stub (proved by the
   * PATH-order cases) even where a later tool directory also holds the real
   * bun; the live global install is out of reach under the temp HOME.
   */
  function sanitizeChild(home: string, prefix: string): RunBashChild {
    const stubBin = join(home, 'stub-bin')
    writeExec(
      join(stubBin, 'bun'),
      [
        '#!/usr/bin/env bash',
        'if [ "${1:-}" = "--version" ]; then echo 1.3.13; exit 0; fi',
        'if [ "${1:-}" = "-e" ]; then exec node -e "$2"; fi',
        'exit 0',
      ].join('\n') + '\n',
    )
    return { tools: SANITIZE_TOOLS, pathDirs: [stubBin], extras: { BUN_INSTALL: prefix } }
  }

  test('a poisoned manifest is actually rewritten: both keys removed, exit 0', () => {
    const home = makeHome()
    const prefix = join(home, 'prefix')
    const child = sanitizeChild(home, prefix)
    const manifest = join(prefix, 'install/global/package.json')
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(
      manifest,
      JSON.stringify(
        { dependencies: { '': '1.0.0', [PKG]: '0.1.0', 'some-other-pkg': '2.0.0' } },
        null,
        2,
      ),
    )

    const r = runBash(`bash ${JSON.stringify(SANITIZE_SCRIPT)}`, home, child)

    expect(r.code).toBe(0)
    // The sunset check did NOT short-circuit: the body ran and rewrote the file.
    expect(r.stderr).not.toContain('skipping sanitize')
    const after = JSON.parse(readFileSync(manifest, 'utf-8')) as {
      dependencies: Record<string, string>
    }
    expect(after.dependencies).toEqual({ 'some-other-pkg': '2.0.0' })
    expect(r.stdout).toContain('empty-string entry')
    expect(r.stdout).toContain(`pre-existing ${PKG} entry`)
  })

  test('no manifest at all is a silent no-op, exit 0', () => {
    const home = makeHome()
    const prefix = join(home, 'prefix')
    const r = runBash(`bash ${JSON.stringify(SANITIZE_SCRIPT)}`, home, sanitizeChild(home, prefix))
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('a manifest in a SECOND prefix is left untouched even when BUN_INSTALL names the first', () => {
    // The scope decision, behaviorally: sanitize only ever rewrites the canonical
    // prefix's manifest. A shadowing prefix is SR-7.0/SR-7.4's business to report.
    const home = makeHome()
    const prefix = join(home, 'prefix')
    const other = join(home, 'other-prefix')
    const child = sanitizeChild(home, prefix)
    for (const p of [prefix, other]) {
      mkdirSync(join(p, 'install/global'), { recursive: true })
      writeFileSync(
        join(p, 'install/global/package.json'),
        JSON.stringify({ dependencies: { '': '1.0.0', [PKG]: '0.1.0' } }, null, 2),
      )
    }

    expect(runBash(`bash ${JSON.stringify(SANITIZE_SCRIPT)}`, home, child).code).toBe(0)

    const read = (p: string) =>
      (JSON.parse(readFileSync(join(p, 'install/global/package.json'), 'utf-8')) as {
        dependencies: Record<string, string>
      }).dependencies
    expect(read(prefix)).toEqual({})
    expect(read(other)).toEqual({ '': '1.0.0', [PKG]: '0.1.0' }) // untouched
  })

  test('it resolves exactly one prefix — the canonical one — and records why', () => {
    const script = readFileSync(SANITIZE_SCRIPT, 'utf-8')
    const prefixLines = script
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .filter((l) => l.includes('install/global'))
    // One assignment, the canonical expansion; no PATH lookup, no second prefix.
    expect(prefixLines).toEqual(['GLOBAL_DIR="${BUN_INSTALL:-$HOME/.bun}/install/global"'])
    expect(script).not.toContain('command -v')
    // AC-5's alternative to awareness: an explicit recorded scope decision.
    expect(script).toMatch(/#.*SCOPE[\s\S]*b\.r6x/)
  })
})

// ---------------------------------------------------------------------------
// Regression guards vs an embedded pre-fix-shaped script
// ---------------------------------------------------------------------------
//
// These prove the behavioral tests above have teeth: against a pre-fix-shaped
// source the blocks they exercise do not exist (so every extracting test in this
// file fails outright), and the SR-7.4 arm that source does have carries none of
// the shadow information AC-2/AC-6 require.
//
// The fixture is embedded (PRE_FIX_PHASE7) rather than read from git history on
// purpose — a `git show HEAD:…` guard inverts and fails the moment the fix is
// committed, since HEAD becomes the fixed script.

const phase7Order = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.match(/^# (SR-7\.\d[a-z]?) — /)?.[1])
    .filter((x): x is string => Boolean(x))

describe('b.r6x: a pre-fix-shaped script lacks every surface these tests assert on', () => {
  test('extracting the helper / SR-7.0 / SR-7.4b blocks throws on a pre-fix-shaped source', () => {
    expect(() =>
      extractSection(PRE_FIX_PHASE7, /^# Phase 7 prefix resolution/, /^# SR-7\.0 — /),
    ).toThrow()
    expect(() => extractSection(PRE_FIX_PHASE7, /^# SR-7\.0 — /, /^# SR-7\.2 — /)).toThrow()
    expect(() => extractSection(PRE_FIX_PHASE7, /^# SR-7\.4b — /, /^# SR-7\.5 — /)).toThrow()
    expect(PRE_FIX_PHASE7).not.toContain('cscb_shadow_report')
    // ...and all three extract cleanly from the fixed script (beforeAll already
    // depends on this; asserted here so the guard names the contrast directly).
    const fixed = readPromote()
    expect(extractSection(fixed, /^# Phase 7 prefix resolution/, /^# SR-7\.0 — /)).toContain(
      'cscb_shadow_prefix()',
    )
    expect(extractSection(fixed, /^# SR-7\.0 — /, /^# SR-7\.2 — /)).toContain('cscb_shadow_report')
    expect(extractSection(fixed, /^# SR-7\.4b — /, /^# SR-7\.5 — /)).toContain('trustedDependencies')
  })

  test('the pre-fix SR-7.4 arm named no shim, no chain and no remediation', () => {
    const preArm = extractSection(PRE_FIX_PHASE7, /^case "\$\{RESOLVED_BIN\}" in/, /^esac$/)
    // It blamed this prefix's layout and sent the operator to reinstall HERE —
    // which cannot help when the winner on PATH lives in another prefix.
    expect(preArm).toContain('symlink farm')
    expect(preArm).not.toContain('ln -sfn')
    expect(preArm).not.toContain('install/cache')
    expect(preArm).not.toContain('cscb_shadow_report')
    // The fixed arm carries the remediation the pre-fix one lacked.
    expect(SR74_ARM).toContain('cscb_shadow_report')
  })

  test('the pre-fix arm, executed, reports nothing about the shadowing prefix', () => {
    // Teeth, behaviorally: drive the embedded pre-fix arm through the very same
    // fixture the SR-7.4 test above uses. Same exit code, none of the content.
    const home = makeHome()
    makePrefixInstall(join(home, '.bun'))
    const staleBin = makePrefixInstall(join(home, '.cache/.bun'))
    const shim = join(home, '.local/bin', PKG)
    link(shim, staleBin)
    const resolved = join(home, '.cache/.bun/install/global/node_modules', PKG, 'src/cli.ts')

    const r = runBash(
      [
        'set -euo pipefail',
        'sr_exit() { exit "$1"; }',
        'NEXT_VERSION=9.9.9',
        'MANIFEST=/dev/null',
        `GLOBAL_DIR=${JSON.stringify(join(home, '.bun/install/global'))}`,
        `INSTALLED_BIN_PATH=${JSON.stringify(shim)}`,
        `RESOLVED_BIN=${JSON.stringify(resolved)}`,
        extractSection(PRE_FIX_PHASE7, /^case "\$\{RESOLVED_BIN\}" in/, /^esac$/) + '\nesac',
        'exit 0',
      ].join('\n'),
      home,
      { tools: ['bash'] },
    )

    expect(r.code).toBe(72) // AC-9: the exit code is the one thing that matches
    expect(r.stderr).not.toContain(shim) // never names the shim on PATH
    expect(r.stderr).not.toContain('Symlink chain')
    // It quotes the resolved path, but never identifies the prefix that owns it,
    // never proposes removing it, and never repoints the shim.
    expect(r.stderr).not.toContain(`rm -rf ${join(home, '.cache/.bun/install/global')}`)
    expect(r.stderr).not.toContain('ln -sfn')
    // Instead it sends the operator to reinstall in THIS prefix — the wrong cause.
    expect(r.stderr).toContain('bun install -g')
  })

  test('AC-9: phase ordering and the Phase 7 exit-code table match their pinned values', () => {
    // Pinned expectations, not a diff against git HEAD: post-commit, HEAD is this
    // script and such a comparison would be a vacuous self-comparison.
    const fixed = readPromote()
    expect(phase7Order(fixed)).toEqual([
      'SR-7.1',
      'SR-7.0',
      'SR-7.2',
      'SR-7.3',
      'SR-7.4',
      'SR-7.4b',
      'SR-7.5',
    ])
    // The pre-fix sequence survives as a subsequence: sections were only inserted.
    const pre = phase7Order(PRE_FIX_PHASE7)
    expect(pre).toEqual(['SR-7.1', 'SR-7.2', 'SR-7.3', 'SR-7.4', 'SR-7.5'])
    expect(phase7Order(fixed).filter((s) => pre.includes(s))).toEqual(pre)
    // Exit codes are untouched: same codes, same SR owners, no new code added.
    const codes = fixed.match(/^#\s+(\d+)\s+SR-\d+\.\d+/gm)?.map((l) => l.trim())
    expect(codes).toEqual([
      '#   50  SR-5.2',
      '#   51  SR-5.3',
      '#   52  SR-5.4',
      '#   60  SR-6.1',
      '#   70  SR-7.1',
      '#   71  SR-7.3',
      '#   72  SR-7.4',
    ])
    // SR-7.0 and SR-7.4b are the new sections and neither owns an exit code:
    // SR-7.0 warns, SR-7.4b is non-fatal.
    expect(codes!.some((c) => c.includes('SR-7.0') || c.includes('SR-7.4b'))).toBe(false)
  })
})
