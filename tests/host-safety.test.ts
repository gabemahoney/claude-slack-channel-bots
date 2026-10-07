/**
 * host-safety.test.ts — Keeps unit tests' child processes away from the real
 * home and any agent-director binary, and checks the `bun test` preload guard
 * (b.jg5 SRJ-1304, SRJ-1301), and audits where production code builds the
 * client or resolves the host binary (SRJ-121).
 *
 * Sections:
 * - `hostSafeChildEnv`: the environment it builds for a child and each of its
 *   refusals (`HostSafetyError.reason`, one of `HOST_SAFETY_REFUSAL`).
 * - Inherited `TMUX_TMPDIR`: which inherited values `inheritedChildTmuxTmpDir`
 *   reuses, and a `bun` child that loads the helper again reusing its
 *   parent's directory.
 * - `runInFakeHome`: refuses the real home before any child starts.
 * - Static audits (b.jg5 SRJ-1301), read with the TypeScript parser
 *   so strings, regex literals and comments never count: no value import of
 *   `Client` / `resolveSystemBinary` from `agent-director`; every child
 *   process call's `env` is a direct `hostSafeChildEnv` call; no file imports
 *   the preload guard, and the repository root and every directory holding a
 *   test file have a `bunfig.toml` whose first `[test]` preload entry loads
 *   it with a path Bun resolves from the directory the run starts in (later
 *   entries allowed, so no other preload runs first); the preload's first
 *   statement after its imports is the launch-home refusal loop
 *   (`launchHomeRefusal(<home>, passwdHome(), LIVE_LAUNCH_HOME_PROBE)` over
 *   `launchTimeHomes()`, exiting with `LAUNCH_HOME_REFUSED_EXIT_CODE`); the
 *   preload loads only `node:` builtins and `./host-safe-env.ts`, and
 *   `host-safe-env.ts` only `node:` builtins, in any load form, so no `src/`,
 *   package or other helper code runs before the refusal; only
 *   the guard's own files (`REAL_HOME_FILES`) reference `realHome` or
 *   `passwdHome`, the helpers that answer the real home's path. The
 *   value-import matcher (`agentDirectorValueReads`) lives in
 *   `tests/test-helpers/ad-value-reads.ts`, which
 *   `tests/fmk-source-audit.test.ts` shares. Each matcher is pinned with
 *   synthetic flagged and allowed sources, then run over the tree.
 * - SRJ-121's call-site audit over every `*.ts` in `src/` and `scripts/`
 *   (`CALL_SITE_AUDITS`, the same parser): `Client.create` is reached only in
 *   the startup gate's module, `runStartupGate` is referenced only there and
 *   in the CLI, `runAgentDirectorStartupGate` only in the server, and
 *   agent-director's `resolveSystemBinary` is held as a value only in the
 *   server, the install check and `/publish`'s check. Each pinned file must
 *   still hold its site. (That `src/ad-version-gate.ts` never imports
 *   `./install-check.ts` is pinned in tests/ad-version-gate.test.ts.)
 * - The `/ci` image refusals (b.jg5 SRJ-1306), read and never run:
 *   `tests/runner.sh`, `tests/integration/lib/scenario.sh` and each
 *   `tests/integration/test-*.sh` that does not source it (found from the
 *   directory) check `/etc/cscb-ci-image` before their first other step; each
 *   script that sources scenario.sh runs nothing before its source line;
 *   `fmk-driver.ts`, `stub-mcp-session.ts`, `switch-over.ts` and
 *   `fmk-texts.ts` (a listed set) each check the marker first and
 *   statically import only `node:` built-ins, type-only imports included; and every scenario.sh function
 *   with a step (sqlite3, a copy, move or install, an install.sh run, or a
 *   run of agent-director by its path or a variable holding one; a call of a
 *   scenario.sh function with a step counting as one), found from the file,
 *   calls `require_scenario_home` before its first, less two commented
 *   lists: `HOME_CHECK_EXEMPT` (primitives, setup and shared-mode helpers)
 *   and `HOME_CHECKED_BY_CALLERS` (private helpers that every place
 *   scenario.sh names runs after an audited helper's check, and no script
 *   names). Shell is read with comments, heredoc bodies and quoted text
 *   blanked; the shebang, comments, blank lines, `set` options and literal
 *   assignments are not steps. Each rule is pinned with synthetic violations
 *   (each finding names its file and rule) and allowed sources, then run over
 *   the tree. scenario.sh's settings writers resolve their directory with
 *   `realpath -e` (the SCENARIO_ROOT containment check) before they write
 *   there: `write_ad_settings` before its `rm` and its `mkdir`,
 *   `_scenario_stand_in_settings` before its `write_file`.
 * - scenario.sh's Slack stub and stub MCP session helpers (harness additions,
 *   b.jg5 SRJ-1306, b.deo SRI-1404), read and never run: `slack_stub_push`,
 *   `stub_session_deliveries` and `stub_session_call`
 *   (`IMAGE_GUARDED_STUB_HELPERS`) each run `require_ci_image`, called
 *   directly, as their first command after their declarations and outside any
 *   `if`, `||`, pipeline, background or subshell, and none runs
 *   `require_scenario_home`, nor any function it calls (they work in shared
 *   mode, which has no scenario HOME). `/ci` always carries the marker,
 *   so this pin is the only proof of their refusal. Read with the shell reader
 *   above, pinned with synthetic violations, then run over the tree, and over
 *   the tree with one helper's guard removed or moved into an `if`.
 * - The Slack stub `slack-stub-server.ts` (b.jg5 SRJ-1306, b.deo SRI-1402)
 *   statically imports only `node:` built-ins, type-only imports included,
 *   through the image-guarded fixtures' matcher (`nodeOnlyImportFindings`).
 *   It has no marker check, so it is not one of `IMAGE_GUARDED_TS_PATHS`.
 * - The harness's one agent-director delete (b.jg5 SRJ-1306), over every
 *   file under `tests/integration` (shell or TypeScript, shellcheck's and
 *   bun's config aside): in shell, any command whose first argument after
 *   agent-director's global flags is `delete`, whatever its name but
 *   scenario.sh's three shim-log readers (which run no agent-director); in
 *   TypeScript, a `client-delete`
 *   call (tests/fmk-source-audit.test.ts's receiver rule) or a `'delete'`
 *   string. The only one is scenario.sh's `ad_delete_unusable_row`, which
 *   runs agent-director-admin's `delete` (0.11.0 moved it there) through
 *   `ad_admin_capture`.
 * - Preload check: the shared `preloadCheckFailures` (the one the preload
 *   guard runs), each failure label (`PRELOAD_CHECK`) pinned with a row.
 * - Preload redirect: the shared, side-effect-free `preloadRedirectedEnv`
 *   on dirty inherited environments (a `PATH` directory holding an
 *   `agent-director` file or dangling symlink, duplicate, empty, relative and
 *   `.` entries, `TMUX` / `TMUX_PANE` / `CLAUDE_CONFIG_DIR` set, a foreign
 *   `TMUX_TMPDIR`, a stray `SLACK_STATE_DIR` or HOME), each output asserted
 *   exactly and passing the check.
 * - A non-normalized `TMPDIR` (`/tmp//`, `/tmp/.`, `/tmp/../tmp`), in a
 *   `bun` child started with it: `osTempDir()` normalizes it, and
 *   `TMUX_TMPDIR` reuse, the check and the redirect still hold.
 * - Un-injected gate checks: one case checks that the
 *   preload guard applied (every name in `PRELOAD_ENV_NAMES`, pinned there)
 *   and only then calls `runStartupGate()`
 *   and `runInstallCheck()` with their defaults, which must fail as not found.
 *
 * Isolation: every case writes only under its own `mkdtempSync` root, except
 * `hostSafeChildEnv`'s one `TMUX_TMPDIR` directory and the few entries the
 * inherited-`TMUX_TMPDIR` cases must place directly under the OS temp
 * directory: prefixed entries named after the root (`tempEntry`), new
 * `mkdtempSync` directories on the bare prefix with a random suffix
 * (`prefixedTempDir()`), and the bare-prefix directory itself, made only when
 * absent. Each entry a case made is removed in `afterEach`; a bare-prefix
 * directory already there is neither touched nor removed. One case
 * starts a `bun` child (`process.execPath`, environment from
 * `hostSafeChildEnv` with a HOME under the root) that runs only the helper;
 * the `TMPDIR` cases start one such child each.
 * The real-home cases pass `realHome()` (or a symlink to it made under the
 * root) and are refused before anything under it is looked at. Every
 * `agent-director` entry a case makes is a plain, non-executable file or a
 * dangling symlink. `process.env.PATH` and `process.env.TMUX_TMPDIR`, which
 * some cases point elsewhere, are restored in `afterEach`. The install path,
 * binary name and `TMUX_TMPDIR` prefix come from the helper. The audits only
 * read repository files (none under `node_modules`). The preload-check,
 * redirect and `TMPDIR` cases make prefixed HOME directories directly under the OS temp
 * directory (`preloadTempHome()`) and one `CHILD_TMUX_TMPDIR_PREFIX`
 * directory there per case that needs another fenced `TMUX_TMPDIR`, removed
 * in `afterEach`; they
 * reuse the process's own `TMUX_TMPDIR` (`childTmuxTmpDir()`) and never set a
 * `TMUX` value in `process.env`. The preload check
 * and the gate calls start no process: the check is `lstat`s, and with the
 * preload's HOME and PATH the client's discovery finds no candidate, so it
 * throws `ErrSystemInstallNotFound` before its version probe could start one.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import {
  AGENT_DIRECTOR_BINARY_NAME,
  AGENT_DIRECTOR_INSTALL_DIR,
  AGENT_DIRECTOR_INSTALL_PATH,
  CHILD_TMUX_TMPDIR_PREFIX,
  DEFAULT_CHILD_TOOLS,
  EMPTY_CHILD_PATH,
  HOST_SAFETY_REFUSAL,
  HostSafetyError,
  type HostSafeChildEnvOptions,
  type HostSafetyRefusal,
  PRELOAD_CHECK,
  PRELOAD_ENV_NAMES,
  PRELOAD_HOME_PREFIX,
  PRELOAD_STATE_DIR_PATH,
  type PreloadCheckFailure,
  type PreloadEnv,
  RESERVED_CHILD_ENV_NAMES,
  childTmuxTmpDir,
  hostSafeChildEnv,
  inheritedChildTmuxTmpDir,
  isUnder,
  osTempDir,
  preloadCheckFailures,
  preloadRedirectedEnv,
  realHome,
  resolveToolDir,
} from './test-helpers/host-safe-env.ts'
import {
  AD_NS,
  agentDirectorValueReads,
  finding,
  forEachNode,
  isPromiseMemberUse,
  moduleLoadOf,
  outermost,
  propertyNameText,
  stringText,
  unwrap,
} from './test-helpers/ad-value-reads.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { treeSnapshot } from './test-helpers/tree-snapshot.ts'
import { runStartupGate } from '../src/agent-director-startup.ts'
import { AD_SYSTEM_INSTALL_NOT_FOUND, resetCacheForTests, runInstallCheck } from '../src/install-check.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HELPER_PATH = join(import.meta.dir, 'test-helpers', 'host-safe-env.ts')

let root: string
let savedPath: string | undefined
let savedTmuxTmpDir: string | undefined
/** Entries a case placed directly under the OS temp directory; removed in `afterEach`. */
let outsideRoot: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'host-safety-test-'))
  savedPath = process.env['PATH']
  savedTmuxTmpDir = process.env['TMUX_TMPDIR']
  outsideRoot = []
})

afterEach(() => {
  if (savedPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = savedPath
  if (savedTmuxTmpDir === undefined) delete process.env['TMUX_TMPDIR']
  else process.env['TMUX_TMPDIR'] = savedTmuxTmpDir
  for (const path of outsideRoot) rmSync(path, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

/** A new empty directory under the case's root. */
function dirUnder(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A plain, non-executable file at `path` (parents created). */
function plainFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '', { mode: 0o644 })
}

/** An executable file at `path` that a case only lets `PATH` lookups find; never run. */
function fakeToolFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
}

/** The directory each tool resolves to on the current `PATH` (the test run's). */
function toolDirs(tools: readonly string[]): string[] {
  return tools.map((tool) => {
    const dir = resolveToolDir(tool)
    if (dir === undefined) throw new Error(`test host has no ${tool} on PATH`)
    return dir
  })
}

/** The `HostSafetyError` `fn` throws; fails the case when it returns or throws anything else. */
function refusalOf(fn: () => unknown): HostSafetyError {
  let thrown: unknown
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(HostSafetyError)
  return thrown as HostSafetyError
}

// ---------------------------------------------------------------------------
// hostSafeChildEnv
// ---------------------------------------------------------------------------

describe('hostSafeChildEnv', () => {
  test('returns only HOME, PATH, TMUX_TMPDIR and the extras, with HOME as given', () => {
    const home = dirUnder('home')
    const env = hostSafeChildEnv(home, { extras: { SLACK_STATE_DIR: join(root, 'state') } })

    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'SLACK_STATE_DIR', 'TMUX_TMPDIR'])
    expect(env.HOME).toBe(home)
    expect(env['SLACK_STATE_DIR']).toBe(join(root, 'state'))
  })

  test('PATH holds the default tools’ directories when no tools are named', () => {
    const env = hostSafeChildEnv(dirUnder('home'))

    expect(env.PATH.split(delimiter)).toEqual([...new Set(toolDirs(DEFAULT_CHILD_TOOLS))])
  })

  test('PATH holds the caller’s directories first, in order, then the named tools’ directories, duplicates dropped', () => {
    const stubA = dirUnder('stub-a')
    const stubB = dirUnder('stub-b')
    const env = hostSafeChildEnv(dirUnder('home'), { pathDirs: [stubA, stubB, stubA], tools: ['sh'] })

    expect(env.PATH.split(delimiter)).toEqual([stubA, stubB, ...toolDirs(['sh'])])
  })

  test('PATH is EMPTY_CHILD_PATH when there are no tools and no caller directories', () => {
    expect(hostSafeChildEnv(dirUnder('home'), { tools: [] }).PATH).toBe(EMPTY_CHILD_PATH)
  })

  test('TMUX_TMPDIR is one existing directory under the OS temp directory, the same on every call, outside HOME', () => {
    const home = dirUnder('home')
    const first = hostSafeChildEnv(home).TMUX_TMPDIR
    const second = hostSafeChildEnv(dirUnder('other-home'), { tools: [] }).TMUX_TMPDIR

    expect(second).toBe(first)
    expect(statSync(first).isDirectory()).toBe(true)
    expect(dirname(first)).toBe(osTempDir())
    expect(basename(first).startsWith(CHILD_TMUX_TMPDIR_PREFIX)).toBe(true)
    expect(isUnder(first, home)).toBe(false)
    expect(isUnder(first, realHome())).toBe(false)
  })

  test('leaves the given HOME unchanged', () => {
    const home = dirUnder('home')
    plainFile(join(home, '.claude', 'settings.json'))
    const before = treeSnapshot(home)

    hostSafeChildEnv(home, { pathDirs: [dirUnder('stub')], extras: { SLACK_STATE_DIR: join(root, 'state') } })

    expect(treeSnapshot(home)).toEqual(before)
  })

  // Each row builds its fixture under the case's root and returns the call's arguments.
  type RefusalRow = [label: string, reason: HostSafetyRefusal, build: () => { home: string; options?: HostSafeChildEnvOptions }]

  const refusals: RefusalRow[] = [
    ['HOME is relative', HOST_SAFETY_REFUSAL.homeNotAbsolute, () => ({ home: 'home' })],
    ['HOME is the real home', HOST_SAFETY_REFUSAL.realHome, () => ({ home: realHome() })],
    ['HOME is a symlink to the real home', HOST_SAFETY_REFUSAL.realHome, () => {
      const link = join(root, 'home-link')
      symlinkSync(realHome(), link)
      return { home: link }
    }],
    ['HOME is the home the run started with', HOST_SAFETY_REFUSAL.realHome, () => ({ home: homedir() })],
    ['HOME holds an agent-director install directory with no binary in it', HOST_SAFETY_REFUSAL.homeHoldsInstall, () => {
      const home = dirUnder('home')
      mkdirSync(join(home, AGENT_DIRECTOR_INSTALL_DIR))
      return { home }
    }],
    ['HOME holds the standard install path (a plain file)', HOST_SAFETY_REFUSAL.homeHoldsInstall, () => {
      const home = dirUnder('home')
      plainFile(join(home, AGENT_DIRECTOR_INSTALL_PATH))
      return { home }
    }],
    ['a caller PATH directory holds an agent-director file', HOST_SAFETY_REFUSAL.pathDirHoldsAgentDirector, () => {
      const stub = dirUnder('stub')
      plainFile(join(stub, AGENT_DIRECTOR_BINARY_NAME))
      return { home: dirUnder('home'), options: { pathDirs: [stub] } }
    }],
    ['a caller PATH directory holds a dangling agent-director symlink', HOST_SAFETY_REFUSAL.pathDirHoldsAgentDirector, () => {
      const stub = dirUnder('stub')
      symlinkSync(join(root, 'no-such-target'), join(stub, AGENT_DIRECTOR_BINARY_NAME))
      return { home: dirUnder('home'), options: { pathDirs: [stub] } }
    }],
    ['a tool’s own PATH directory holds an agent-director file', HOST_SAFETY_REFUSAL.pathDirHoldsAgentDirector, () => {
      // The fake tool's directory is the whole PATH, so it is where the tool resolves.
      const bin = dirUnder('bin')
      const tool = `fake-tool-${basename(root)}`
      fakeToolFile(join(bin, tool))
      plainFile(join(bin, AGENT_DIRECTOR_BINARY_NAME))
      process.env['PATH'] = bin
      expect(resolveToolDir(tool)).toBe(bin)
      return { home: dirUnder('home'), options: { tools: [tool] } }
    }],
    ['a caller PATH directory is relative', HOST_SAFETY_REFUSAL.invalidPathDir, () => ({
      home: dirUnder('home'),
      options: { pathDirs: ['stub'] },
    })],
    ['a tool cannot be found', HOST_SAFETY_REFUSAL.toolNotFound, () => ({
      home: dirUnder('home'),
      // The root's own random name, so no host has a tool called that.
      options: { tools: [`missing-${root.split('/').pop()}`] },
    })],
    ['a tool name holds a slash', HOST_SAFETY_REFUSAL.invalidToolName, () => ({
      home: dirUnder('home'),
      options: { tools: ['bin/sh'] },
    })],
    ['an extra is not a string', HOST_SAFETY_REFUSAL.invalidExtra, () => ({
      home: dirUnder('home'),
      options: { extras: { SLACK_STATE_DIR: 1 as unknown as string } },
    })],
    ...RESERVED_CHILD_ENV_NAMES.map((name): RefusalRow => [
      `an extra sets reserved ${name}`,
      HOST_SAFETY_REFUSAL.reservedExtra,
      () => ({ home: dirUnder('home'), options: { extras: { [name]: join(root, 'other') } } }),
    ]),
  ]

  test.each(refusals)('refuses when %s (%s)', (_label, reason, build) => {
    const { home, options } = build()

    expect(refusalOf(() => hostSafeChildEnv(home, options)).reason).toBe(reason)
  })
})

// ---------------------------------------------------------------------------
// Inherited TMUX_TMPDIR
// ---------------------------------------------------------------------------

describe('inherited TMUX_TMPDIR', () => {
  /** A path directly under the OS temp directory, named after the case's root; removed in `afterEach`. */
  function tempEntry(name: string): string {
    const path = join(tmpdir(), name)
    outsideRoot.push(path)
    return path
  }

  /** A new directory directly under the OS temp directory whose name carries the prefix, as a parent's helper makes it. */
  function prefixedTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), CHILD_TMUX_TMPDIR_PREFIX))
    outsideRoot.push(dir)
    return dir
  }

  test('an inherited TMUX_TMPDIR naming an existing prefixed directory directly under the OS temp directory is reused', () => {
    const inherited = prefixedTempDir()
    process.env['TMUX_TMPDIR'] = inherited

    expect(inheritedChildTmuxTmpDir()).toBe(inherited)
    expect(inheritedChildTmuxTmpDir(inherited)).toBe(inherited)
  })

  // Each row builds its fixture and returns the inherited value.
  type NotReusedRow = [label: string, build: () => string | undefined]

  const notReused: NotReusedRow[] = [
    ['unset', () => undefined],
    ['empty', () => ''],
    ['relative', () => `${CHILD_TMUX_TMPDIR_PREFIX}${basename(root)}`],
    ['an existing directory directly under the OS temp directory without the prefix', () => root],
    ['a prefixed path directly under the OS temp directory that does not exist', () => tempEntry(`${CHILD_TMUX_TMPDIR_PREFIX}${basename(root)}-missing`)],
    ['the bare prefix, a directory directly under the OS temp directory', () => {
      // Made (and later removed) only when absent, so nothing already there is touched.
      const dir = join(tmpdir(), CHILD_TMUX_TMPDIR_PREFIX)
      if (!existsSync(dir)) {
        mkdirSync(dir)
        outsideRoot.push(dir)
      }
      return dir
    }],
    ['an existing prefixed directory that is not directly under the OS temp directory', () => dirUnder(`${CHILD_TMUX_TMPDIR_PREFIX}nested`)],
    ['a prefixed plain file directly under the OS temp directory', () => {
      const path = tempEntry(`${CHILD_TMUX_TMPDIR_PREFIX}${basename(root)}-file`)
      writeFileSync(path, '')
      return path
    }],
    ['a prefixed symlink to a directory, directly under the OS temp directory', () => {
      const path = tempEntry(`${CHILD_TMUX_TMPDIR_PREFIX}${basename(root)}-link`)
      symlinkSync(dirUnder('link-target'), path)
      return path
    }],
  ]

  test.each(notReused)('an inherited TMUX_TMPDIR that is %s is not reused', (_label, build) => {
    const value = build()
    if (value === undefined) delete process.env['TMUX_TMPDIR']
    else process.env['TMUX_TMPDIR'] = value

    expect(inheritedChildTmuxTmpDir()).toBeUndefined()
    expect(inheritedChildTmuxTmpDir(value)).toBeUndefined()
  })

  test('a bun child that loads the helper again hands its own children the parent’s TMUX_TMPDIR', () => {
    const home = dirUnder('home')
    const childHome = dirUnder('child-home')
    const script = `
      const { hostSafeChildEnv } = await import(${JSON.stringify(HELPER_PATH)});
      process.stdout.write(JSON.stringify({ inherited: process.env.TMUX_TMPDIR, own: hostSafeChildEnv(${JSON.stringify(childHome)}, { tools: [] }).TMUX_TMPDIR }));
    `
    // TMPDIR is passed so the child's OS temp directory is this process's on any host.
    const child = spawnSync(process.execPath, ['-e', script], {
      env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: tmpdir() } }),
      encoding: 'utf-8',
      timeout: 30_000,
    })
    const parentDir = hostSafeChildEnv(home, { tools: [] }).TMUX_TMPDIR

    expect(child.stderr).toBe('')
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({ inherited: parentDir, own: parentDir })
  })
})

// ---------------------------------------------------------------------------
// runInFakeHome
// ---------------------------------------------------------------------------

describe('runInFakeHome', () => {
  test('throws for the real home before any child starts', () => {
    // A child that ran would import this module first, and importing it writes the marker.
    const marker = join(root, 'child-ran')
    const modulePath = join(root, 'marker-module.ts')
    writeFileSync(modulePath, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')\n`)

    // runInFakeHome's own refusal, not hostSafeChildEnv's (which would come later).
    expect(() => runInFakeHome({ modulePath, call: '', input: null, home: realHome(), stateDir: dirUnder('state') })).toThrow(/^runInFakeHome: .*not the real home/)
    expect(existsSync(marker)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Static audits: parsing and file sets
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, '..')
const TESTS_DIR = import.meta.dir
const TEST_HELPERS_DIR = join(TESTS_DIR, 'test-helpers')
const SRC_DIR = join(REPO_ROOT, 'src')
const PRELOAD_PATH = join(TEST_HELPERS_DIR, 'host-safety-preload.ts')

/** Names a test may not hold as values from agent-director: they find and run the real binary. */
const DISCOVERY_NAMES: readonly string[] = ['Client', 'resolveSystemBinary']
const CHILD_PROCESS_MODULES: readonly string[] = ['child_process', 'node:child_process']
/** The `child_process` functions that start a process. */
const CHILD_PROCESS_FUNCTIONS: readonly string[] = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
/** The `Bun` members (and `bun` module exports) that start a process. */
const BUN_PROCESS_MEMBERS: readonly string[] = ['spawn', 'spawnSync', '$']
/** File names `bun test` runs as test files. */
const BUN_TEST_FILE = /(?:\.|_)(?:test|spec)\.(?:ts|tsx|js|jsx)$/
/** Script files an import can name. */
const SCRIPT_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** `source` parsed as TypeScript, with parent links. */
function parse(source: string, fileName = 'synthetic.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** Every regular file under `dir` (`node_modules` and `.git` skipped) that `keep` accepts. */
function filesUnder(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(path, keep, out)
    else if (entry.isFile() && keep(path)) out.push(path)
  }
  return out
}

const parsedFiles = new Map<string, ts.SourceFile>()

/** The repository file at `path`, parsed once per run. */
function parseFile(path: string): ts.SourceFile {
  let sf = parsedFiles.get(path)
  if (sf === undefined) {
    sf = parse(readFileSync(path, 'utf-8'), path)
    parsedFiles.set(path, sf)
  }
  return sf
}

/** Every finding of `audit` over `files`, each prefixed with the file's repository-relative path. */
function auditTree(files: readonly string[], audit: (sf: ts.SourceFile, path: string) => string[]): string[] {
  return files.flatMap((path) => audit(parseFile(path), path).map((f) => `${relative(REPO_ROOT, path)}:${f}`))
}

/** Every file host `bun test` runs (any test file name, `node_modules` excluded) and every helper in `tests/test-helpers/`. */
function hostTestFiles(): string[] {
  const tests = filesUnder(REPO_ROOT, (path) => BUN_TEST_FILE.test(basename(path)))
  const helpers = filesUnder(TEST_HELPERS_DIR, (path) => SCRIPT_FILE.test(path))
  return [...new Set([...tests, ...helpers])].sort()
}

// ---------------------------------------------------------------------------
// Static audit: value imports of Client / resolveSystemBinary
// ---------------------------------------------------------------------------

/**
 * Where `sf` holds `Client` or `resolveSystemBinary` from agent-director as a
 * value. Flagged: a named value import (aliased or not) or re-export of either,
 * `export *` from agent-director, and a read of either through the module
 * namespace (a static namespace or default import, `import x = require`, a
 * dynamic `import()` or `require()`, or a copy of one: `const x = ns`,
 * `const x = { ...ns }`, a destructuring rest): a property or element read,
 * a computed element read, or destructuring (declaration or assignment). A
 * dynamic load used any other way (e.g. `.then(...)`) is flagged as a form
 * the audit cannot follow. Every such read is flagged, an `expect(...)`
 * operand included. Allowed: type-only imports and re-exports (whole-statement
 * or inline), `import('agent-director').X` in a type, spreading the namespace
 * (into a `mock.module` factory, say), and other names.
 */
function discoveryValueFindings(sf: ts.SourceFile): string[] {
  return agentDirectorValueReads(sf, DISCOVERY_NAMES).map((read) => finding(sf, read.node, read.what))
}

// ---------------------------------------------------------------------------
// Static audit: child process environments
// ---------------------------------------------------------------------------

/** What `childProcessAudit` found in one file. */
interface ChildProcessAudit {
  /** Child process calls found (accepted or not). */
  calls: number
  /** The calls (and uncalled references) the audit refuses. */
  findings: string[]
}

/** Whether `node` sits in a `typeof x` type query. */
function inTypeQuery(node: ts.Node): boolean {
  let at = node.parent
  while (at !== undefined && ts.isQualifiedName(at)) at = at.parent
  return at !== undefined && ts.isTypeQueryNode(at)
}

/**
 * Every child process call in `sf` and whether its environment is accepted.
 * Calls: the `child_process` functions the file imports (named, aliased,
 * through a namespace or default import, `import x = require`, a dynamic
 * `import()` or `require()`, or destructured from one of those), `Bun.spawn`,
 * `Bun.spawnSync` and `Bun.$` (also as `spawn`, `spawnSync`, `$` imported from
 * `bun`). Accepted: the call's options argument is an object literal with no
 * spread whose one `env` property is a direct call of `hostSafeChildEnv`
 * imported from the `host-safe-env` helper; for `Bun.$`, the template is
 * immediately followed by `.env(hostSafeChildEnv(...))`. Also refused: a
 * child process function referenced without being called (passed on, put in
 * an object, re-exported), and a dynamic load of `child_process` used in a
 * form the audit cannot follow. Method calls on other objects (a stub's or
 * client's `spawn`, a `RegExp`'s `exec`) are not calls.
 */
function childProcessAudit(sf: ts.SourceFile): ChildProcessAudit {
  const findings: string[] = []
  const flag = (node: ts.Node, what: string): void => {
    findings.push(finding(sf, node, what))
  }
  let calls = 0
  /** Local name → the function it is (`spawnSync`, `Bun.spawn`, …). */
  const functions = new Map<string, string>()
  const cpNamespaces = new Set<string>()
  const bunNamespaces = new Set<string>(['Bun'])
  const envHelpers = new Set<string>()

  const isCpNamespace = (expr: ts.Expression): boolean => {
    const inner = unwrap(expr)
    const loaded = moduleLoadOf(inner)
    return (ts.isIdentifier(inner) && cpNamespaces.has(inner.text)) || (loaded !== undefined && CHILD_PROCESS_MODULES.includes(loaded))
  }
  const isBunNamespace = (expr: ts.Expression): boolean => {
    const inner = unwrap(expr)
    return ts.isIdentifier(inner) && bunNamespaces.has(inner.text)
  }
  /** The function `expr` names when it is a member of child_process or Bun, else undefined. */
  const memberFunction = (expr: ts.Node): string | undefined => {
    if (!ts.isPropertyAccessExpression(expr) && !ts.isElementAccessExpression(expr)) return undefined
    const name = ts.isPropertyAccessExpression(expr) ? expr.name.text : stringText(expr.argumentExpression)
    if (name === undefined) return undefined
    if (isCpNamespace(expr.expression) && CHILD_PROCESS_FUNCTIONS.includes(name)) return name
    if (isBunNamespace(expr.expression) && BUN_PROCESS_MEMBERS.includes(name)) return `Bun.${name}`
    return undefined
  }
  const bindPattern = (pattern: ts.ObjectBindingPattern, prefix: string, names: readonly string[]): void => {
    for (const el of pattern.elements) {
      const name = propertyNameText(el.propertyName ?? el.name)
      if (name !== undefined && names.includes(name) && ts.isIdentifier(el.name)) functions.set(el.name.text, `${prefix}${name}`)
    }
  }

  // Bindings.
  forEachNode(sf, (node) => {
    if (ts.isImportDeclaration(node)) {
      const from = stringText(node.moduleSpecifier)
      const clause = node.importClause
      if (from === undefined || clause === undefined || clause.isTypeOnly) return
      const bindings = clause.namedBindings
      if (CHILD_PROCESS_MODULES.includes(from)) {
        if (clause.name !== undefined) cpNamespaces.add(clause.name.text)
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) cpNamespaces.add(bindings.name.text)
      } else if (from === 'bun') {
        if (clause.name !== undefined) bunNamespaces.add(clause.name.text)
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) bunNamespaces.add(bindings.name.text)
      }
      if (bindings === undefined || !ts.isNamedImports(bindings)) return
      for (const el of bindings.elements) {
        if (el.isTypeOnly) continue
        const imported = (el.propertyName ?? el.name).text
        if (CHILD_PROCESS_MODULES.includes(from) && CHILD_PROCESS_FUNCTIONS.includes(imported)) functions.set(el.name.text, imported)
        else if (from === 'bun' && BUN_PROCESS_MEMBERS.includes(imported)) functions.set(el.name.text, `Bun.${imported}`)
        else if (imported === 'hostSafeChildEnv' && from.startsWith('.') && /(?:^|\/)host-safe-env(?:\.ts)?$/.test(from)) envHelpers.add(el.name.text)
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const from = stringText(node.moduleReference.expression)
      if (from !== undefined && CHILD_PROCESS_MODULES.includes(from)) cpNamespaces.add(node.name.text)
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const init = unwrap(node.initializer)
      const loaded = moduleLoadOf(init)
      const isCpLoad = loaded !== undefined && CHILD_PROCESS_MODULES.includes(loaded)
      if (ts.isIdentifier(node.name) && isCpLoad) cpNamespaces.add(node.name.text)
      else if (ts.isObjectBindingPattern(node.name) && isCpNamespace(init)) bindPattern(node.name, '', CHILD_PROCESS_FUNCTIONS)
      else if (ts.isObjectBindingPattern(node.name) && isBunNamespace(init)) bindPattern(node.name, 'Bun.', BUN_PROCESS_MEMBERS)
    }
  })

  const isDirectHelperCall = (value: ts.Expression): boolean =>
    ts.isCallExpression(value) && ts.isIdentifier(value.expression) && envHelpers.has(value.expression.text)
  const envFinding = (options: ts.Expression | undefined): string | undefined => {
    if (options === undefined) return 'no options: the child inherits the environment'
    if (!ts.isObjectLiteralExpression(options)) return 'options are not an object literal'
    if (options.properties.some((p) => ts.isSpreadAssignment(p))) return 'options spread into the call'
    const envs = options.properties.filter((p) => propertyNameText(p.name) === 'env')
    if (envs.length === 0) return 'no env option: the child inherits the environment'
    if (envs.length > 1) return 'more than one env option'
    const env = envs[0]!
    return ts.isPropertyAssignment(env) && isDirectHelperCall(env.initializer) ? undefined : 'env is not a direct hostSafeChildEnv call'
  }
  const optionsOf = (fn: string, call: ts.CallExpression): ts.Expression | undefined => {
    const args = [...call.arguments]
    while (args.length > 1 && (ts.isArrowFunction(unwrap(args.at(-1)!)) || ts.isFunctionExpression(unwrap(args.at(-1)!)))) args.pop()
    if (fn === 'Bun.spawn' || fn === 'Bun.spawnSync') return args.length === 1 && ts.isObjectLiteralExpression(unwrap(args[0]!)) ? args[0] : args[1]
    if (fn === 'exec' || fn === 'execSync') return args[1]
    if (args.length >= 3) return args[2]
    return args.length === 2 && !ts.isArrayLiteralExpression(unwrap(args[1]!)) ? args[1] : undefined
  }
  const checkTemplate = (tagged: ts.TaggedTemplateExpression): void => {
    calls++
    const member = tagged.parent
    const call = member?.parent
    const ok = member !== undefined && ts.isPropertyAccessExpression(member) && member.expression === tagged && member.name.text === 'env'
      && call !== undefined && ts.isCallExpression(call) && call.expression === member && call.arguments.length === 1
      && isDirectHelperCall(call.arguments[0]!)
    if (!ok) flag(tagged, 'Bun.$ without .env(hostSafeChildEnv(...)): the child inherits the environment')
  }

  // Calls and uncalled references.
  forEachNode(sf, (node) => {
    const loaded = moduleLoadOf(node)
    if (loaded !== undefined && CHILD_PROCESS_MODULES.includes(loaded)) {
      const outer = outermost(node)
      const context = outer.parent
      const followed = !isPromiseMemberUse(node as ts.CallExpression) && ((ts.isVariableDeclaration(context) && context.initializer === outer && (ts.isIdentifier(context.name) || ts.isObjectBindingPattern(context.name)))
        || ((ts.isPropertyAccessExpression(context) || ts.isElementAccessExpression(context)) && context.expression === outer)
        || ts.isSpreadAssignment(context))
      if (!followed) flag(node, 'child_process loaded in a form the audit cannot follow')
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      const fn = ts.isIdentifier(callee) ? functions.get(callee.text) : memberFunction(callee)
      if (fn === undefined || fn === 'Bun.$') return
      calls++
      const problem = envFinding(optionsOf(fn, node))
      if (problem !== undefined) flag(node, `${fn}: ${problem}`)
    } else if (ts.isTaggedTemplateExpression(node)) {
      const tag = unwrap(node.tag)
      const fn = ts.isIdentifier(tag) ? functions.get(tag.text) : memberFunction(tag)
      if (fn === 'Bun.$') checkTemplate(node)
    } else if (ts.isIdentifier(node) && functions.has(node.text)) {
      const parent = node.parent
      const isCallee = (ts.isCallExpression(parent) || ts.isTaggedTemplateExpression(parent)) && (ts.isCallExpression(parent) ? parent.expression : parent.tag) === node
      const isDeclaredName = !ts.isShorthandPropertyAssignment(parent) && !ts.isExportSpecifier(parent) && ((parent as { name?: ts.Node }).name === node || (ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) && parent.propertyName === node)
      if (!isCallee && !isDeclaredName && !inTypeQuery(node)) flag(node, `${functions.get(node.text)} referenced without being called`)
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && memberFunction(node) !== undefined) {
      const parent = outermost(node).parent
      const isCallee = (ts.isCallExpression(parent) && unwrap(parent.expression) === node) || (ts.isTaggedTemplateExpression(parent) && unwrap(parent.tag) === node)
      if (!isCallee && !inTypeQuery(node)) flag(node, `${memberFunction(node)} referenced without being called`)
    }
  })
  return { calls, findings }
}

// ---------------------------------------------------------------------------
// Static audit: the preload guard is loaded by bunfig.toml and imported by no file
// ---------------------------------------------------------------------------

/** Whether the relative `specifier`, written in the file at `fromFile`, names `target` (with or without its extension). */
function specifierNames(specifier: string, fromFile: string, target: string): boolean {
  if (!specifier.startsWith('.')) return false
  const path = resolve(dirname(fromFile), specifier)
  return path === target || path === target.replace(/\.[cm]?[jt]sx?$/, '') || join(path, 'index.ts') === target
}

/**
 * Where the file at `path` loads `target`: a static import (side-effect only
 * too), an `export … from`, `import x = require`, a dynamic `import()` or a
 * `require()`, with a relative specifier that resolves to it. Strings and
 * comments that name it are not loads.
 */
function importsOfFile(sf: ts.SourceFile, path: string, target: string): string[] {
  const findings: string[] = []
  forEachNode(sf, (node) => {
    let specifier: string | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = stringText(node.moduleSpecifier)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = stringText(node.moduleReference.expression)
    else specifier = moduleLoadOf(node)
    if (specifier !== undefined && specifierNames(specifier, path, target)) findings.push(finding(sf, node, `loads ${relative(REPO_ROOT, target)}`))
  })
  return findings
}

/** Whether a preload entry is a path to Bun: `./…`, `../…` or absolute (a bare `a/b.ts` is looked up as a package and not found). */
const PRELOAD_PATH_ENTRY = /^(?:\.{1,2}\/|\/)/

/**
 * Why the `bunfig.toml` text `toml`, read by a `bun test` started in
 * `baseDir`, does not load `preload` before the tests and every other
 * preload: its `[test]` table's `preload` (a string or a list) must name it
 * first, with a path entry (`PRELOAD_PATH_ENTRY`) that resolves to it from
 * `baseDir` (Bun resolves a relative preload against the working directory,
 * not the bunfig's own). Entries after it are allowed; one before it would
 * run before the refusal.
 */
function bunfigPreloadFindings(toml: string, baseDir: string, preload: string): string[] {
  const config = Bun.TOML.parse(toml) as { test?: { preload?: unknown } }
  const entries = config.test?.preload
  const first: unknown = typeof entries === 'string' ? entries : Array.isArray(entries) ? entries[0] : undefined
  if (typeof first === 'string' && PRELOAD_PATH_ENTRY.test(first) && resolve(baseDir, first) === preload) return []
  return [`[test] preload does not name ${relative(baseDir, preload)} first`]
}

/**
 * Every directory `bun test` could be started in to run this repository's
 * tests: the repository root and each directory holding a test file
 * (`BUN_TEST_FILE`, `node_modules` and `.git` skipped), sorted.
 */
function testStartDirs(): string[] {
  const dirs = new Set([REPO_ROOT, ...filesUnder(REPO_ROOT, (path) => BUN_TEST_FILE.test(basename(path))).map((path) => dirname(path))])
  return [...dirs].sort()
}

// ---------------------------------------------------------------------------
// Static audit: the preload refuses before anything else
// ---------------------------------------------------------------------------

/** The names the preload's refusal loop reads, each imported from `./host-safe-env.ts`. */
const REFUSAL_LOOP_IMPORTS: readonly string[] = ['launchTimeHomes', 'launchHomeRefusal', 'passwdHome', 'LIVE_LAUNCH_HOME_PROBE', 'LAUNCH_HOME_REFUSED_EXIT_CODE']

/**
 * Why the preload source `sf` does not refuse before anything else. Its first
 * statement after the imports must be the refusal loop, in this shape (names
 * may be aliased on import; the loop and result variables may have any name):
 *
 *   for (const <home> of launchTimeHomes()) {
 *     const <refusal> = launchHomeRefusal(<home>, passwdHome(), LIVE_LAUNCH_HOME_PROBE)
 *     if (<refusal> !== undefined) {
 *       <expression statements>
 *       process.exit(LAUNCH_HOME_REFUSED_EXIT_CODE)
 *     }
 *   }
 *
 * Each of `REFUSAL_LOOP_IMPORTS` must be a value import from
 * `./host-safe-env.ts`, and nothing else in the file may declare one of their
 * local names, `process` or `undefined`.
 */
function preloadRefusalFindings(sf: ts.SourceFile): string[] {
  const findings: string[] = []
  const flag = (node: ts.Node, what: string): void => {
    findings.push(finding(sf, node, what))
  }

  // Imported name → local name, for the value imports from ./host-safe-env.ts.
  const local = new Map<string, string>()
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) continue
    if (!/^\.\/host-safe-env(?:\.ts)?$/.test(stringText(statement.moduleSpecifier) ?? '')) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const el of bindings.elements) if (!el.isTypeOnly) local.set((el.propertyName ?? el.name).text, el.name.text)
  }
  for (const name of REFUSAL_LOOP_IMPORTS) if (!local.has(name)) flag(sf, `${name} is not imported from ./host-safe-env.ts`)
  const isName = (node: ts.Node | undefined, name: string | undefined): boolean => node !== undefined && name !== undefined && ts.isIdentifier(node) && node.text === name
  const isImported = (node: ts.Node | undefined, name: string): boolean => isName(node, local.get(name))
  const isBareCall = (node: ts.Node | undefined, name: string): boolean => node !== undefined && ts.isCallExpression(node) && node.arguments.length === 0 && isImported(node.expression, name)

  // No other declaration of a name the loop reads.
  const reserved = new Set([...REFUSAL_LOOP_IMPORTS.map((name) => local.get(name)).filter((name) => name !== undefined), 'process', 'undefined'])
  forEachNode(sf, (node) => {
    if (ts.isImportSpecifier(node)) return
    const name = (node as { name?: ts.Node }).name
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      && name !== undefined && ts.isIdentifier(name) && reserved.has(name.text)) {
      flag(node, `${name.text} is declared again in the file`)
    }
  })

  const loop = sf.statements.find((statement) => !ts.isImportDeclaration(statement))
  if (loop === undefined || !ts.isForOfStatement(loop) || loop.awaitModifier !== undefined) {
    flag(loop ?? sf, 'the first statement after the imports is not the for…of refusal loop')
    return findings
  }
  const declared = ts.isVariableDeclarationList(loop.initializer) && loop.initializer.declarations.length === 1 ? loop.initializer.declarations[0]!.name : undefined
  const home = declared !== undefined && ts.isIdentifier(declared) ? declared.text : undefined
  if (home === undefined) flag(loop.initializer, 'the loop does not bind one launch-time home')
  if (!isBareCall(loop.expression, 'launchTimeHomes')) flag(loop.expression, 'the loop does not iterate launchTimeHomes()')

  const body = ts.isBlock(loop.statement) ? loop.statement.statements : ts.factory.createNodeArray<ts.Statement>()
  const [decide, check, ...rest] = body
  for (const extra of rest) flag(extra, 'the loop does more than decide and refuse')

  // const <refusal> = launchHomeRefusal(<home>, passwdHome(), LIVE_LAUNCH_HOME_PROBE)
  const declaration = decide !== undefined && ts.isVariableStatement(decide) && decide.declarationList.declarations.length === 1 ? decide.declarationList.declarations[0]! : undefined
  const call = declaration?.initializer
  const refusal = declaration !== undefined && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
  if (refusal === undefined || call === undefined || !ts.isCallExpression(call) || !isImported(call.expression, 'launchHomeRefusal')) {
    flag(decide ?? loop, 'the loop does not first decide launchHomeRefusal for its home')
  } else {
    const [launchHome, passwd, probe, ...extra] = call.arguments
    if (!isName(launchHome, home)) flag(launchHome ?? call, 'launchHomeRefusal is not asked about the loop’s home')
    if (!isBareCall(passwd, 'passwdHome')) flag(passwd ?? call, 'launchHomeRefusal is not given passwdHome()')
    if (!isImported(probe, 'LIVE_LAUNCH_HOME_PROBE')) flag(probe ?? call, 'launchHomeRefusal is not given LIVE_LAUNCH_HOME_PROBE')
    for (const arg of extra) flag(arg, 'launchHomeRefusal is given more than three arguments')
  }

  // if (<refusal> !== undefined) { …; process.exit(LAUNCH_HOME_REFUSED_EXIT_CODE) }
  const condition = check !== undefined && ts.isIfStatement(check) ? check.expression : undefined
  const refuses = condition !== undefined && ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    && isName(condition.left, refusal) && isName(condition.right, 'undefined')
  if (check === undefined || !ts.isIfStatement(check) || !refuses || check.elseStatement !== undefined) {
    flag(check ?? loop, 'the loop does not refuse exactly when launchHomeRefusal gives a reason')
    return findings
  }
  const then = ts.isBlock(check.thenStatement) ? check.thenStatement.statements : ts.factory.createNodeArray<ts.Statement>([check.thenStatement])
  for (const statement of then) if (!ts.isExpressionStatement(statement)) flag(statement, 'the refusal does more than run expressions and exit')
  const exit = then[then.length - 1]
  const exitCall = exit !== undefined && ts.isExpressionStatement(exit) ? exit.expression : undefined
  const exits = exitCall !== undefined && ts.isCallExpression(exitCall) && ts.isPropertyAccessExpression(exitCall.expression)
    && isName(exitCall.expression.expression, 'process') && exitCall.expression.name.text === 'exit'
    && exitCall.arguments.length === 1 && isImported(exitCall.arguments[0], 'LAUNCH_HOME_REFUSED_EXIT_CODE')
  if (!exits) flag(exit ?? check, 'the refusal does not end with process.exit(LAUNCH_HOME_REFUSED_EXIT_CODE)')
  return findings
}

// ---------------------------------------------------------------------------
// Static audit: nothing the guard loads runs before the refusal
// ---------------------------------------------------------------------------

/**
 * What the preload may load: `node:` builtins and `./host-safe-env.ts` (with
 * or without the extension). Every module a file imports is evaluated before
 * the file's first statement, so anything else (a `src/` module, a package,
 * another test helper) would run its top-level code before the refusal loop.
 */
const PRELOAD_LOADS = /^(?:node:.+|\.\/host-safe-env(?:\.ts)?)$/

/** What `host-safe-env.ts` may load: `node:` builtins only. The preload imports it, so whatever it loads runs before the refusal too. */
const HELPER_LOADS = /^node:.+$/

/**
 * Where `sf` loads a module whose specifier `allowed` does not match: a static
 * import (side-effect only and type-only too, so the rule does not depend on
 * what the transpiler drops), an `export … from`, `import x = require`, a
 * dynamic `import()` or a `require()`. A dynamic `import()` or `require()`
 * that is not given one string literal is flagged as well: the audit cannot
 * tell what it loads. Strings and comments that name a module are not loads.
 */
function guardLoadFindings(sf: ts.SourceFile, allowed: RegExp): string[] {
  const findings: string[] = []
  forEachNode(sf, (node) => {
    let specifier: ts.Node | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      specifier = node.arguments.length === 1 ? node.arguments[0] : node
    }
    if (specifier === undefined) return
    const text = stringText(specifier)
    if (text === undefined) findings.push(finding(sf, node, 'a module load the audit cannot follow'))
    else if (!allowed.test(text)) findings.push(finding(sf, node, `loads ${text}`))
  })
  return findings
}

// ---------------------------------------------------------------------------
// Static audit: where the real home is named
// ---------------------------------------------------------------------------

/** The `host-safe-env.ts` functions that answer the real home's path. */
const REAL_HOME_NAMES: readonly string[] = ['realHome', 'passwdHome']

/**
 * The only files (by repository path) that may reference `REAL_HOME_NAMES`:
 * the helper that declares them, the preload guard, and the two suites that
 * test the guard and `hostSafeChildEnv`'s real-home refusals.
 */
const REAL_HOME_FILES: readonly string[] = [
  'tests/host-safety.test.ts',
  'tests/launch-home-guard.test.ts',
  'tests/test-helpers/host-safe-env.ts',
  'tests/test-helpers/host-safety-preload.ts',
]

/** Where `sf` references one of `REAL_HOME_NAMES` (`nameReferenceFindings` for each). */
function realHomeFindings(sf: ts.SourceFile): string[] {
  return REAL_HOME_NAMES.flatMap((name) => nameReferenceFindings(sf, name))
}

// ---------------------------------------------------------------------------
// Static audit: where Client.create, the startup gate and resolveSystemBinary run (SRJ-121)
// ---------------------------------------------------------------------------

const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')

/** Whether the identifier `id` sits in a type: a type reference or `typeof` query (through qualified names), or an `implements` clause. */
function inTypePosition(id: ts.Identifier): boolean {
  let at: ts.Node = id
  while (ts.isQualifiedName(at.parent)) at = at.parent
  const parent = at.parent
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return true
  return ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent) && parent.parent.token === ts.SyntaxKind.ImplementsKeyword
}

/**
 * Whether the identifier `id` reads the local binding it names as a value:
 * not a declared name (an import, binding element, variable, parameter,
 * function or property key), not a member name after a `.`, not in a type
 * (`inTypePosition`). A shorthand property `{ x }` and a local `export { x }`
 * read `x`.
 */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === id
  if (ts.isExportSpecifier(parent)) return parent.parent.parent.moduleSpecifier === undefined && (parent.propertyName ?? parent.name) === id
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === id
  if ((ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) && parent.propertyName === id) return false
  if (inTypePosition(id)) return false
  return (parent as { name?: ts.Node }).name !== id
}

/**
 * Where `sf` reaches agent-director's `Client.create`. The class is found in
 * every form `agentDirectorValueReads` finds (a named or aliased import, a
 * namespace, default-import, `require` or dynamic-import read, destructuring)
 * and followed through `const X = <Client>` copies. Flagged: reading `create`
 * on it (called, passed on or bound), destructuring `create` from it, a
 * computed read on it, any other value use of the class the audit cannot
 * follow (passed as an argument or in an object, re-exported), and every read
 * `agentDirectorValueReads` cannot name. Allowed: the class in a type, its
 * other members, and `create` on anything else.
 */
function clientCreateFindings(sf: ts.SourceFile): string[] {
  const findings: string[] = []
  const flag = (node: ts.Node, what: string): void => {
    findings.push(finding(sf, node, what))
  }
  const aliases = new Set<string>()
  const uses: ts.Node[] = []
  for (const read of agentDirectorValueReads(sf, ['Client'])) {
    const node = read.node
    if (read.name === undefined) flag(node, read.what)
    else if (ts.isImportSpecifier(node) || ts.isShorthandPropertyAssignment(node)) aliases.add(node.name.text)
    else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) aliases.add(node.name.text)
    else if (ts.isPropertyAssignment(node) && ts.isIdentifier(unwrap(node.initializer))) aliases.add((unwrap(node.initializer) as ts.Identifier).text)
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) uses.push(node)
    else flag(node, `${read.what}: Client in a form the audit cannot follow`)
  }

  const followed = new Set<ts.Node>()
  for (let grew = true; grew;) {
    grew = false
    forEachNode(sf, (node) => {
      if (ts.isIdentifier(node) && aliases.has(node.text) && isValueReference(node) && !followed.has(node)) {
        followed.add(node)
        uses.push(node)
      }
    })
    for (let use = uses.pop(); use !== undefined; use = uses.pop()) {
      const outer = outermost(use)
      const context = outer.parent
      if (ts.isPropertyAccessExpression(context) && context.expression === outer) {
        if (context.name.text === 'create') flag(context, 'read of Client.create')
      } else if (ts.isElementAccessExpression(context) && context.expression === outer) {
        const member = stringText(context.argumentExpression)
        if (member === undefined) flag(context, 'computed read on Client')
        else if (member === 'create') flag(context, 'read of Client.create')
      } else if (ts.isVariableDeclaration(context) && context.initializer === outer && ts.isIdentifier(context.name)) {
        if (!aliases.has(context.name.text)) {
          aliases.add(context.name.text)
          grew = true
        }
      } else if (ts.isVariableDeclaration(context) && context.initializer === outer && ts.isObjectBindingPattern(context.name)) {
        for (const el of context.name.elements) {
          const member = el.dotDotDotToken === undefined ? propertyNameText(el.propertyName ?? el.name) : undefined
          if (member === undefined) flag(el, 'destructuring of Client the audit cannot follow')
          else if (member === 'create') flag(el, 'destructuring of create from Client')
        }
      } else {
        flag(use, 'Client used as a value the audit cannot follow')
      }
    }
  }
  return findings
}

/** Where `sf` holds agent-director's `resolveSystemBinary` as a value (E1's matcher, that name only), plus every read it cannot name. */
function resolveSystemBinaryFindings(sf: ts.SourceFile): string[] {
  return agentDirectorValueReads(sf, ['resolveSystemBinary']).map((read) => finding(sf, read.node, read.what))
}

/**
 * Where `sf` reaches the function `name` as a value: an identifier that reads
 * it (`isValueReference`: a call, an argument, a shorthand property), a named
 * import or export of it (aliased or not, type-only excluded), a member read
 * `x.name` (a namespace or dynamic import), an element read `x['name']`, and
 * destructuring it (`{ name }`, `{ name: y }`, `{ 'name': y }`). Not: its own
 * declaration, an object key, `typeof name`, the name in a string, template
 * or comment.
 */
function nameReferenceFindings(sf: ts.SourceFile, name: string): string[] {
  const findings: string[] = []
  forEachNode(sf, (node) => {
    let hit = false
    const parent = node.parent
    if (ts.isIdentifier(node) && node.text === name) {
      if (ts.isImportSpecifier(parent)) hit = !parent.isTypeOnly && !parent.parent.parent.isTypeOnly
      else if (ts.isExportSpecifier(parent)) hit = !parent.isTypeOnly && !parent.parent.parent.isTypeOnly
      else if (ts.isPropertyAccessExpression(parent)) hit = true
      else if (ts.isBindingElement(parent)) hit = (parent.propertyName ?? parent.name) === node
      else hit = isValueReference(node)
    } else if (stringText(node) === name) {
      hit = (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) || (ts.isBindingElement(parent) && parent.propertyName === node)
    }
    if (hit) findings.push(finding(sf, node, `reference to ${name}`))
  })
  return findings
}

/** Every `*.ts` file under `src/` and `scripts/`: the production side SRJ-121's call sites are audited over. */
function productionFiles(): string[] {
  return [...filesUnder(SRC_DIR, (path) => path.endsWith('.ts')), ...filesUnder(SCRIPTS_DIR, (path) => path.endsWith('.ts'))].sort()
}

/**
 * The SRJ-121 call-site audits: each matcher, and the only files (by
 * repository path) it may find anything in.
 *
 * - `Client.create`: the startup gate's module (its production `createClient`).
 * - `runStartupGate`: that module and the CLI (`initClient`).
 * - `runAgentDirectorStartupGate` (declared in that module, which never
 *   calls it): the server (`main()`).
 * - `resolveSystemBinary`: the server (`main()` passes it to the runtime
 *   re-check), the install check (its default resolver) and `/publish`'s
 *   check (`main()` passes it in).
 */
const CALL_SITE_AUDITS: { what: string; audit: (sf: ts.SourceFile) => string[]; files: readonly string[] }[] = [
  { what: 'Client.create', audit: clientCreateFindings, files: ['src/agent-director-startup.ts'] },
  { what: 'runStartupGate', audit: (sf) => nameReferenceFindings(sf, 'runStartupGate'), files: ['src/agent-director-startup.ts', 'src/cli.ts'] },
  { what: 'runAgentDirectorStartupGate', audit: (sf) => nameReferenceFindings(sf, 'runAgentDirectorStartupGate'), files: ['src/server.ts'] },
  { what: 'resolveSystemBinary', audit: resolveSystemBinaryFindings, files: ['scripts/ad-version-check.ts', 'src/install-check.ts', 'src/server.ts'] },
]

/** The audit in `CALL_SITE_AUDITS` for `what`. */
function callSiteAudit(what: string): (sf: ts.SourceFile) => string[] {
  const entry = CALL_SITE_AUDITS.find((a) => a.what === what)
  if (entry === undefined) throw new Error(`no call-site audit for ${what}`)
  return entry.audit
}

// ---------------------------------------------------------------------------
// Static audits: pinned matchers, then the tree
// ---------------------------------------------------------------------------

/** One source line per entry, so no synthetic line starts at column 0 in this file. */
const lines = (...parts: string[]): string => parts.join('\n')

const SAFE_ENV_IMPORT = "import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'"
const SPAWN_SYNC_IMPORT = "import { spawnSync } from 'node:child_process'"

describe('static audit: no value import of Client or resolveSystemBinary from agent-director', () => {
  const flagged: [label: string, source: string][] = [
    ['a named value import of Client', "import { Client } from 'agent-director'"],
    ['an aliased value import of resolveSystemBinary', "import { resolveSystemBinary as find } from 'agent-director'"],
    ['a value import of Client beside an inline type import', "import { type ClientOptions, Client } from 'agent-director'"],
    ['a namespace property read of Client', lines(AD_NS, 'await ad.Client.create()')],
    ['a namespace element read of resolveSystemBinary', lines(AD_NS, "await ad['resolveSystemBinary']()")],
    ['a computed namespace element read', lines(AD_NS, "const key = 'Client'", 'ad[key]')],
    ['destructuring of resolveSystemBinary from the namespace', lines(AD_NS, 'const { resolveSystemBinary } = ad')],
    ['aliased destructuring of resolveSystemBinary from the namespace', lines(AD_NS, 'const { resolveSystemBinary: find } = ad')],
    ['destructuring assignment of Client from the namespace', lines(AD_NS, 'let Client', '({ Client } = ad)')],
    ['a default import read of Client', lines("import ad from 'agent-director'", 'ad.Client')],
    ['an import-equals require read of Client', lines("import ad = require('agent-director')", 'ad.Client')],
    ['a read through a spread copy of the namespace', lines(AD_NS, 'const REAL = { ...ad }', 'await REAL.resolveSystemBinary()')],
    ['a read through a destructuring rest copy', lines(AD_NS, 'const { ...rest } = ad', 'rest.Client')],
    ['a matcher that calls the value', lines(AD_NS, 'expect(ad.resolveSystemBinary).toThrow()')],
    ['a call inside an identity assertion', lines(AD_NS, 'expect(await ad.resolveSystemBinary()).toBe(found)')],
    ['an identity assertion on the namespace read', lines(AD_NS, 'expect(ad.resolveSystemBinary).toBe(found)')],
    ['an identity assertion against a spread copy read', lines(AD_NS, 'const REAL = { ...ad }', 'expect(ad.resolveSystemBinary).toBe(REAL.resolveSystemBinary)')],
    ['a negated identity assertion', lines(AD_NS, 'expect(ad.Client).not.toBe(stub)')],
    ['an identity assertion with the read as the expected value', lines(AD_NS, "expect(found).toBe(ad['resolveSystemBinary'])")],
    ['destructuring a dynamic import', "const { Client } = await import('agent-director')"],
    ['a read through a dynamic import binding', lines("const ad = await import('agent-director')", 'await ad.resolveSystemBinary()')],
    ['a read on a dynamic import', "await (await import('agent-director')).resolveSystemBinary()"],
    ['a read through a require binding', lines("const ad = require('agent-director')", 'ad.Client')],
    ['a dynamic import used through then()', "import('agent-director').then((ad) => ad.Client)"],
    ['a named value re-export of Client', "export { Client } from 'agent-director'"],
    ['a re-export of the whole module', "export * from 'agent-director'"],
  ]

  test.each(flagged)('flags %s', (_label, source) => {
    expect(discoveryValueFindings(parse(source)).length).toBeGreaterThan(0)
  })

  const allowed: [label: string, source: string][] = [
    ['a whole-statement type-only import', "import type { Client } from 'agent-director'"],
    ['an aliased whole-statement type-only import', "import type { resolveSystemBinary as Find } from 'agent-director'"],
    ['an inline type-only import beside a value import', "import { type Client, ErrSystemInstallNotFound } from 'agent-director'"],
    ['an aliased inline type-only import', "import { type Client as C } from 'agent-director'"],
    ['a type-only re-export', "export type { Client } from 'agent-director'"],
    ['an import type in a type position', "const client: import('agent-director').Client | undefined = undefined"],
    ['other names', "import { ErrSystemInstallNotFound, DEV_SENTINEL_VERSION } from 'agent-director'"],
    ['Client from another module', "import { Client } from './other.ts'"],
    ['the namespace spread into a mock.module factory', lines(AD_NS, "mock.module('agent-director', () => ({ ...ad, Client: { create } }))")],
    ['a spread copy spread into a mock.module factory', lines(AD_NS, 'const REAL = { ...ad }', "mock.module('agent-director', () => ({ ...REAL, resolveSystemBinary: () => stub() }))")],
    ['the namespace and a spread copy compared entry by entry', lines(
      AD_NS,
      'const REAL = { ...ad }',
      'const live = new Map(Object.entries(ad))',
      'expect(Object.entries(REAL).filter(([key, value]) => !Object.is(live.get(key), value))).toEqual([])',
    )],
    ['other names read through the namespace', lines(AD_NS, 'ad.ErrSystemInstallNotFound')],
    ['destructuring other names from a dynamic import', "const { ErrAlreadyDecided } = await import('agent-director')"],
    ['text in strings, templates, regex literals and comments', lines(
      "// import { Client } from 'agent-director'",
      "/* ad.resolveSystemBinary() */",
      "const s = \"import { Client } from 'agent-director'\"",
      'const t = `ad.Client.create()`',
      'const r = /resolveSystemBinary\\(\\)/',
    )],
  ]

  test.each(allowed)('allows %s', (_label, source) => {
    expect(discoveryValueFindings(parse(source))).toEqual([])
  })

  test('the current tree: no test file or test helper holds Client or resolveSystemBinary as a value', () => {
    expect(auditTree(hostTestFiles(), discoveryValueFindings)).toEqual([])
  })
})

describe('static audit: every child process call’s env is a direct hostSafeChildEnv call', () => {
  const flagged: [label: string, source: string][] = [
    ['no options', lines(SPAWN_SYNC_IMPORT, "spawnSync('bash', ['script.sh'])")],
    ['options without env', lines(SPAWN_SYNC_IMPORT, "spawnSync('bash', ['script.sh'], { timeout: 1_000 })")],
    ['an inherited environment', lines(SPAWN_SYNC_IMPORT, "spawnSync('bash', [], { env: process.env })")],
    ['a spread environment', lines(SPAWN_SYNC_IMPORT, "spawnSync('bash', [], { env: { ...process.env, HOME: home } })")],
    ['a spread hostSafeChildEnv', lines(SPAWN_SYNC_IMPORT, SAFE_ENV_IMPORT, "spawnSync('bash', [], { env: { ...hostSafeChildEnv(home), X: '1' } })")],
    ['an environment built earlier', lines(SPAWN_SYNC_IMPORT, SAFE_ENV_IMPORT, 'const env = hostSafeChildEnv(home)', "spawnSync('bash', [], { env })")],
    ['a wrapper-built environment', lines(SPAWN_SYNC_IMPORT, SAFE_ENV_IMPORT, 'const childEnv = (h) => hostSafeChildEnv(h)', "spawnSync('bash', [], { env: childEnv(home) })")],
    ['a hostSafeChildEnv not imported from the helper', lines(SPAWN_SYNC_IMPORT, 'function hostSafeChildEnv() { return process.env }', "spawnSync('bash', [], { env: hostSafeChildEnv() })")],
    ['a hostSafeChildEnv imported from another module', lines(SPAWN_SYNC_IMPORT, "import { hostSafeChildEnv } from './other.ts'", "spawnSync('bash', [], { env: hostSafeChildEnv(home) })")],
    ['options spread into the call', lines(SPAWN_SYNC_IMPORT, SAFE_ENV_IMPORT, "spawnSync('bash', [], { ...opts, env: hostSafeChildEnv(home) })")],
    ['options passed by name', lines(SPAWN_SYNC_IMPORT, "spawnSync('bash', [], opts)")],
    ['an aliased import', lines("import { spawnSync as run } from 'node:child_process'", "run('ls', [], { env: process.env })")],
    ['a namespace import', lines("import * as cp from 'node:child_process'", "cp.execSync('ls')")],
    ['a default import', lines("import cp from 'child_process'", "cp.spawn('ls', [], { env: process.env })")],
    ['an import-equals require', lines("import cp = require('child_process')", "cp.execFileSync('ls')")],
    ['a destructured dynamic import', lines("const { execFileSync } = await import('node:child_process')", "execFileSync('ls')")],
    ['a call on a dynamic import', "(await import('node:child_process')).spawnSync('ls')"],
    ['a require binding with a callback only', lines("const cp = require('child_process')", "cp.exec('ls', () => {})")],
    ['execFile with a callback only', lines("import { execFile } from 'node:child_process'", "execFile('ls', ['-l'], (err) => {})")],
    ['fork', lines("import { fork } from 'node:child_process'", "fork('child.js')")],
    ['Bun.spawn with no options', "Bun.spawn(['ls'])"],
    ['Bun.spawnSync with a command object and no env', "Bun.spawnSync({ cmd: ['ls'] })"],
    ['Bun.spawn with a spread environment', "Bun.spawn(['ls'], { env: { ...process.env } })"],
    ['spawn imported from bun', lines("import { spawn } from 'bun'", "spawn(['ls'])")],
    ['a Bun.$ template', 'await Bun.$`ls`'],
    ['a $ template imported from bun', lines("import { $ } from 'bun'", 'await $`ls`')],
    ['a Bun.$ template with an inherited env', 'await Bun.$`ls`.env(process.env)'],
    ['a child process function passed on uncalled', lines(SPAWN_SYNC_IMPORT, 'const deps = { spawnSync }')],
    ['Bun.spawn passed on uncalled', 'const deps = { spawn: Bun.spawn }'],
    ['a child process function re-exported', lines(SPAWN_SYNC_IMPORT, 'export { spawnSync }')],
    ['child_process loaded in a form the audit cannot follow', "import('node:child_process').then((cp) => cp.spawnSync('ls'))"],
  ]

  test.each(flagged)('flags %s', (_label, source) => {
    expect(childProcessAudit(parse(source)).findings.length).toBeGreaterThan(0)
  })

  const allowed: [label: string, source: string, calls: number][] = [
    ['spawnSync with args and a direct hostSafeChildEnv env', lines(SPAWN_SYNC_IMPORT, SAFE_ENV_IMPORT, "spawnSync('bash', [script], { env: hostSafeChildEnv(home, { tools: ['bash'] }), timeout: 5_000 })"), 1],
    ['spawnSync with options and no args', lines(SPAWN_SYNC_IMPORT, SAFE_ENV_IMPORT, 'spawnSync(process.execPath, { env: hostSafeChildEnv(home, { tools: [] }) })'), 1],
    ['an aliased helper import from a helper file', lines(SPAWN_SYNC_IMPORT, "import { hostSafeChildEnv as safeEnv } from './host-safe-env.ts'", "spawnSync('sh', [], { env: safeEnv(home) })"), 1],
    ['a namespace import', lines("import * as cp from 'node:child_process'", SAFE_ENV_IMPORT, "cp.execFileSync('ls', [], { env: hostSafeChildEnv(home) })"), 1],
    ['execFile with options and a callback', lines("import { execFile } from 'node:child_process'", SAFE_ENV_IMPORT, "execFile('ls', [], { env: hostSafeChildEnv(home) }, (err) => {})"), 1],
    ['exec with options', lines("import { exec } from 'child_process'", SAFE_ENV_IMPORT, "exec('ls', { env: hostSafeChildEnv(home) })"), 1],
    ['Bun.spawn with options', lines(SAFE_ENV_IMPORT, "Bun.spawn(['bash', script], { env: hostSafeChildEnv(home, { pathDirs: [stubBin] }) })"), 1],
    ['Bun.spawnSync with a command object', lines(SAFE_ENV_IMPORT, "Bun.spawnSync({ cmd: ['ls'], env: hostSafeChildEnv(home) })"), 1],
    ['a Bun.$ template with .env(hostSafeChildEnv(...))', lines(SAFE_ENV_IMPORT, 'await Bun.$`ls`.env(hostSafeChildEnv(home))'), 1],
    ['stub and client method calls', lines(SPAWN_SYNC_IMPORT, "client.spawn({ name: 'x' })", 'stub.spawnSync()', 'agentDirector.exec()'), 0],
    ['RegExp exec beside an imported exec', lines("import { exec } from 'node:child_process'", "/a(b)/.exec(text)", 're.exec(text)'), 0],
    ['a child process function in a type query', lines(SPAWN_SYNC_IMPORT, 'type Result = ReturnType<typeof spawnSync>'), 0],
    ['a method named like a child process function', lines(SPAWN_SYNC_IMPORT, 'class Stub { spawnSync() { return 0 } }', 'const o = { spawnSync: 1 }'), 0],
    ['text in strings, templates, regex literals and comments', lines(
      SPAWN_SYNC_IMPORT,
      "// spawnSync('bash', [])",
      "/* Bun.spawn(['x']) */",
      "const s = \"spawnSync('bash', [], { env: process.env })\"",
      'const t = `Bun.spawnSync({ cmd: [] })`',
      'const r = /spawnSync\\(/',
    ), 0],
  ]

  test.each(allowed)('allows %s', (_label, source, calls) => {
    const audit = childProcessAudit(parse(source))
    expect(audit.findings).toEqual([])
    expect(audit.calls).toBe(calls)
  })

  test('the current tree: every child process call in a test file or test helper passes', () => {
    const files = hostTestFiles()
    expect(auditTree(files, (sf) => childProcessAudit(sf).findings)).toEqual([])
    expect(files.reduce((sum, path) => sum + childProcessAudit(parseFile(path)).calls, 0)).toBeGreaterThan(0)
    // This file's two children (the inherited-TMUX_TMPDIR and TMPDIR cases) are found and accepted.
    expect(childProcessAudit(parseFile(join(TESTS_DIR, 'host-safety.test.ts')))).toEqual({ calls: 2, findings: [] })
  })

  test('the audited files: every test file bun runs, node_modules excluded, and every test helper', () => {
    const files = hostTestFiles()

    expect(files).toContain(join(TESTS_DIR, 'integration', 'session-leader.test.ts'))
    expect(files).toContain(join(TESTS_DIR, 'host-safety.test.ts'))
    expect(files).toEqual(expect.arrayContaining(filesUnder(TEST_HELPERS_DIR, () => true)))
    expect(files.filter((path) => path.split(sep).includes('node_modules'))).toEqual([])
  })
})

describe('static audit: the preload guard', () => {
  const testFile = join(TESTS_DIR, 'synthetic.test.ts')
  const helperFile = join(TEST_HELPERS_DIR, 'synthetic.ts')

  const flagged: [label: string, path: string, source: string][] = [
    ['a side-effect import', testFile, "import './test-helpers/host-safety-preload.ts'"],
    ['a namespace import without the extension', testFile, "import * as preload from './test-helpers/host-safety-preload'"],
    ['a re-export', testFile, "export * from './test-helpers/host-safety-preload.ts'"],
    ['a dynamic import', testFile, "await import('./test-helpers/host-safety-preload.ts')"],
    ['a require', testFile, "require('./test-helpers/host-safety-preload.ts')"],
    ['an import from a sibling helper', helperFile, "import './host-safety-preload.ts'"],
  ]

  test.each(flagged)('flags %s', (_label, path, source) => {
    expect(importsOfFile(parse(source), path, PRELOAD_PATH).length).toBeGreaterThan(0)
  })

  const allowed: [label: string, path: string, source: string][] = [
    ['an import of the shared helper', testFile, "import { PRELOAD_HOME_PREFIX } from './test-helpers/host-safe-env.ts'"],
    ['a same-named file elsewhere', testFile, "import './other/host-safety-preload.ts'"],
    ['a package of the same name', testFile, "import 'host-safety-preload'"],
    ['text in strings and comments', testFile, lines("// import './test-helpers/host-safety-preload.ts'", "const p = './test-helpers/host-safety-preload.ts'")],
  ]

  test.each(allowed)('allows %s', (_label, path, source) => {
    expect(importsOfFile(parse(source), path, PRELOAD_PATH)).toEqual([])
  })

  const bunfigFlagged: [label: string, toml: string][] = [
    ['an empty file', ''],
    ['a [test] table without preload', '[test]\ncoverage = false'],
    ['a [test] preload naming another file', '[test]\npreload = ["./tests/other-preload.ts"]'],
    ['an empty [test] preload', '[test]\npreload = []'],
    ['a top-level preload (bun run’s, not bun test’s)', 'preload = ["./tests/test-helpers/host-safety-preload.ts"]'],
    ['a preload under [run]', '[run]\npreload = ["./tests/test-helpers/host-safety-preload.ts"]'],
    ['a bare path (Bun looks it up as a package)', '[test]\npreload = ["tests/test-helpers/host-safety-preload.ts"]'],
    ['a path relative to tests/ (read from the root, it names nothing)', '[test]\npreload = ["./test-helpers/host-safety-preload.ts"]'],
    ['a [test] preload list naming it after another (that one runs before the refusal)', '[test]\npreload = ["./tests/other-preload.ts", "./tests/test-helpers/host-safety-preload.ts"]'],
  ]

  test.each(bunfigFlagged)('a bunfig.toml with %s does not load it', (_label, toml) => {
    expect(bunfigPreloadFindings(toml, REPO_ROOT, PRELOAD_PATH).length).toBeGreaterThan(0)
  })

  const bunfigAllowed: [label: string, toml: string][] = [
    ['a [test] preload list naming it', '[test]\npreload = ["./tests/test-helpers/host-safety-preload.ts"]'],
    ['a [test] preload string naming it', '[test]\npreload = "./tests/test-helpers/host-safety-preload.ts"'],
    ['a [test] preload list naming it first, then another', '[test]\npreload = ["./tests/test-helpers/host-safety-preload.ts", "./tests/other-preload.ts"]'],
    ['a [test] preload naming it by absolute path', `[test]\npreload = [${JSON.stringify(PRELOAD_PATH)}]`],
  ]

  test.each(bunfigAllowed)('a bunfig.toml with %s loads it', (_label, toml) => {
    expect(bunfigPreloadFindings(toml, REPO_ROOT, PRELOAD_PATH)).toEqual([])
  })

  test('a tests/ bunfig.toml naming it relative to tests/ loads it for a run started there', () => {
    const toml = '[test]\npreload = ["./test-helpers/host-safety-preload.ts"]'
    expect(bunfigPreloadFindings(toml, TESTS_DIR, PRELOAD_PATH)).toEqual([])
    expect(bunfigPreloadFindings('[test]\npreload = ["./tests/test-helpers/host-safety-preload.ts"]', TESTS_DIR, PRELOAD_PATH).length).toBeGreaterThan(0)
  })

  test('the current tree: no file in the repository imports it', () => {
    expect(existsSync(PRELOAD_PATH)).toBe(true)
    const files = filesUnder(REPO_ROOT, (path) => SCRIPT_FILE.test(path))
    expect(files).toContain(join(TESTS_DIR, 'host-safety.test.ts'))
    expect(auditTree(files, (sf, path) => importsOfFile(sf, path, PRELOAD_PATH))).toEqual([])
  })

  test('the current tree: the repository root and every directory holding a test file have a bunfig.toml whose [test] preload names it first', () => {
    const dirs = testStartDirs()

    expect(dirs).toEqual(expect.arrayContaining([REPO_ROOT, TESTS_DIR, join(TESTS_DIR, 'integration')]))
    expect(dirs.map((dir) => {
      const bunfig = join(dir, 'bunfig.toml')
      return [relative(REPO_ROOT, dir), existsSync(bunfig) ? bunfigPreloadFindings(readFileSync(bunfig, 'utf-8'), dir, PRELOAD_PATH) : ['no bunfig.toml']]
    })).toEqual(dirs.map((dir) => [relative(REPO_ROOT, dir), []]))
  })
})

describe('static audit: the preload refuses before anything else', () => {
  const IMPORT = "import { LAUNCH_HOME_REFUSED_EXIT_CODE, LIVE_LAUNCH_HOME_PROBE, launchHomeRefusal, launchHomeRefusalMessage, launchTimeHomes, passwdHome, realHome } from './host-safe-env.ts'"
  const ARGS = 'launchHome, passwdHome(), LIVE_LAUNCH_HOME_PROBE'
  const EXIT = 'process.exit(LAUNCH_HOME_REFUSED_EXIT_CODE)'

  /** A preload source holding the refusal loop with `parts` replaced, then the rest of the guard. */
  function preloadSource(parts: { imports?: string; before?: string; homes?: string; args?: string; check?: string; refuse?: string; after?: string } = {}): string {
    return lines(
      parts.imports ?? IMPORT,
      "import { mkdtempSync } from 'node:fs'",
      parts.before ?? '',
      `for (const launchHome of ${parts.homes ?? 'launchTimeHomes()'}) {`,
      `  const refusal = launchHomeRefusal(${parts.args ?? ARGS})`,
      `  if (${parts.check ?? 'refusal !== undefined'}) {`,
      '    process.stderr.write(`${launchHomeRefusalMessage(refusal, launchHome)}\\n`)',
      `    ${parts.refuse ?? EXIT}`,
      '  }',
      '}',
      parts.after ?? "const home = mkdtempSync('/tmp/x-')",
    )
  }

  const flagged: [label: string, source: string][] = [
    ['undefined as the passwd home', preloadSource({ args: 'launchHome, undefined, LIVE_LAUNCH_HOME_PROBE' })],
    ['realHome() as the passwd home', preloadSource({ args: 'launchHome, realHome(), LIVE_LAUNCH_HOME_PROBE' })],
    ['a missing argument', preloadSource({ args: 'launchHome, passwdHome()' })],
    ['an extra argument', preloadSource({ args: `${ARGS}, true` })],
    ['passwdHome passed uncalled', preloadSource({ args: 'launchHome, passwdHome, LIVE_LAUNCH_HOME_PROBE' })],
    ['homedir() as the launch home', preloadSource({ args: 'homedir(), passwdHome(), LIVE_LAUNCH_HOME_PROBE' })],
    ['a hand-built probe', preloadSource({ args: "launchHome, passwdHome(), { exists: () => false, canonical: (p) => p, tempDir: () => '/tmp' }" })],
    ['a loop over [homedir()] instead of launchTimeHomes()', preloadSource({ homes: '[homedir()]' })],
    ['realHome imported under the name passwdHome', preloadSource({
      imports: "import { LAUNCH_HOME_REFUSED_EXIT_CODE, LIVE_LAUNCH_HOME_PROBE, launchHomeRefusal, launchHomeRefusalMessage, launchTimeHomes, realHome as passwdHome } from './host-safe-env.ts'",
    })],
    ['launchHomeRefusal imported from another module', preloadSource({
      imports: lines(
        "import { LAUNCH_HOME_REFUSED_EXIT_CODE, LIVE_LAUNCH_HOME_PROBE, launchHomeRefusalMessage, launchTimeHomes, passwdHome } from './host-safe-env.ts'",
        "import { launchHomeRefusal } from './other.ts'",
      ),
    })],
    ['passwdHome declared again in the file', preloadSource({ after: 'function passwdHome() { return undefined }' })],
    ['process declared again in the file', preloadSource({ after: 'var process = { exit() {} }' })],
    ['the refusal inverted', preloadSource({ check: 'refusal === undefined' })],
    ['the refusal checked loosely', preloadSource({ check: 'refusal' })],
    ['an exit code other than LAUNCH_HOME_REFUSED_EXIT_CODE', preloadSource({ refuse: 'process.exit(1)' })],
    ['a throw in place of the exit', preloadSource({ refuse: "throw new Error('refused')" })],
    ['no exit', preloadSource({ refuse: "process.stderr.write('refused')" })],
    ['a continue before the exit', preloadSource({ refuse: lines('continue', EXIT) })],
    ['the HOME made before the loop', preloadSource({ before: "const home = mkdtempSync('/tmp/x-')", after: '' })],
    ['the loop inside a try block', lines(
      IMPORT,
      'try {',
      '  for (const launchHome of launchTimeHomes()) {',
      `    const refusal = launchHomeRefusal(${ARGS})`,
      `    if (refusal !== undefined) ${EXIT}`,
      '  }',
      '} catch {}',
    )],
    ['no loop at all', lines(IMPORT, "const home = mkdtempSync('/tmp/x-')")],
  ]

  test.each(flagged)('flags %s', (_label, source) => {
    expect(preloadRefusalFindings(parse(source)).length).toBeGreaterThan(0)
  })

  const allowed: [label: string, source: string][] = [
    ['the refusal loop first, then the rest of the guard', preloadSource()],
    ['other names for the loop and result variables', lines(
      IMPORT,
      'for (const candidate of launchTimeHomes()) {',
      '  const reason = launchHomeRefusal(candidate, passwdHome(), LIVE_LAUNCH_HOME_PROBE)',
      '  if (reason !== undefined) {',
      '    process.exit(LAUNCH_HOME_REFUSED_EXIT_CODE)',
      '  }',
      '}',
    )],
    ['the names imported under aliases', lines(
      "import { LAUNCH_HOME_REFUSED_EXIT_CODE as REFUSED, LIVE_LAUNCH_HOME_PROBE as PROBE, launchHomeRefusal as decide, launchTimeHomes as homes, passwdHome as accountHome } from './host-safe-env.ts'",
      'for (const launchHome of homes()) {',
      '  const refusal = decide(launchHome, accountHome(), PROBE)',
      '  if (refusal !== undefined) {',
      '    process.exit(REFUSED)',
      '  }',
      '}',
    )],
    ['comments and a type import before the loop', lines("import type { LaunchHomeRefusal } from './host-safe-env.ts'", '// The refusal comes first.', preloadSource())],
  ]

  test.each(allowed)('allows %s', (_label, source) => {
    expect(preloadRefusalFindings(parse(source))).toEqual([])
  })

  test('the current tree: the preload’s first statement after its imports is the refusal loop', () => {
    expect(preloadRefusalFindings(parseFile(PRELOAD_PATH))).toEqual([])
  })
})

describe('static audit: the guard loads nothing that runs before the refusal', () => {
  const flagged: [label: string, rule: RegExp, source: string][] = [
    ['in the preload, a side-effect import of a src/ module', PRELOAD_LOADS, "import '../../src/config.ts'"],
    ['in the preload, a named import from ../../src/config.ts', PRELOAD_LOADS, "import { resolveServerStateDir } from '../../src/config.ts'"],
    ['in the preload, a third-party package import', PRELOAD_LOADS, "import { parse } from 'smol-toml'"],
    ['in the preload, another test helper (it may load src/)', PRELOAD_LOADS, "import { fakeToken } from './credentials.ts'"],
    ['in the preload, a type-only import from a src/ module', PRELOAD_LOADS, "import type { ServerPathSetting } from '../../src/config.ts'"],
    ['in the preload, a re-export from a src/ module', PRELOAD_LOADS, "export { resolveServerStateDir } from '../../src/config.ts'"],
    ['in the preload, an import-equals require of a src/ module', PRELOAD_LOADS, "import config = require('../../src/config.ts')"],
    ['in the preload, a dynamic import of a src/ module', PRELOAD_LOADS, "await import('../../src/config.ts')"],
    ['in the preload, a require of a src/ module', PRELOAD_LOADS, "require('../../src/config.ts')"],
    ['in the preload, a dynamic import of a computed specifier', PRELOAD_LOADS, 'await import(modulePath)'],
    ['in host-safe-env.ts, a side-effect import of a src/ module', HELPER_LOADS, "import '../../src/config.ts'"],
    ['in host-safe-env.ts, a named import from ../../src/config.ts', HELPER_LOADS, "import { resolveServerStateDir } from '../../src/config.ts'"],
    ['in host-safe-env.ts, a third-party package import', HELPER_LOADS, "import { parse } from 'smol-toml'"],
    ['in host-safe-env.ts, another test helper', HELPER_LOADS, "import { treeSnapshot } from './tree-snapshot.ts'"],
  ]

  test.each(flagged)('flags %s', (_label, rule, source) => {
    expect(guardLoadFindings(parse(source), rule).length).toBeGreaterThan(0)
  })

  const allowed: [label: string, rule: RegExp, source: string][] = [
    ['in the preload, node:fs', PRELOAD_LOADS, "import { mkdtempSync } from 'node:fs'"],
    ['in the preload, ./host-safe-env.ts', PRELOAD_LOADS, "import { launchTimeHomes } from './host-safe-env.ts'"],
    ['in the preload, ./host-safe-env without the extension', PRELOAD_LOADS, "import { launchTimeHomes } from './host-safe-env'"],
    ['in host-safe-env.ts, node: builtins and a local export', HELPER_LOADS, lines("import { lstatSync } from 'node:fs'", "import { homedir } from 'node:os'", 'const x = 1', 'export { x }')],
    ['text naming a src/ module in strings and comments', PRELOAD_LOADS, lines("// import '../../src/config.ts'", "const s = \"require('../../src/config.ts')\"")],
  ]

  test.each(allowed)('allows %s', (_label, rule, source) => {
    expect(guardLoadFindings(parse(source), rule)).toEqual([])
  })

  test('the current tree: the preload loads only node: builtins and ./host-safe-env.ts, and host-safe-env.ts only node: builtins', () => {
    expect(guardLoadFindings(parseFile(PRELOAD_PATH), PRELOAD_LOADS)).toEqual([])
    expect(guardLoadFindings(parseFile(HELPER_PATH), HELPER_LOADS)).toEqual([])
  })
})

describe('static audit: only the guard’s own files name the real home (realHome, passwdHome)', () => {
  const HELPER_NS = "import * as h from './test-helpers/host-safe-env.ts'"

  const flagged: [label: string, source: string][] = [
    ['a named import of realHome', "import { realHome } from './test-helpers/host-safe-env.ts'"],
    ['an aliased import of passwdHome', "import { passwdHome as accountHome } from './test-helpers/host-safe-env.ts'"],
    ['a namespace read', lines(HELPER_NS, "const settings = join(h.realHome(), '.claude', 'settings.json')")],
    ['a namespace element read', lines(HELPER_NS, "h['passwdHome']()")],
    ['a destructured dynamic import', "const { realHome } = await import('./test-helpers/host-safe-env.ts')"],
    ['a read on a dynamic import', "(await import('./test-helpers/host-safe-env.ts')).passwdHome()"],
    ['a re-export', "export { realHome } from './host-safe-env.ts'"],
  ]

  test.each(flagged)('flags %s', (_label, source) => {
    expect(realHomeFindings(parse(source)).length).toBeGreaterThan(0)
  })

  const allowed: [label: string, source: string][] = [
    ['other helpers', "import { hostSafeChildEnv, isRealHome, osTempDir } from './test-helpers/host-safe-env.ts'"],
    ['the names as object keys', "const labels = { realHome: 'real', passwdHome: 'passwd' }"],
    ['text in strings, templates, regex literals and comments', lines(
      '// realHome() and passwdHome()',
      "const s = 'realHome()'",
      'const t = `passwdHome()`',
      'const r = /realHome\\(\\)/',
    )],
  ]

  test.each(allowed)('allows %s', (_label, source) => {
    expect(realHomeFindings(parse(source))).toEqual([])
  })

  test('the current tree: every script file in the repository outside REAL_HOME_FILES names neither, and each of them is still a script file', () => {
    const files = filesUnder(REPO_ROOT, (path) => SCRIPT_FILE.test(path))
    const allowedFiles = new Set(REAL_HOME_FILES)

    expect(files).toEqual(expect.arrayContaining([join(SRC_DIR, 'server.ts'), ...REAL_HOME_FILES.map((path) => join(REPO_ROOT, path))]))
    expect(auditTree(files.filter((path) => !allowedFiles.has(relative(REPO_ROOT, path))), realHomeFindings)).toEqual([])
  })
})

describe('static audit: where Client.create, the startup gate and resolveSystemBinary run (SRJ-121)', () => {
  const CLIENT_IMPORT = "import { Client } from 'agent-director'"
  const STARTUP_MODULE = './agent-director-startup.ts'
  const STARTUP_NS = `import * as startup from '${STARTUP_MODULE}'`

  // [audit, label, source]: each audit's rows name its own function.
  const flagged: [what: string, label: string, source: string][] = [
    ['Client.create', 'a direct call', lines(CLIENT_IMPORT, 'await Client.create(opts)')],
    ['Client.create', 'a call through an aliased import', lines("import { Client as AdClient } from 'agent-director'", 'await AdClient.create(opts)')],
    ['Client.create', 'a call through a wrapped reference', lines(CLIENT_IMPORT, 'await (Client as any).create(opts)')],
    ['Client.create', 'a namespace read', lines(AD_NS, 'await ad.Client.create(opts)')],
    ['Client.create', 'namespace element reads', lines(AD_NS, "await ad['Client']['create'](opts)")],
    ['Client.create', 'a computed namespace read', lines(AD_NS, 'await ad[key].create(opts)')],
    ['Client.create', 'a default-import read', lines("import ad from 'agent-director'", 'await ad.Client.create(opts)')],
    ['Client.create', 'a require read', lines("const ad = require('agent-director')", 'await ad.Client.create(opts)')],
    ['Client.create', 'a read on a dynamic import', "await (await import('agent-director')).Client.create(opts)"],
    ['Client.create', 'a destructured dynamic import', lines("const { Client } = await import('agent-director')", 'await Client.create(opts)')],
    ['Client.create', 'an aliased destructuring from the namespace', lines(AD_NS, 'const { Client: C } = ad', 'await C.create(opts)')],
    ['Client.create', 'a destructuring assignment from the namespace', lines(AD_NS, 'let C', '({ Client: C } = ad)', 'await C.create(opts)')],
    ['Client.create', 'const copies of the class', lines(CLIENT_IMPORT, 'const C = Client', 'const D = C', 'await D.create(opts)')],
    ['Client.create', 'create passed on as a value', lines(CLIENT_IMPORT, 'const deps = { createClient: Client.create }')],
    ['Client.create', 'create destructured from the class', lines(CLIENT_IMPORT, 'const { create } = Client')],
    ['Client.create', 'a computed read on the class', lines(CLIENT_IMPORT, 'await Client[key](opts)')],
    ['Client.create', 'the class passed as an argument', lines(CLIENT_IMPORT, 'makeGate(Client)')],
    ['Client.create', 'the class in an object', lines(CLIENT_IMPORT, 'makeGate({ Client })')],
    ['Client.create', 'the class re-exported from agent-director', "export { Client } from 'agent-director'"],
    ['Client.create', 'the class re-exported locally', lines(CLIENT_IMPORT, 'export { Client }')],
    ['resolveSystemBinary', 'a named value import', "import { resolveSystemBinary } from 'agent-director'"],
    ['resolveSystemBinary', 'an aliased value import', "import { resolveSystemBinary as find } from 'agent-director'"],
    ['resolveSystemBinary', 'a namespace read passed as a value', lines(AD_NS, 'installRecheck({ resolveSystemBinary: ad.resolveSystemBinary })')],
    ['resolveSystemBinary', 'a namespace element read', lines(AD_NS, "await ad['resolveSystemBinary']()")],
    ['resolveSystemBinary', 'a computed namespace read', lines(AD_NS, 'await ad[key]()')],
    ['resolveSystemBinary', 'a read on a dynamic import', "await (await import('agent-director')).resolveSystemBinary()"],
    ['resolveSystemBinary', 'an aliased destructured dynamic import', "const { resolveSystemBinary: find } = await import('agent-director')"],
    ['resolveSystemBinary', 'a re-export', "export { resolveSystemBinary } from 'agent-director'"],
    ['resolveSystemBinary', 'a re-export of the whole module', "export * from 'agent-director'"],
    ['runStartupGate', 'a direct call', lines(`import { runStartupGate } from '${STARTUP_MODULE}'`, 'await runStartupGate()')],
    ['runStartupGate', 'an aliased import', `import { runStartupGate as gate } from '${STARTUP_MODULE}'`],
    ['runStartupGate', 'a namespace read', lines(STARTUP_NS, 'await startup.runStartupGate()')],
    ['runStartupGate', 'a namespace element read', lines(STARTUP_NS, "await startup['runStartupGate']()")],
    ['runStartupGate', 'a read on a dynamic import', `await (await import('${STARTUP_MODULE}')).runStartupGate()`],
    ['runStartupGate', 'an aliased destructured dynamic import', `const { runStartupGate: gate } = await import('${STARTUP_MODULE}')`],
    ['runStartupGate', 'a string-keyed destructuring', lines(STARTUP_NS, "const { 'runStartupGate': gate } = startup")],
    ['runStartupGate', 'the function passed on as a value', lines(`import { runStartupGate } from '${STARTUP_MODULE}'`, 'const deps = { initClient: runStartupGate }')],
    ['runStartupGate', 'a re-export', `export { runStartupGate } from '${STARTUP_MODULE}'`],
    ['runAgentDirectorStartupGate', 'a direct call', lines(`import { runAgentDirectorStartupGate } from '${STARTUP_MODULE}'`, 'await runAgentDirectorStartupGate()')],
    ['runAgentDirectorStartupGate', 'a namespace read', lines(STARTUP_NS, 'await startup.runAgentDirectorStartupGate()')],
  ]

  test.each(flagged)('%s: flags %s', (what, _label, source) => {
    expect(callSiteAudit(what)(parse(source)).length).toBeGreaterThan(0)
  })

  const TEXT_ONLY = (name: string): string => lines(
    `// ${name}()`,
    `/* await ${name}() */`,
    `const s = "${name}()"`,
    `const t = \`${name}()\``,
    `const r = /${name}\\(\\)/`,
  )

  const allowed: [what: string, label: string, source: string][] = [
    ['Client.create', 'a type-only import in types', lines("import type { Client } from 'agent-director'", 'let client: Client | undefined')],
    ['Client.create', 'a value import used only in types', lines(
      CLIENT_IMPORT,
      'let singleton: Client | null = null',
      'const c = x as Client',
      "type D = Pick<Client, 'decide'>",
      'type F = typeof Client.create',
      'class Fake implements Client {}',
    )],
    ['Client.create', 'another member of the class', lines(CLIENT_IMPORT, 'const n = Client.name')],
    ['Client.create', 'create on anything else', lines("import { Client } from './fake-client.ts'", 'await Client.create(opts)', 'await stub.Client.create(opts)', 'await factory.create(opts)')],
    ['Client.create', 'other names read through the namespace', lines(AD_NS, 'ad.ErrSystemInstallNotFound.name')],
    ['Client.create', 'text in strings, templates, regex literals and comments', lines(CLIENT_IMPORT, "// Client.create(opts)", "const s = 'Client.create(opts)'", 'const t = `Client.create()`', 'const r = /Client\\.create\\(/')],
    ['resolveSystemBinary', 'a type-only import', "import type { ResolveSystemBinaryResult } from 'agent-director'"],
    ['resolveSystemBinary', 'an injected resolver', lines(
      'interface Deps { resolveSystemBinary: () => Promise<unknown> }',
      'await deps.resolveSystemBinary()',
      'const stubbed = { resolveSystemBinary: stub }',
      'const settled = await settle(deps.resolveSystemBinary)',
    )],
    ['resolveSystemBinary', 'the same name from another module', lines("import { resolveSystemBinary } from './stub.ts'", 'await resolveSystemBinary()')],
    ['resolveSystemBinary', 'text in strings, templates, regex literals and comments', TEXT_ONLY('resolveSystemBinary')],
    ['runStartupGate', 'its own declaration', 'export async function runStartupGate() {}'],
    ['runStartupGate', 'a type-only import in a type query', lines(`import type { runStartupGate } from '${STARTUP_MODULE}'`, 'type Gate = typeof runStartupGate')],
    ['runStartupGate', 'another name holding it', lines(`import { runAgentDirectorStartupGate } from '${STARTUP_MODULE}'`, 'await runAgentDirectorStartupGate()')],
    ['runStartupGate', 'an object key', "const labels = { runStartupGate: 'gate' }"],
    ['runStartupGate', 'text in strings, templates, regex literals and comments', TEXT_ONLY('runStartupGate')],
    ['runAgentDirectorStartupGate', 'its own declaration', 'export async function runAgentDirectorStartupGate() {}'],
    ['runAgentDirectorStartupGate', 'text in strings, templates, regex literals and comments', TEXT_ONLY('runAgentDirectorStartupGate')],
  ]

  test.each(allowed)('%s: allows %s', (what, _label, source) => {
    expect(callSiteAudit(what)(parse(source))).toEqual([])
  })

  test('the audited files: every *.ts under src/ and scripts/, the pinned ones included', () => {
    const files = productionFiles().map((path) => relative(REPO_ROOT, path))

    expect(files).toEqual(expect.arrayContaining(['src/postinstall.ts', 'scripts/install-check.ts', ...CALL_SITE_AUDITS.flatMap((a) => a.files)]))
    expect(files.every((path) => path.startsWith(`src${sep}`) || path.startsWith(`scripts${sep}`))).toBe(true)
  })

  test.each(CALL_SITE_AUDITS.map((a) => [a.what, a] as const))('the current tree: %s is reached only in its pinned files, and in each of them', (_what, { audit, files }) => {
    const pinned = new Set(files)
    const others = productionFiles().filter((path) => !pinned.has(relative(REPO_ROOT, path)))

    expect(auditTree(others, audit)).toEqual([])
    expect(files.filter((path) => audit(parseFile(join(REPO_ROOT, path))).length === 0)).toEqual([])
  })

  test('the current tree: the startup gate module reaches Client.create at one place only', () => {
    const findings = clientCreateFindings(parseFile(join(SRC_DIR, 'agent-director-startup.ts')))

    expect(findings).toEqual([expect.stringMatching(/: read of Client\.create$/)])
  })
})

// ---------------------------------------------------------------------------
// Static audit: the /ci image marker and SCENARIO_ROOT checks come first (b.jg5 SRJ-1306)
// ---------------------------------------------------------------------------

const INTEGRATION_DIR = join(TESTS_DIR, 'integration')
const RUNNER_PATH = join(TESTS_DIR, 'runner.sh')
const SCENARIO_PATH = join(INTEGRATION_DIR, 'lib', 'scenario.sh')
const FMK_DRIVER_PATH = join(INTEGRATION_DIR, 'fixtures', 'fmk-driver.ts')
const STUB_MCP_SESSION_PATH = join(INTEGRATION_DIR, 'fixtures', 'stub-mcp-session.ts')
const SWITCH_OVER_PATH = join(INTEGRATION_DIR, 'fixtures', 'switch-over.ts')
const FMK_TEXTS_PATH = join(INTEGRATION_DIR, 'fixtures', 'fmk-texts.ts')

/**
 * The TypeScript fixtures run as a whole file in the image, each refusing
 * without the marker as its first statement and importing only `node:`
 * built-ins statically: the forced-call driver, the stub's MCP session and
 * the switch-over fixture and the scenario value printer.
 */
const IMAGE_GUARDED_TS_PATHS: readonly string[] = [FMK_DRIVER_PATH, STUB_MCP_SESSION_PATH, SWITCH_OVER_PATH, FMK_TEXTS_PATH]

/** The file only the cscb-ci images carry (docker/Dockerfile.test.base). */
const CI_IMAGE_MARKER = '/etc/cscb-ci-image'

/** The rule each finding names. */
const IMAGE_GUARD_RULE = {
  /** The marker check is the file's first step. */
  markerFirst: 'marker-check-first',
  /** A script that sources scenario.sh runs nothing before its source line. */
  sourceFirst: 'source-line-first',
  /** The HOME-under-SCENARIO_ROOT check comes before the helper's first step (sqlite3, copy, move, install, install.sh or agent-director run). */
  homeCheckFirst: 'home-check-before-step',
  /** A settings writer resolves its directory under SCENARIO_ROOT (`realpath -e`) before it removes, creates or writes there. */
  realpathCheckFirst: 'realpath-check-before-write',
  /** The image-guarded TypeScript fixtures statically import only `node:` built-ins. */
  driverStaticImport: 'driver-static-import',
  /** scenario.sh's Slack stub and stub MCP session helpers run `require_ci_image` as their first step after their declarations (b.deo SRI-1404). */
  helperImageCheckFirst: 'image-check-first-in-helper',
  /** The Slack stub, which has no marker check, statically imports only `node:` built-ins (b.deo SRI-1402). */
  stubStaticImport: 'stub-static-import',
} as const

/**
 * The scenario.sh functions with a step that need not run the HOME check,
 * each with why: primitives and setup that touch only SCENARIO_ROOT, and the
 * shared-mode helpers (shared mode has no scenario HOME to check). Every other
 * function of scenario.sh with a step (its own, or a call of a function with
 * one) must run `require_scenario_home` before its first, or be listed in
 * HOME_CHECKED_BY_CALLERS. A call of a listed function still counts as a step
 * in its caller.
 */
const HOME_CHECK_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['_scenario_place', 'the copy-and-rename primitive: it refuses outside the image and for a destination outside SCENARIO_ROOT, and each audited caller counts its call as a step'],
  ['write_file', 'the scripts’ file writer in both modes: it writes only the path its caller names, and each audited caller counts its call as a step'],
  ['write_config', 'shared mode’s config.json writer: it writes only SLACK_STATE_DIR’s config.json, and new_state_dir makes each state dir under SCENARIO_ROOT'],
  ['hold_not_applied', 'shared mode’s reload hold: its one copy snapshots config.json.last-applied from SLACK_STATE_DIR into SCENARIO_ROOT'],
  ['tmux_shim_mode', '_scenario_fmk_setup runs it before the scenario HOME is exported; it writes only the tmux shim’s mode file under SCENARIO_ROOT'],
  ['_scenario_tmux_shim_reset', 'the EXIT trap’s reset of the tmux shim’s mode file under SCENARIO_ROOT; it never fails, so the trap’s stops still run'],
  ['_scenario_cleanup', 'the EXIT trap: its only step is _scenario_tmux_shim_reset, and a refusal would skip the stops after it'],
  ['_scenario_fmk_setup', 'the setup that makes and exports the scenario HOME: before the export it only places files under SCENARIO_ROOT (_scenario_place, tmux_shim_mode); the installs after it are audited helpers'],
])




/**
 * The scenario.sh functions with a step that run only from audited helpers
 * after their `require_scenario_home` (callerCheckFindings checks it: every
 * place scenario.sh names one, and no script does), each with its callers.
 */
const HOME_CHECKED_BY_CALLERS: ReadonlyMap<string, string> = new Map([
  ['_scenario_row_json', 'the store-row read of ad_store_row and the store-statement helpers (ad_store_mark_finished, ad_store_seed_pending, ad_store_unusable_name, ad_store_pending_no_launch)'],
  ['_scenario_row_left_pending', 'seed_010_row’s wait_until predicate'],
  ['_scenario_seed', 'the one body of the seed_* helpers'],
  ['_scenario_require_010', 'the 0.10.0 seeders’ precondition (seed_010_row, seed_prepersona_fleet)'],
  ['_scenario_find_missing_loop', 'run_find_missing_loop’s background loop body'],
  ['_scenario_shim_over', 'the shim placement of install_ad_shim and install_ad_admin_shim'],
  ['_scenario_stand_in_settings', 'the stand-in settings write of install_ad_stand_in and restore_ad_install_with_stand_in'],
])

/** scenario.sh's guard that refuses unless HOME is under SCENARIO_ROOT. */
const HOME_GUARD = 'require_scenario_home'

/** scenario.sh's guard that refuses outside a cscb-ci image. */
const IMAGE_GUARD = 'require_ci_image'

/** Commands that are a sqlite3, copy, move or install step. */
const STORE_OR_FILE_STEPS: readonly string[] = ['sqlite3', 'cp', 'mv', 'install', 'rsync']

/** A command word that runs an install script (by its path or the variable holding it). */
const INSTALL_SCRIPT_WORD = /install\.sh$|_INSTALL_SH\}?$/

/** A path to agent-director's binary, agent-director-admin or the shim over either (`${HOME}/.agent-director/bin/agent-director`, `….real`, `${HOME}/.agent-director/admin/agent-director-admin`, an image copy). */
const AGENT_DIRECTOR_PATH = /(?:^|\/)agent-director(?:-admin)?(?:\.real)?$/

/** Reserved words that may stand before a command name; they open or close no step themselves. */
const SHELL_RESERVED: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', '!', '{', '}', 'time'])

/** Words that run the command after them (`command cp …`). */
const SHELL_PREFIXES: ReadonlySet<string> = new Set(['command', 'exec', 'nohup', 'builtin'])

/** `NAME=…` (or `NAME[i]=…`, `NAME+=…`) at the start of a word. */
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/

/**
 * What is not a step in a shell file, besides the shebang, comments and blank
 * lines (which the mask blanks): a line of `set` options, and an assignment of
 * a literal (no expansion, command substitution or second command).
 */
const SHELL_SET_OPTIONS = /^set(?:\s+[-+][A-Za-z]*o\s+[a-z]+|\s+[-+][A-Za-z]+)+$/
const SHELL_LITERAL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"$`\\]*"|'[^']*'|[A-Za-z0-9_./:@%+,=-]*)$/

/** One simple command of a shell file, as the audit reads it. */
interface ShellCommand {
  /** The command word with its quotes removed (`cp`, `require_scenario_home`, `${SCENARIO_RELEASE_INSTALL_SH}`); empty for a line of reserved words only (`fi`). */
  name: string
  /** The words after it, quotes removed. */
  args: string[]
  /** The `NAME=value` words before it (an `env` prefix's included), quotes removed. */
  assignments: string[]
  /** The reserved words before it (`if`, `then`, `{` …). */
  keywords: string[]
  /** What comes before it: '' (start of a logical line), `;`, `&&`, `||`, `|`, `&`, `(`, `)` or `$(` (inside a substitution). */
  after: string
  /**
   * What follows it: '' (the end of its logical line or substitution), `;`,
   * `&&`, `||`, `|`, `&`, `(` or `)`. Every command of an `&&` / `||` list
   * that ends with `&` has `&`, as bash runs the whole list in the background.
   */
  next: string
  /** Its 1-based line. */
  line: number
}

/** One logical line: up to a newline outside quotes, substitutions and line continuations. */
interface ShellLogicalLine {
  line: number
  /** The text with comments and heredoc bodies blanked. */
  text: string
  /** The text with quoted characters also blanked (to `_`, so a quoted word stays one word). */
  code: string
  /** Its commands, a substitution's before the command it is in (the order bash runs them). */
  commands: ShellCommand[]
}

/**
 * `source` with what is not code blanked, both outputs as long as `source`:
 * `text` blanks comments and heredoc bodies; `code` also blanks the
 * characters inside quotes to `_`, apart from a `$( … )` inside double quotes,
 * which is code. `breaks` are the offsets of the newlines that end a logical
 * line.
 */
function shellMask(source: string): { text: string; code: string; breaks: number[] } {
  const text: string[] = []
  const code: string[] = []
  const breaks: number[] = []
  const heredocs: { tag: string; strip: boolean }[] = []
  /** The open quotes and substitutions; a code frame counts its open parentheses. */
  const stack: ({ kind: 'code'; depth: number } | { kind: 'dquote' | 'squote' | 'ansi' })[] = [{ kind: 'code', depth: 0 }]
  const push = (raw: string, masked: string = raw): void => {
    text.push(raw)
    code.push(masked)
  }
  const blankUntilLineEnd = (from: number): number => {
    const end = source.indexOf('\n', from)
    const stop = end === -1 ? source.length : end
    for (let k = from; k < stop; k++) {
      text.push(' ')
      code.push(' ')
    }
    return stop
  }
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const frame = stack[stack.length - 1]
    if (frame.kind === 'code') {
      if (c === '\n') {
        push(c)
        if (stack.length === 1) breaks.push(i)
        i++
        while (stack.length === 1 && heredocs.length > 0) {
          const { tag, strip } = heredocs.shift()!
          while (i < source.length) {
            const lineStart = i
            i = blankUntilLineEnd(i)
            const bodyLine = source.slice(lineStart, i)
            if (i < source.length) {
              push('\n')
              breaks.push(i)
              i++
            }
            if ((strip ? bodyLine.replace(/^\t+/, '') : bodyLine) === tag) break
          }
        }
        continue
      }
      if (c === '\\' && i + 1 < source.length) {
        push(c + source[i + 1])
        i += 2
        continue
      }
      if (c === '#' && (i === 0 || /[\s;&|(]/.test(source[i - 1]))) {
        i = blankUntilLineEnd(i)
        continue
      }
      if (c === "'") stack.push({ kind: 'squote' })
      else if (c === '$' && source[i + 1] === "'") {
        stack.push({ kind: 'ansi' })
        push("$'")
        i += 2
        continue
      } else if (c === '"') stack.push({ kind: 'dquote' })
      else if (c === '<' && source[i + 1] === '<' && source[i + 2] !== '<') {
        const m = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(source.slice(i))
        if (m !== null) {
          heredocs.push({ tag: m[3], strip: m[1] === '-' })
          push(m[0])
          i += m[0].length
          continue
        }
      } else if (c === '(') frame.depth++
      else if (c === ')' && stack.length > 1) {
        if (frame.depth === 0) stack.pop()
        else frame.depth--
      }
      push(c)
      i++
      continue
    }
    if (frame.kind === 'squote') {
      if (c === "'") {
        stack.pop()
        push(c)
      } else push(c, '_')
      i++
    } else if (frame.kind === 'ansi') {
      if (c === '\\' && i + 1 < source.length) {
        push(c + source[i + 1], '__')
        i += 2
        continue
      }
      if (c === "'") {
        stack.pop()
        push(c)
      } else push(c, '_')
      i++
    } else {
      if (c === '\\' && i + 1 < source.length) {
        push(c + source[i + 1], '__')
        i += 2
      } else if (c === '"') {
        stack.pop()
        push(c)
        i++
      } else if (c === '$' && source[i + 1] === '(') {
        stack.push({ kind: 'code', depth: 0 })
        push('$(')
        i += 2
      } else {
        push(c, '_')
        i++
      }
    }
  }
  return { text: text.join(''), code: code.join(''), breaks }
}

/** The index of the `)` that closes the `(` at `open` in `code`, or `end` when none does. */
function closingParen(code: string, open: number, end: number): number {
  let depth = 0
  for (let k = open; k < end; k++) {
    if (code[k] === '(') depth++
    else if (code[k] === ')' && --depth === 0) return k
  }
  return end
}

/**
 * The simple commands in `code[start, end)` (`raw` is the file, `code` its
 * mask), appended to `out`. A `$( … )`, `<( … )` or `>( … )` stays part of
 * its word and its own commands are read first; a `(` that starts a word
 * opens a subshell.
 */
function shellCommandsIn(code: string, raw: string, start: number, end: number, lineAt: (offset: number) => number, out: ShellCommand[], firstAfter: string): void {
  let words: { raw: string; start: number }[] = []
  let after = firstAfter
  /** The commands of the `&&` / `||` list (and its pipelines) read so far. */
  let list: ShellCommand[] = []
  const flush = (separator: string): void => {
    if (words.length > 0) {
      const command = shellCommand(words, after, separator, lineAt)
      out.push(command)
      list.push(command)
    }
    if (separator === '&') for (const c of list) if (c.next === '&&' || c.next === '||') c.next = '&'
    if (separator !== '&&' && separator !== '||' && separator !== '|') list = []
    words = []
    after = separator
  }
  let i = start
  while (i < end) {
    const c = code[i]
    if (c === '\\' && code[i + 1] === '\n') i += 2
    else if (/\s/.test(c)) i++
    else if (c === ';') {
      flush(';')
      i += code[i + 1] === ';' ? 2 : 1
    } else if (c === '&' || c === '|') {
      const double = code[i + 1] === c
      flush(double ? c + c : c)
      i += double ? 2 : 1
    } else if (c === ')') {
      flush(')')
      i++
    } else if (c === '(' && code[i + 1] !== '(') {
      flush('(')
      i++
    } else {
      const wordStart = i
      while (i < end) {
        const d = code[i]
        if (d === '\\') {
          i += 2
          continue
        }
        if (/\s/.test(d) || d === ';' || d === '|' || d === ')') break
        if (d === '&' && code[i - 1] !== '>' && code[i + 1] !== '>') break
        if (d === '(') {
          const close = closingParen(code, i, end)
          if (i > wordStart && '$<>'.includes(code[i - 1])) shellCommandsIn(code, raw, i + 1, close, lineAt, out, '$(')
          i = close + 1
          continue
        }
        i++
      }
      words.push({ raw: raw.slice(wordStart, i), start: wordStart })
    }
  }
  flush('')
}

/**
 * A simple command from its words: reserved words, assignments and the
 * `command` / `exec` / `nohup` / `builtin` / `env` / `timeout` prefixes (with
 * their options) set aside.
 */
function shellCommand(words: readonly { raw: string; start: number }[], after: string, next: string, lineAt: (offset: number) => number): ShellCommand {
  const unquoted = words.map((w) => w.raw.replace(/["']/g, ''))
  const keywords: string[] = []
  const assignments: string[] = []
  /** The index after the options at `from` (`-x`, and the value of each option in `withValue`). */
  const pastOptions = (from: number, withValue: readonly string[]): number => {
    let at = from
    while (at < unquoted.length && unquoted[at].startsWith('-')) at += withValue.includes(unquoted[at]) ? 2 : 1
    return at
  }
  let k = 0
  while (k < unquoted.length) {
    const w = unquoted[k]
    if (SHELL_RESERVED.has(w)) keywords.push(w)
    else if (SHELL_ASSIGNMENT.test(words[k].raw)) assignments.push(w)
    else if (SHELL_PREFIXES.has(w)) {
      // `command -v` / `-V` only looks the name up: the command is `command` itself.
      if (w === 'command' && /^-[pvV]*[vV]/.test(unquoted[k + 1] ?? '')) break
      k = pastOptions(k + 1, ['-a'])
      continue
    } else if (w === 'env') {
      k++
      while (k < unquoted.length && (unquoted[k].startsWith('-') || SHELL_ASSIGNMENT.test(unquoted[k]))) {
        if (SHELL_ASSIGNMENT.test(unquoted[k])) assignments.push(unquoted[k])
        k += unquoted[k] === '-u' ? 2 : 1
      }
      continue
    } else if (w === 'timeout') {
      // The options, then the duration.
      k = pastOptions(k + 1, ['-s', '--signal', '-k', '--kill-after']) + 1
      continue
    } else break
    k++
  }
  return { name: unquoted[k] ?? '', args: unquoted.slice(k + 1), assignments, keywords, after, next, line: lineAt(words[0].start) }
}

/** `source` read as logical lines, each with its commands. */
function shellLogicalLines(source: string): ShellLogicalLine[] {
  const { text, code, breaks } = shellMask(source)
  const lineStarts = [0]
  for (let k = 0; k < source.length; k++) if (source[k] === '\n') lineStarts.push(k + 1)
  const lineAt = (offset: number): number => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const out: ShellLogicalLine[] = []
  let start = 0
  for (const end of [...breaks, source.length]) {
    const commands: ShellCommand[] = []
    shellCommandsIn(code, source, start, end, lineAt, commands, '')
    out.push({ line: lineAt(start), text: text.slice(start, end), code: code.slice(start, end), commands })
    start = end + 1
  }
  return out
}

/** Whether `line` is not a step: blank or comment only, `set` options, or a literal assignment. */
function isShellNonStep(line: ShellLogicalLine): boolean {
  const text = line.text.trim()
  return line.code.trim() === '' || SHELL_SET_OPTIONS.test(text) || SHELL_LITERAL_ASSIGNMENT.test(text)
}

/** How much `command` opens (+) or closes (−) a compound command. */
function shellDepthChange(command: ShellCommand): number {
  let change = ['case', 'for', 'select'].includes(command.name) ? 1 : 0
  for (const word of command.keywords) {
    if (['if', 'while', 'until', '{'].includes(word)) change++
    else if (['fi', 'done', 'esac', '}'].includes(word)) change--
  }
  return change
}

/** Whether `command` is unconditional: no reserved word before it, at the start of a logical line or after `;`. */
function isUnconditional(command: ShellCommand): boolean {
  return command.keywords.length === 0 && (command.after === '' || command.after === ';')
}

/** The first command of `line` that is not inside a substitution: the one the line starts with. */
function lineCommand(line: ShellLogicalLine): ShellCommand | undefined {
  return line.commands.find((command) => command.after === '')
}

/** Whether `line` starts by sourcing scenario.sh (`source` or `.`, naming `lib/scenario.sh`). */
function sourcesScenario(line: ShellLogicalLine): boolean {
  const command = lineCommand(line)
  return command !== undefined && (command.name === 'source' || command.name === '.') && /\/lib\/scenario\.sh\b/.test(line.text)
}

/**
 * Whether the commands from `at` on open with the marker check: `if` with
 * `[[ ! -e /etc/cscb-ci-image ]]` (or `[ … ]`, `test`, `-f`), whose `then`
 * branch exits with a non-zero status.
 */
function isShellMarkerCheck(commands: readonly ShellCommand[], at: number): boolean {
  const check = commands[at]
  if (check === undefined || check.after !== '' || check.keywords.join(' ') !== 'if') return false
  const test = [check.name, ...check.args]
  const shapes = [['[[', '!', '-e', CI_IMAGE_MARKER, ']]'], ['[', '!', '-e', CI_IMAGE_MARKER, ']'], ['test', '!', '-e', CI_IMAGE_MARKER]]
  if (!shapes.some((shape) => shape.length === test.length && shape.every((w, k) => w === test[k] || (w === '-e' && test[k] === '-f')))) return false
  let depth = 1
  for (const command of commands.slice(at + 1)) {
    if (depth === 1 && command.keywords.some((w) => w === 'else' || w === 'elif')) return false
    depth += shellDepthChange(command)
    if (depth <= 0) return false
    if (depth === 1 && command.name === 'exit' && /^[1-9][0-9]*$/.test(command.args[0] ?? '')) return true
  }
  return false
}

/**
 * The image-marker findings for the shell file `file`: when it sources
 * scenario.sh, its first step must be the source line (so the refusal is
 * scenario.sh's); otherwise its first step must be its own marker check.
 */
function shellEntryFindings(file: string, source: string): string[] {
  const lines = shellLogicalLines(source)
  const sourcing = lines.some(sourcesScenario)
  const first = lines.find((line) => !isShellNonStep(line))
  const shown = (line: ShellLogicalLine): string => line.text.trim().split('\n')[0]
  if (sourcing) {
    if (first !== undefined && sourcesScenario(first)) return []
    return [`${file}:${first?.line ?? 1}: ${IMAGE_GUARD_RULE.sourceFirst}: a step runs before the scenario.sh source line: ${first === undefined ? '' : shown(first)}`]
  }
  if (first === undefined) return [`${file}:1: ${IMAGE_GUARD_RULE.markerFirst}: no ${CI_IMAGE_MARKER} check`]
  const all = lines.flatMap((line) => line.commands)
  const opening = lineCommand(first)
  if (opening !== undefined && isShellMarkerCheck(all, all.indexOf(opening))) return []
  return [`${file}:${first.line}: ${IMAGE_GUARD_RULE.markerFirst}: the first step is not the ${CI_IMAGE_MARKER} check that exits non-zero: ${shown(first)}`]
}

/** The commands of each `name() {` … `}` function of `source` (braces in column 0), by name; the commands outside them go to `outside`. */
function shellFunctions(source: string, outside: ShellCommand[] = []): Map<string, ShellCommand[]> {
  const functions = new Map<string, ShellCommand[]>()
  let current: ShellCommand[] | undefined
  for (const line of shellLogicalLines(source)) {
    const opening = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{$/.exec(line.text.trim())
    if (current === undefined && opening !== null && line.text.startsWith(opening[1])) {
      current = []
      functions.set(opening[1], current)
    } else if (current !== undefined && /^\}\s*$/.test(line.text)) current = undefined
    else (current ?? outside).push(...line.commands)
  }
  return functions
}

/** Builtins whose arguments may be assignments (`local real="${HOME}/…"`). */
const SHELL_DECLARATIONS: ReadonlySet<string> = new Set(['local', 'declare', 'typeset', 'export', 'readonly'])

/**
 * The variables `commands` assign an agent-director path to, anywhere
 * (`local real="${HOME}/.agent-director/bin/agent-director.real"`,
 * `SCENARIO_AD_BIN="${HOME}/…"`, `SCENARIO_RELEASE_BIN=/opt/…/agent-director`).
 */
function agentDirectorPathVariables(commands: readonly ShellCommand[]): Set<string> {
  const names = new Set<string>()
  for (const c of commands) {
    for (const word of [...c.assignments, ...(SHELL_DECLARATIONS.has(c.name) ? c.args : [])]) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/.exec(word)
      if (m !== null && AGENT_DIRECTOR_PATH.test(m[2])) names.add(m[1])
    }
  }
  return names
}

/** Whether the command word `name` runs agent-director: by its path, or by a variable in `variables` (`"${real}"`, `"${SCENARIO_AD_BIN}"`). */
function runsAgentDirector(name: string, variables: ReadonlySet<string>): boolean {
  const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(?:\.real)?$/.exec(name)
  return AGENT_DIRECTOR_PATH.test(name) || (variable !== null && variables.has(variable[1]))
}

/** The functions of a shell file and which of its commands and functions are steps. */
interface ShellStepModel {
  functions: Map<string, ShellCommand[]>
  /** Whether a command is a step itself: sqlite3, a copy, move or install, an install.sh run or an agent-director run. */
  isOwnStep: (command: ShellCommand) => boolean
  /** The functions that make a step: their own, or through a call of another such function. */
  stepFunctions: Set<string>
}

/** `source`'s step model (see ShellStepModel). */
function shellStepModel(source: string): ShellStepModel {
  const functions = shellFunctions(source)
  const variables = agentDirectorPathVariables(shellLogicalLines(source).flatMap((line) => line.commands))
  const isOwnStep = (c: ShellCommand): boolean => STORE_OR_FILE_STEPS.includes(basename(c.name)) || INSTALL_SCRIPT_WORD.test(c.name) || runsAgentDirector(c.name, variables)
  const stepFunctions = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const [name, body] of functions) {
      if (!stepFunctions.has(name) && body.some((c) => isOwnStep(c) || stepFunctions.has(c.name))) {
        stepFunctions.add(name)
        grew = true
      }
    }
  }
  return { functions, isOwnStep, stepFunctions }
}

/** The functions of `source` the HOME-check audit holds: every one with a step, less HOME_CHECK_EXEMPT and HOME_CHECKED_BY_CALLERS. */
function homeCheckedHelpers(source: string): string[] {
  return [...shellStepModel(source).stepFunctions].filter((name) => !HOME_CHECK_EXEMPT.has(name) && !HOME_CHECKED_BY_CALLERS.has(name)).sort()
}

/**
 * The HOME-check findings for `helpers` (by default homeCheckedHelpers:
 * every function of `source` with a step, less the two lists) in the shell
 * file `file`:
 * each must call `require_scenario_home` unconditionally (at the top of its
 * body, not after `&&`, `||` or `|`, nor in a subshell or substitution)
 * before its first step: sqlite3, a copy, move or install, an install.sh run,
 * or a run of agent-director by its path or a variable holding one. A call of
 * a function of the same file that makes such a step, directly or through
 * another, counts as one (so a copy delegated to `_scenario_place` is still a
 * step). A named helper that is not defined, or has no step the audit can
 * see, is a finding too.
 */
function helperHomeCheckFindings(file: string, source: string, helpers: readonly string[] = homeCheckedHelpers(source)): string[] {
  const { functions, isOwnStep, stepFunctions } = shellStepModel(source)
  const findings: string[] = []
  const rule = IMAGE_GUARD_RULE.homeCheckFirst
  for (const helper of helpers) {
    const body = functions.get(helper)
    if (body === undefined) {
      findings.push(`${file}:1: ${rule}: ${helper} is not defined`)
      continue
    }
    const firstStep = body.findIndex((c) => isOwnStep(c) || stepFunctions.has(c.name))
    if (firstStep < 0) {
      findings.push(`${file}:1: ${rule}: ${helper} has no step the audit can see`)
      continue
    }
    const guard = homeGuardIndex(body)
    if (guard < 0 || guard > firstStep) {
      const step = body[firstStep]
      findings.push(`${file}:${step.line}: ${rule}: ${helper}: \`${step.name}\` runs before ${guard < 0 ? `any unconditional ${HOME_GUARD}` : HOME_GUARD}`)
    }
  }
  return findings
}

/** The index in `body` of its first unconditional `require_scenario_home` (top level, not after `&&`, `||` or `|`, nor in a subshell or substitution); -1 when none. */
function homeGuardIndex(body: readonly ShellCommand[]): number {
  let depth = 0
  for (let k = 0; k < body.length; k++) {
    const c = body[k]
    if (depth === 0 && c.name === HOME_GUARD && isUnconditional(c)) return k
    depth += shellDepthChange(c)
  }
  return -1
}

/** Whether `command` names the function `name`: as the command, or as an argument word (`wait_until 10 x _scenario_row_left_pending …`). */
function namesFunction(command: ShellCommand, name: string): boolean {
  return command.name === name || command.args.includes(name)
}

/**
 * The findings for HOME_CHECKED_BY_CALLERS (or `listed`) in the shell file
 * `file` (scenario.sh) and the `scripts` that source it: each listed name is
 * a function of `source` with a step; every command of `source` that names it
 * is in an audited helper (a function with a step, not listed here nor in
 * HOME_CHECK_EXEMPT) after that helper's unconditional `require_scenario_home`,
 * or in another listed function; and no command outside a function, nor any
 * script, names it.
 */
function callerCheckFindings(file: string, source: string, scripts: readonly { file: string; source: string }[], listed: ReadonlyMap<string, string> = HOME_CHECKED_BY_CALLERS): string[] {
  const { functions, stepFunctions } = shellStepModel(source)
  const rule = IMAGE_GUARD_RULE.homeCheckFirst
  const findings: string[] = []
  const outside: ShellCommand[] = []
  shellFunctions(source, outside)
  for (const name of listed.keys()) {
    if (!stepFunctions.has(name)) {
      findings.push(`${file}:1: ${rule}: ${name} is listed as checked by its callers but is ${functions.has(name) ? 'a function with no step' : 'not defined'}`)
      continue
    }
    for (const [caller, body] of functions) {
      if (listed.has(caller)) continue
      const guard = HOME_CHECK_EXEMPT.has(caller) ? -1 : homeGuardIndex(body)
      body.forEach((c, k) => {
        if (namesFunction(c, name) && (guard < 0 || guard > k)) findings.push(`${file}:${c.line}: ${rule}: ${caller} runs ${name} before ${guard < 0 ? `any unconditional ${HOME_GUARD}` : HOME_GUARD}`)
      })
    }
    for (const c of outside) if (namesFunction(c, name)) findings.push(`${file}:${c.line}: ${rule}: ${name} runs outside any helper`)
    for (const script of scripts) {
      for (const c of shellLogicalLines(script.source).flatMap((line) => line.commands)) {
        if (namesFunction(c, name)) findings.push(`${script.file}:${c.line}: ${rule}: ${name} runs from a script, not from a helper after its ${HOME_GUARD}`)
      }
    }
  }
  return findings
}

/**
 * scenario.sh's settings writers, each with the directory word its
 * `realpath -e` check resolves and the commands that check must come before:
 * `write_ad_settings` removes the settings file or creates its directory;
 * `_scenario_stand_in_settings` writes the stand-in's settings.
 */
const REALPATH_CHECKED_WRITERS: readonly { helper: string; dir: string; steps: readonly string[] }[] = [
  { helper: 'write_ad_settings', dir: '${dir}', steps: ['rm', 'mkdir'] },
  { helper: '_scenario_stand_in_settings', dir: '${bin}', steps: ['write_file'] },
]

/**
 * The containment-check findings of the settings writers in the shell file
 * `file`: in each, a `realpath -e` of its directory word comes before the
 * first of each of its steps. A writer, or a step, the audit cannot find is a
 * finding too.
 */
function realpathCheckFindings(file: string, source: string): string[] {
  const functions = shellFunctions(source)
  const findings: string[] = []
  const rule = IMAGE_GUARD_RULE.realpathCheckFirst
  for (const { helper, dir, steps } of REALPATH_CHECKED_WRITERS) {
    const body = functions.get(helper)
    if (body === undefined) {
      findings.push(`${file}:1: ${rule}: ${helper} is not defined`)
      continue
    }
    const check = body.findIndex((c) => c.name === 'realpath' && c.args.includes('-e') && c.args.includes(dir))
    for (const name of steps) {
      const at = body.findIndex((c) => c.name === name)
      if (at < 0) findings.push(`${file}:1: ${rule}: ${helper} has no \`${name}\` the audit can see`)
      else if (check < 0 || check > at) findings.push(`${file}:${body[at].line}: ${rule}: ${helper}: \`${name}\` runs before the realpath -e check of ${dir}`)
    }
  }
  return findings
}

/** Whether `statement` is the driver's marker check: `if (!existsSync('/etc/cscb-ci-image'))` (existsSync from `node:fs`) whose branch calls `process.exit` with a non-zero literal. */
function isDriverMarkerCheck(statement: ts.Statement, sf: ts.SourceFile): boolean {
  if (!ts.isIfStatement(statement)) return false
  const condition = unwrap(statement.expression)
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false
  const call = unwrap(condition.operand)
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.arguments.length !== 1 || stringText(call.arguments[0]) !== CI_IMAGE_MARKER) return false
  const local = call.expression.text
  const fromNodeFs = sf.statements.some((s) => {
    if (!ts.isImportDeclaration(s) || stringText(s.moduleSpecifier) !== 'node:fs' || s.importClause === undefined || s.importClause.isTypeOnly) return false
    const bindings = s.importClause.namedBindings
    return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.some((e) => !e.isTypeOnly && e.name.text === local && (e.propertyName ?? e.name).text === 'existsSync')
  })
  if (!fromNodeFs) return false
  let exits = false
  forEachNode(statement.thenStatement, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.arguments.length !== 1) return
    const target = node.expression
    const code = node.arguments[0]
    if (ts.isIdentifier(target.expression) && target.expression.text === 'process' && target.name.text === 'exit' && ts.isNumericLiteral(code) && Number(code.text) !== 0) exits = true
  })
  return exits
}

/** The module a top-level statement loads statically: an import's or an `export … from`'s specifier; undefined for any other statement. */
function staticLoadOf(s: ts.Statement): ts.Expression | undefined {
  return ts.isImportDeclaration(s) || ts.isExportDeclaration(s) ? s.moduleSpecifier : undefined
}

/**
 * The static-import matcher: a finding, naming `rule` and ending with `why`,
 * for every static import or `export … from` in `sf` (the file `file`) of
 * anything but a `node:` built-in, type-only included.
 */
function nodeOnlyImportFindings(file: string, sf: ts.SourceFile, rule: string, why: string): string[] {
  const findings: string[] = []
  for (const s of sf.statements) {
    const specifier = staticLoadOf(s)
    if (specifier === undefined) continue
    const text = stringText(specifier)
    if (text === undefined || !text.startsWith('node:')) findings.push(`${file}:${finding(sf, s, `${rule}: static import of '${text ?? specifier.getText(sf)}' ${why}`)}`)
  }
  return findings
}

/**
 * The findings for the driver `file`: every static import or `export … from`
 * of anything but a `node:` built-in (it is evaluated before the file's first
 * statement, wherever it stands, type-only included), and a first statement
 * (after the static imports) that is not the marker check.
 */
function driverGuardFindings(file: string, source: string): string[] {
  const sf = parse(source, file)
  const at = (node: ts.Node, rule: string, what: string): string => `${file}:${finding(sf, node, `${rule}: ${what}`)}`
  const findings = nodeOnlyImportFindings(file, sf, IMAGE_GUARD_RULE.driverStaticImport, `is evaluated before the ${CI_IMAGE_MARKER} check`)
  const first = sf.statements.find((s) => staticLoadOf(s) === undefined)
  if (first === undefined) findings.push(`${file}:1: ${IMAGE_GUARD_RULE.markerFirst}: no ${CI_IMAGE_MARKER} check`)
  else if (!isDriverMarkerCheck(first, sf)) findings.push(at(first, IMAGE_GUARD_RULE.markerFirst, `the first step is not the ${CI_IMAGE_MARKER} check that exits non-zero: ${first.getText(sf).split('\n')[0]}`))
  return findings
}

/** Every `tests/integration/test-*.sh`, read from the directory. */
function integrationScripts(): string[] {
  return readdirSync(INTEGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^test-.*\.sh$/.test(entry.name))
    .map((entry) => join(INTEGRATION_DIR, entry.name))
    .sort()
}

/** Asserts `findings` is not empty, each names `file`, and one names `rule`. */
function expectNamedFindings(findings: readonly string[], file: string, rule: string): void {
  expect(findings.length).toBeGreaterThan(0)
  expect(findings.filter((f) => !f.startsWith(`${file}:`))).toEqual([])
  expect(findings).toContainEqual(expect.stringMatching(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+: ${rule}: `)))
}

describe('static audit: the /ci image marker and SCENARIO_ROOT checks come first (b.jg5 SRJ-1306)', () => {
  // What is not a step. Shell: the shebang, comments, blank lines, `set`
  // options and literal assignments. The TypeScript fixtures: static imports
  // of `node:` built-ins; a static import of any other module is a step, since
  // it is evaluated before the check. These files are read, never run.

  const MARKER_CHECK = lines(
    `if [[ ! -e ${CI_IMAGE_MARKER} ]]; then`,
    `    echo "FAIL: x: refused: ${CI_IMAGE_MARKER} is absent" >&2`,
    '    exit 1',
    'fi',
  )
  const SOURCE_LINE = 'source "$(dirname "$0")/lib/scenario.sh"'
  const RULE = IMAGE_GUARD_RULE

  describe('the marker check, or the source line, is the first step', () => {
    const flagged: [label: string, file: string, rule: string, source: string][] = [
      ['a mkdir before the check', 'tests/runner.sh', RULE.markerFirst, lines('#!/usr/bin/env bash', 'set -uo pipefail', 'mkdir -p /test-results', MARKER_CHECK)],
      ['an assignment from a command substitution before the check', 'tests/runner.sh', RULE.markerFirst, lines('TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"', MARKER_CHECK)],
      ['an assignment that expands a variable before the check', 'scenario.sh', RULE.markerFirst, lines('SCENARIO_ROOT="${TMPDIR}/x"', MARKER_CHECK)],
      ['an export before the check', 'scenario.sh', RULE.markerFirst, lines('export HOME=/tmp/x', MARKER_CHECK)],
      ['a command after the set options on the same line', 'test-1-x.sh', RULE.markerFirst, lines('set -e; cd /test-repo', MARKER_CHECK)],
      ['a trap before the check', 'scenario.sh', RULE.markerFirst, lines("trap 'rm -rf /tmp/x' EXIT", MARKER_CHECK)],
      ['the check inside a function (the definition comes first)', 'test-1-x.sh', RULE.markerFirst, lines('refuse() {', MARKER_CHECK, '}', 'refuse')],
      ['a check that exits 0', 'test-1-x.sh', RULE.markerFirst, MARKER_CHECK.replace('exit 1', 'exit 0')],
      ['a check that only prints', 'test-1-x.sh', RULE.markerFirst, MARKER_CHECK.replace('    exit 1\n', '')],
      ['a check that exits only in its else branch', 'test-1-x.sh', RULE.markerFirst, MARKER_CHECK.replace('    exit 1', '    :\nelse\n    exit 1')],
      ['a check of another file', 'test-1-x.sh', RULE.markerFirst, MARKER_CHECK.replace(`! -e ${CI_IMAGE_MARKER} ]]`, '! -e /etc/hostname ]]')],
      ['a test script that neither sources scenario.sh nor checks the marker', 'test-14-x.sh', RULE.markerFirst, lines('#!/usr/bin/env bash', 'set -euo pipefail', 'TEST_NAME="test-14-x"', 'cd /test-repo')],
      ['a script whose marker check and source line are only in comments and strings', 'test-14-x.sh', RULE.markerFirst, lines(`# ${MARKER_CHECK.split('\n')[0]}`, `# ${SOURCE_LINE}`, 'echo "source lib/scenario.sh"')],
      ['a cd before the source line', 'test-13-fmk-x.sh', RULE.sourceFirst, lines('#!/usr/bin/env bash', 'set -euo pipefail', 'TEST_NAME="test-13-fmk-x"', 'cd /test-repo', SOURCE_LINE)],
      ['an assignment from a command substitution before the source line', 'test-13-fmk-x.sh', RULE.sourceFirst, lines('set -euo pipefail', 'STAMP="$(date +%s)"', SOURCE_LINE)],
      ['a second command on the TEST_NAME line', 'test-13-fmk-x.sh', RULE.sourceFirst, lines('TEST_NAME="test-13-fmk-x"; rm -rf /tmp/x', SOURCE_LINE)],
    ]

    test.each(flagged)('flags %s, naming the file and the rule', (_label, file, rule, source) => {
      expectNamedFindings(shellEntryFindings(file, source), file, rule)
    })

    const allowed: [label: string, source: string][] = [
      ['the shebang, comments, blank lines and set options before the check', lines('#!/usr/bin/env bash', '# Runs only in a cscb-ci image.', '', 'set -uo pipefail', 'set -e -o pipefail', '', MARKER_CHECK, 'mkdir -p /test-results')],
      ['literal assignments (double-quoted, single-quoted and bare) before the check', lines('A="literal text"', "B='single $x'", 'C=0.10.0', MARKER_CHECK)],
      ['the check with [ ], -f and the marker quoted', lines(`if [ ! -f "${CI_IMAGE_MARKER}" ]; then`, '    exit 2', 'fi')],
      ['the check, then set options and steps', lines(MARKER_CHECK, '', 'set -euo pipefail', 'cd /test-repo')],
      ['a sourcing script with set options and literal assignments before its source line', lines('#!/usr/bin/env bash', '# Test 13.', 'set -euo pipefail', '', 'TEST_NAME="test-13-fmk-x"', 'SCENARIO_AD_START=0.10.0', '# shellcheck source=lib/scenario.sh', SOURCE_LINE, 'cd /test-repo')],
      ['a sourcing script using `.`', lines('set -euo pipefail', '. "$(dirname "$0")/lib/scenario.sh"', 'cd /test-repo')],
    ]

    test.each(allowed)('allows %s', (_label, source) => {
      expect(shellEntryFindings('x.sh', source)).toEqual([])
    })

    test('the current tree: runner.sh and scenario.sh check the marker before their first other step', () => {
      const findings = [RUNNER_PATH, SCENARIO_PATH].flatMap((path) => shellEntryFindings(relative(REPO_ROOT, path), readFileSync(path, 'utf-8')))

      expect(findings).toEqual([])
    })

    test('the current tree: each test-*.sh that does not source scenario.sh checks the marker first, and each that does runs nothing before its source line', () => {
      const scripts = integrationScripts().map((path) => ({ file: relative(REPO_ROOT, path), source: readFileSync(path, 'utf-8') }))
      const sourcing = scripts.filter(({ source }) => shellLogicalLines(source).some(sourcesScenario))

      expect(sourcing.length).toBeGreaterThan(0)
      expect(scripts.length - sourcing.length).toBeGreaterThan(0)
      expect(scripts.flatMap(({ file, source }) => shellEntryFindings(file, source))).toEqual([])
    })
  })

  describe('the HOME-under-SCENARIO_ROOT check comes before each scenario.sh helper’s first step', () => {
    const PRELUDE = lines(
      'fail() {',
      '    echo "FAIL: $1" >&2',
      '    exit 1',
      '}',
      'require_ci_image() {',
      `    [[ -e ${CI_IMAGE_MARKER} ]] || fail "refused"`,
      '}',
      `${HOME_GUARD}() {`,
      '    [[ "${HOME}" == "${SCENARIO_ROOT}"/* ]] || fail "refused"',
      '}',
      '_scenario_place() {',
      '    require_ci_image "$3"',
      '    cp -- "$1" "$2.tmp" || fail "$3: could not copy"',
      '    mv -f -- "$2.tmp" "$2" || fail "$3: could not rename"',
      '}',
      'write_file() {',
      '    cat > "$1.tmp" || fail "write_file: could not write $1"',
      '    mv -f "$1.tmp" "$1" || fail "write_file: could not rename into $1"',
      '}',
      'SCENARIO_AD_BIN="${HOME}/.agent-director/bin/agent-director"',
    )
    const GUARDS = lines('    require_ci_image "${step}"', `    ${HOME_GUARD} "\${step}"`)
    const BODIES: Readonly<Record<string, string>> = {
      install_ad_shim: lines(
        '    local step="${1:-install the agent-director shim}"',
        GUARDS,
        '    local path="${HOME}/.agent-director/bin/agent-director"',
        '    mv -f -- "${path}" "${path}.real" || fail "${step}: could not move ${path}"',
        '    _scenario_place "${SCENARIO_AD_SHIM_SRC}" "${path}" "${step}"',
      ),
      ad_store_edit: lines(
        '    local step=ad_store_edit out',
        GUARDS,
        '    out="$(sqlite3 -batch -bail "${HOME}/.agent-director/state.db" "$1;" 2>&1)" \\',
        '        || fail "ad_store_edit: sqlite3 failed: ${out}"',
      ),
      ad_store_id: lines(
        '    local step=ad_store_id out',
        GUARDS,
        '    out="$(sqlite3 -batch -readonly "${HOME}/.agent-director/state.db" \\',
        `        "SELECT value FROM store_meta WHERE key = 'store_id';" 2>&1)" || fail "ad_store_id: \${out}"`,
      ),
      ad_store_backup: lines(
        '    local dest="${1:-}" step out',
        '    step="ad_store_backup ${dest}"',
        GUARDS,
        `    out="$(sqlite3 -batch -bail -readonly "\${HOME}/.agent-director/state.db" ".backup '\${dest}'" 2>&1)" \\`,
        '        || fail "${step}: sqlite3 .backup failed: ${out}"',
      ),
    }
    const SYNTHETIC_HELPERS = Object.keys(BODIES)
    /** `name() {` `body` `}`. */
    const fn = (name: string, ...body: string[]): string => lines(`${name}() {`, ...body, '}')
    /**
     * A scenario.sh-shaped source: the guards, `_scenario_place`, `write_file`
     * and SCENARIO_AD_BIN, the four helpers with `bodies` replacing theirs
     * (undefined leaves one out), then `extra`.
     */
    function helperSource(bodies: Readonly<Record<string, string | undefined>> = {}, ...extra: string[]): string {
      const helpers = SYNTHETIC_HELPERS.flatMap((name) => {
        const body = name in bodies ? bodies[name] : BODIES[name]
        return body === undefined ? [] : [fn(name, body)]
      })
      return lines(PRELUDE, ...helpers, ...extra)
    }

    // Each row's source is audited as a whole: every function with a step,
    // less HOME_CHECK_EXEMPT and HOME_CHECKED_BY_CALLERS, is held to the rule.
    const flagged: [label: string, source: string][] = [
      ['install_ad_shim: a copy before its HOME check', helperSource({ install_ad_shim: lines('    cp -- "${HOME}/.agent-director/bin/agent-director" /tmp/ad.bak', GUARDS, BODIES.install_ad_shim) })],
      ['install_ad_shim: a move before its HOME check', helperSource({ install_ad_shim: lines('    require_ci_image x', '    mv -f -- "${HOME}/.agent-director/bin/agent-director" /tmp/ad', `    ${HOME_GUARD} x`) })],
      ['install_ad_shim: the copy delegated to _scenario_place before its HOME check', helperSource({ install_ad_shim: lines('    require_ci_image x', '    _scenario_place "${SCENARIO_AD_SHIM_SRC}" "${HOME}/.agent-director/bin/agent-director" x', `    ${HOME_GUARD} x`) })],
      ['install_ad_shim: an install.sh run before its HOME check', helperSource({ install_ad_shim: lines('    (cd "${HOME}" && "${SCENARIO_RELEASE_INSTALL_SH}" --binary /opt/ad --no-hooks) < /dev/null', GUARDS) })],
      ['ad_store_edit: sqlite3 in a command substitution before its HOME check', helperSource({ ad_store_edit: lines('    require_ci_image x', '    local out="$(sqlite3 "${HOME}/.agent-director/state.db" "$1;")"', `    ${HOME_GUARD} x`) })],
      ['ad_store_edit: the HOME check only after an ||', helperSource({ ad_store_edit: lines('    [[ -f "${HOME}/.agent-director/state.db" ]] || ' + `${HOME_GUARD} x`, '    sqlite3 "${HOME}/.agent-director/state.db" "$1;"') })],
      ['ad_store_edit: the HOME check only in a subshell', helperSource({ ad_store_edit: lines(`    ( ${HOME_GUARD} x )`, '    sqlite3 "${HOME}/.agent-director/state.db" "$1;"') })],
      ['ad_store_id: the HOME check only inside an if', helperSource({ ad_store_id: lines('    if [[ -n "${STRICT:-}" ]]; then', `        ${HOME_GUARD} x`, '    fi', '    sqlite3 -readonly "${HOME}/.agent-director/state.db" "SELECT 1;"') })],
      ['ad_store_id: no HOME check at all', helperSource({ ad_store_id: lines('    require_ci_image x', '    sqlite3 -readonly "${HOME}/.agent-director/state.db" "SELECT 1;"') })],
      ['ad_store_backup: the .backup before its HOME check', helperSource({ ad_store_backup: lines('    require_ci_image x', `    sqlite3 -readonly "\${HOME}/.agent-director/state.db" ".backup '$1'"`, `    ${HOME_GUARD} x`) })],
      ['ad_store_backup: only the image check', helperSource({ ad_store_backup: lines('    require_ci_image x', `    sqlite3 -readonly "\${HOME}/.agent-director/state.db" ".backup '$1'"`) })],
      ['a new helper with a copy and no HOME check', helperSource({}, fn('stash_store', '    require_ci_image x', '    cp -- "${HOME}/.agent-director/state.db" "${SCENARIO_ROOT}/s.db"'))],
      ['a new helper running agent-director by its HOME path before the check', helperSource({}, fn('ad_version', '    "${HOME}/.agent-director/bin/agent-director" version', `    ${HOME_GUARD} x`))],
      ['a new helper running the binary behind the shim through a local holding its path', helperSource({}, fn('ad_real_version', '    local real="${HOME}/.agent-director/bin/agent-director.real" out', '    out="$("${real}" version)"'))],
      ['a new helper running the shim by SCENARIO_AD_BIN', helperSource({}, fn('ad_list', '    "${SCENARIO_AD_BIN}" list'))],
      ['a new helper running agent-director through exec -a', helperSource({}, fn('ad_exec', '    exec -a agent-director "${HOME}/.agent-director/bin/agent-director" list'))],
      ['a new helper running agent-director under timeout with a signal option', helperSource({}, fn('ad_bounded', '    timeout -s KILL 5 "${SCENARIO_AD_BIN}" list'))],
      ['a new helper running install.sh', helperSource({}, fn('reinstall_ad', '    "${SCENARIO_RELEASE_INSTALL_SH}" --binary /opt/ad --no-hooks'))],
      ['a new helper whose only step is a call of an exempt primitive (write_file)', helperSource({}, fn('write_ad_config', '    write_file "${HOME}/.agent-director/config.toml" <<< "x"'))],
      ['a new helper whose only step is a call of another helper', helperSource({}, fn('store_id_twice', '    ad_store_id', '    ad_store_id'))],
    ]

    test.each(flagged)('flags %s, naming the file and the rule', (_label, source) => {
      expectNamedFindings(helperHomeCheckFindings('scenario.sh', source), 'scenario.sh', RULE.homeCheckFirst)
    })

    const flaggedNamed: [label: string, bodies: Record<string, string | undefined>][] = [
      ['install_ad_shim: left out', { install_ad_shim: undefined }],
      ['ad_store_id: no step the audit can see', { ad_store_id: lines(GUARDS, '    read_store_id_somehow') }],
    ]

    test.each(flaggedNamed)('a named helper list: flags %s', (_label, bodies) => {
      expectNamedFindings(helperHomeCheckFindings('scenario.sh', helperSource(bodies), SYNTHETIC_HELPERS), 'scenario.sh', RULE.homeCheckFirst)
    })

    const allowed: [label: string, source: string][] = [
      ['the guards first, then the steps', helperSource()],
      ['step words in comments, strings and a heredoc before the HOME check', helperSource({
        install_ad_shim: lines(
          '    # cp the shim aside, then mv it into place',
          '    local step="${1:-cp and mv the shim}" note=\'sqlite3 install\'',
          '    cat <<EOF >&2',
          'cp a b',
          'EOF',
          '    echo "mv ${note}" >&2',
          GUARDS,
          '    mv -f -- "${HOME}/a" "${HOME}/b"',
        ),
      })],
      ['a read-only grep of the shim before the HOME check', helperSource({ install_ad_shim: lines('    grep -qxF -- "# marker" "${SCENARIO_AD_SHIM_SRC}" || fail x', GUARDS, '    _scenario_place a "${HOME}/b" x') })],
      ['a new helper with its HOME check before its agent-director run', helperSource({}, fn('ad_version', `    ${HOME_GUARD} x`, '    "${HOME}/.agent-director/bin/agent-director" version'))],
      ['a lookup with command -v, and a run of another tool through a variable, before the check', helperSource({}, fn('ad_found', '    local tool="${HOME}/bin/jq"', '    command -v agent-director > /dev/null', '    "${tool}" -n 1', `    ${HOME_GUARD} x`, '    ad_store_id'))],
    ]

    test.each(allowed)('allows %s', (_label, source) => {
      expect(helperHomeCheckFindings('scenario.sh', source)).toEqual([])
    })

    test('the exempt primitives (_scenario_place, write_file) have a step and no HOME check, and are not held to the rule', () => {
      const source = helperSource()

      expect([...shellStepModel(source).stepFunctions].sort()).toEqual(['_scenario_place', 'ad_store_backup', 'ad_store_edit', 'ad_store_id', 'install_ad_shim', 'write_file'])
      expect(homeCheckedHelpers(source)).toEqual(['ad_store_backup', 'ad_store_edit', 'ad_store_id', 'install_ad_shim'])
    })

    describe('the helpers checked by their callers (HOME_CHECKED_BY_CALLERS)', () => {
      const PRIVATE = '_scenario_store_peek'
      const LISTED: ReadonlyMap<string, string> = new Map([[PRIVATE, 'a synthetic private read']])
      const PRIVATE_FN = fn(PRIVATE, '    sqlite3 -readonly "${HOME}/.agent-director/state.db" "$1;"')
      const callerSource = (...extra: string[]): string => helperSource({}, PRIVATE_FN, ...extra)

      const flaggedCallers: [label: string, source: string, scripts: { file: string; source: string }[]][] = [
        ['a call before the caller’s HOME check', callerSource(fn('peek_rows', '    require_ci_image x', `    ${PRIVATE} "SELECT 1"`, `    ${HOME_GUARD} x`)), []],
        ['a call from a function with no HOME check', callerSource(fn('peek_rows', `    ${PRIVATE} "SELECT 1"`)), []],
        ['a call named as an argument (a wait_until predicate) before the check', callerSource(fn('wait_rows', `    wait_until 10 "rows" ${PRIVATE} "SELECT 1"`, `    ${HOME_GUARD} x`)), []],
        ['a call from an exempt function', callerSource(fn('write_file', `    ${PRIVATE} "SELECT 1"`)), []],
        ['a call in a subshell before the check', callerSource(fn('peek_rows', `    ( ${PRIVATE} "SELECT 1" ) &`, `    ${HOME_GUARD} x`)), []],
        ['a call outside any function', callerSource(`${PRIVATE} "SELECT 1"`), []],
        ['a call from a script', callerSource(), [{ file: 'test-14-fmk-x.sh', source: lines('source "$(dirname "$0")/lib/scenario.sh"', `${PRIVATE} "SELECT 1"`) }]],
        ['a listed name with no step', helperSource({}, fn(PRIVATE, '    echo "$1"')), []],
        ['a listed name that is not defined', helperSource(), []],
      ]

      test.each(flaggedCallers)('flags %s', (_label, source, scripts) => {
        const findings = callerCheckFindings('scenario.sh', source, scripts, LISTED)

        expect(findings.length).toBeGreaterThan(0)
        expect(findings.every((f) => new RegExp(`^(?:scenario\\.sh|test-14-fmk-x\\.sh):\\d+: ${RULE.homeCheckFirst}: `).test(f))).toBe(true)
      })

      test('allows calls only after each caller’s HOME check, from a function or a subshell, as an argument too', () => {
        const source = callerSource(
          fn('peek_rows', `    ${HOME_GUARD} x`, `    ${PRIVATE} "SELECT 1"`, `    ( ${PRIVATE} "SELECT 2" ) &`),
          fn('wait_rows', `    ${HOME_GUARD} x`, `    wait_until 10 "rows" ${PRIVATE} "SELECT 1"`),
        )
        const scripts = [{ file: 'test-14-fmk-x.sh', source: lines('source "$(dirname "$0")/lib/scenario.sh"', 'peek_rows', `# ${PRIVATE}`, `echo "run ${PRIVATE} later"`) }]

        expect(callerCheckFindings('scenario.sh', source, scripts, LISTED)).toEqual([])
      })
    })

    /** scenario.sh as it stands, and its scripts. */
    const scenario = (): string => readFileSync(SCENARIO_PATH, 'utf-8')
    const scripts = (): { file: string; source: string }[] => integrationScripts().map((path) => ({ file: relative(REPO_ROOT, path), source: readFileSync(path, 'utf-8') }))

    test('the current tree: every scenario.sh function with a step, less the two lists, runs require_scenario_home before its first', () => {
      const source = scenario()

      // The helpers the audit must find a step in (a parse that lost steps would shrink the set).
      expect(homeCheckedHelpers(source)).toEqual(expect.arrayContaining([
        'install_ad_shim', 'install_ad_admin_shim', 'install_ad_release', 'install_ad_010', 'reshim_ad', 'swap_ad_binary', 'hide_ad_install', 'restore_ad_install',
        'ad', 'ad_capture', 'ad_admin', 'ad_admin_capture', '_scenario_store_read', 'ad_store_edit', 'ad_store_id', 'ad_store_backup', 'ad_store_pending_no_launch', 'stub_mode', 'stub_dialog_delay', 'write_ad_settings', 'install_ad_stand_in', 'restore_ad_install_with_stand_in',
        'ad_new_token', 'ad_other_store_id', 'ad_owner_label', 'seed_leftover', 'seed_unlabelled', 'seed_env_only', 'seed_borrowed_name', 'seed_other_store',
        'relabel_session', 'ad_owner_global_set', 'rebind_tmux_socket', 'restore_tmux_socket', 'ad_store_mark_finished', 'ad_store_seed_pending', 'ad_store_unusable_name',
        'ad_kill_include_finished', 'ad_delete_unusable_row', 'run_find_missing_loop', 'seed_010_row', 'seed_prepersona_fleet', 'write_mcp_config',
      ]))
      expect(helperHomeCheckFindings(relative(REPO_ROOT, SCENARIO_PATH), source)).toEqual([])
    })

    test('the current tree: the helpers checked by their callers run only from audited helpers after their check, and no script runs them', () => {
      expect(callerCheckFindings(relative(REPO_ROOT, SCENARIO_PATH), scenario(), scripts())).toEqual([])
    })

    test('the current tree: write_ad_settings and _scenario_stand_in_settings resolve their directory under SCENARIO_ROOT before they remove, create or write', () => {
      expect(realpathCheckFindings(relative(REPO_ROOT, SCENARIO_PATH), readFileSync(SCENARIO_PATH, 'utf-8'))).toEqual([])
    })

    test('write_ad_settings with its directory check only after the mkdir is flagged at its rm and its mkdir', () => {
      const source = readFileSync(SCENARIO_PATH, 'utf-8')
      const late = source.replace(/(\nwrite_ad_settings\(\) \{\n(?:.*\n)*?)    if \[\[ -e "\$\{dir\}" \|\| -L "\$\{dir\}" \]\]; then\n(?:.*\n)*?    fi\n/, '$1')
      const findings = realpathCheckFindings('scenario.sh', late)

      expect(late).not.toBe(source)
      expectNamedFindings(findings, 'scenario.sh', RULE.realpathCheckFirst)
      expect(findings.filter((f) => f.includes('write_ad_settings'))).toHaveLength(2)
    })

    test('_scenario_stand_in_settings without its realpath -e check is flagged at its write_file', () => {
      const source = readFileSync(SCENARIO_PATH, 'utf-8')
      const unchecked = source.replace(/(\n_scenario_stand_in_settings\(\) \{\n(?:.*\n)*?)    real_bin="\$\(realpath -e -- "\$\{bin\}"[^\n]*\n/, '$1')

      expect(unchecked).not.toBe(source)
      expectNamedFindings(realpathCheckFindings('scenario.sh', unchecked), 'scenario.sh', RULE.realpathCheckFirst)
    })

    test('the current tree: each exempt name is a scenario.sh function with a step, and no name is in both lists', () => {
      const { stepFunctions } = shellStepModel(scenario())

      expect([...HOME_CHECK_EXEMPT.keys()].filter((name) => !stepFunctions.has(name))).toEqual([])
      expect([...HOME_CHECK_EXEMPT.keys()].filter((name) => HOME_CHECKED_BY_CALLERS.has(name))).toEqual([])
    })

    /** scenario.sh with `helper`'s first `require_scenario_home "…"` line removed. */
    function unguarded(helper: string): string {
      const source = scenario()
      const out = source.replace(new RegExp(`(\\n${helper}\\(\\) \\{\\n(?:.*\\n)*?)    require_scenario_home "[^"\\n]*"\\n`), '$1')
      expect(out).not.toBe(source)
      return out
    }

    test.each([
      ['stub_mode', 'its move', 'mv'],
      ['ad_store_mark_finished', 'its store read, through another helper', '_scenario_row_json'],
      ['seed_leftover', 'its seeding, through _scenario_seed', '_scenario_seed'],
      ['rebind_tmux_socket', 'its socket move', 'mv'],
      ['restore_tmux_socket', 'its socket move', 'mv'],
      ['stub_dialog_delay', 'its move', 'mv'],
      ['install_ad_release', 'its install.sh run', '${SCENARIO_RELEASE_INSTALL_SH}'],
      ['ad_admin', 'its run of the HOME’s agent-director-admin', '${HOME}/.agent-director/admin/agent-director-admin'],
      ['ad', 'its run of the HOME’s agent-director', '${HOME}/.agent-director/bin/agent-director'],
      ['hide_ad_install', 'its move of the shim', 'mv'],
      ['_scenario_store_read', 'its sqlite3 read', 'sqlite3'],
    ])('%s without its require_scenario_home is flagged at %s', (helper, _label, step) => {
      const findings = helperHomeCheckFindings('scenario.sh', unguarded(helper))

      expectNamedFindings(findings, 'scenario.sh', RULE.homeCheckFirst)
      expect(findings).toContainEqual(expect.stringContaining(`: ${helper}: \`${step}\` runs before any unconditional ${HOME_GUARD}`))
    })

    test('seed_010_row without its require_scenario_home: its calls of _scenario_require_010 and _scenario_row_left_pending are flagged', () => {
      const findings = callerCheckFindings('scenario.sh', unguarded('seed_010_row'), [])

      expect(findings).toContainEqual(expect.stringContaining(`: seed_010_row runs _scenario_require_010 before any unconditional ${HOME_GUARD}`))
      expect(findings).toContainEqual(expect.stringContaining(`: seed_010_row runs _scenario_row_left_pending before any unconditional ${HOME_GUARD}`))
    })
  })

  describe('the image-guarded TypeScript fixtures check the marker before their first step', () => {
    const NODE_IMPORTS = lines("import { existsSync } from 'node:fs'", "import { join } from 'node:path'")
    const CHECK = lines(`if (!existsSync('${CI_IMAGE_MARKER}')) {`, "  console.error('FAIL: fmk-driver: refused')", '  process.exit(2)', '}')
    const AFTER = "const mod = await import(join(process.env['CSCB_PKG_DIR'] ?? '/test-repo', 'src', 'x.ts'))"
    const FILES = IMAGE_GUARDED_TS_PATHS.map((path) => basename(path))

    const violations: [label: string, rule: string, source: string][] = [
      ['a static package import', RULE.driverStaticImport, lines(NODE_IMPORTS, "import { spawnForPersona } from 'claude-slack-channel-bots/src/session-manager.ts'", CHECK)],
      ['a static package import after the check (evaluated first all the same)', RULE.driverStaticImport, lines(NODE_IMPORTS, CHECK, "import { Client } from 'agent-director'")],
      ['a type-only import of a package', RULE.driverStaticImport, lines("import type { Client } from 'agent-director'", NODE_IMPORTS, CHECK)],
      ['a side-effect import of a relative module', RULE.driverStaticImport, lines("import './setup.ts'", NODE_IMPORTS, CHECK)],
      ['a re-export from a package', RULE.driverStaticImport, lines(NODE_IMPORTS, CHECK, "export { Client } from 'agent-director'")],
      ['a statement before the check', RULE.markerFirst, lines(NODE_IMPORTS, "const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo'", CHECK)],
      ['a check that exits 0', RULE.markerFirst, lines(NODE_IMPORTS, CHECK.replace('exit(2)', 'exit(0)'))],
      ['a check that does not exit', RULE.markerFirst, lines(NODE_IMPORTS, CHECK.replace('  process.exit(2)\n', ''))],
      ['a check of another path', RULE.markerFirst, lines(NODE_IMPORTS, CHECK.replace(CI_IMAGE_MARKER, '/etc/hostname'))],
      ['existsSync from a module other than node:fs', RULE.markerFirst, lines("import { existsSync } from './fs-shim.ts'", "import { join } from 'node:path'", CHECK)],
      ['no check at all', RULE.markerFirst, lines(NODE_IMPORTS, AFTER)],
      ['a type-only import of a relative module', RULE.driverStaticImport, lines(NODE_IMPORTS, "import type { McpConfig } from './mcp-types.ts'", CHECK)],
      ['a type-only named binding from a package', RULE.driverStaticImport, lines(NODE_IMPORTS, "import { type Client } from '@modelcontextprotocol/sdk/client/index.js'", CHECK)],
      ['a static import of a src/ module by relative path before the check', RULE.driverStaticImport, lines(NODE_IMPORTS, "import { PHASE1_FLOOR_VERSION } from '../../../src/ad-version-gate.ts'", CHECK)],
    ]

    // driverGuardFindings reads each file alike, so the table runs once, under one name.
    test.each(violations)('flags %s, naming the file and the rule', (_label, rule, source) => {
      expectNamedFindings(driverGuardFindings('fmk-driver.ts', source), 'fmk-driver.ts', rule)
    })

    const allowed: [label: string, source: string][] = [
      ['node: imports and comments, the check, then dynamic imports', lines('/** The driver. */', NODE_IMPORTS, '// The marker first.', CHECK, AFTER)],
      ['existsSync imported under another name', lines("import { existsSync as exists } from 'node:fs'", CHECK.replace('existsSync(', 'exists('))],
    ]

    test.each(allowed)('allows %s', (_label, source) => {
      expect(driverGuardFindings('fmk-driver.ts', source)).toEqual([])
    })

    test('the audited files: the forced-call driver, the stub’s MCP session, the switch-over fixture and the scenario value printer, all present', () => {
      expect(FILES).toEqual(['fmk-driver.ts', 'stub-mcp-session.ts', 'switch-over.ts', 'fmk-texts.ts'])
      for (const path of IMAGE_GUARDED_TS_PATHS) expect(existsSync(path)).toBe(true)
    })

    test.each(IMAGE_GUARDED_TS_PATHS.map((path) => [basename(path), path]))('the current tree: %s imports only node: built-ins statically and checks the marker first', (_file, path) => {
      expect(driverGuardFindings(relative(REPO_ROOT, path), readFileSync(path, 'utf-8'))).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Static audit: the symlink re-point helper (b.jg5 SRJ-1306, SRJ-1401;
// test-14's harness addition). The value printer, fmk-texts.ts, is one of
// IMAGE_GUARDED_TS_PATHS above.
// ---------------------------------------------------------------------------

/** scenario.sh's re-point of a symlinked directory under SCENARIO_ROOT: a move. */
const HOME_GUARDED_REPOINT_HELPERS: readonly string[] = ['repoint_symlink']

describe('static audit: repoint_symlink checks HOME first (b.jg5 SRJ-1306)', () => {
  test('the current tree: repoint_symlink runs require_scenario_home before its first move', () => {
    expect(helperHomeCheckFindings(relative(REPO_ROOT, SCENARIO_PATH), readFileSync(SCENARIO_PATH, 'utf-8'), HOME_GUARDED_REPOINT_HELPERS)).toEqual([])
  })

  test('repoint_symlink without its require_scenario_home is flagged at its move', () => {
    const source = readFileSync(SCENARIO_PATH, 'utf-8')
    const unguarded = source.replace(/(\nrepoint_symlink\(\) \{\n(?:.*\n)*?)    require_scenario_home "\$\{step\}"\n/, '$1')

    expect(unguarded).not.toBe(source)
    expectNamedFindings(helperHomeCheckFindings('scenario.sh', unguarded, HOME_GUARDED_REPOINT_HELPERS), 'scenario.sh', IMAGE_GUARD_RULE.homeCheckFirst)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the list-refusing agent-director stand-in (b.jg5 SRJ-1306,
// SRJ-1411; test-21's harness addition)
// ---------------------------------------------------------------------------

/** The stand-in that refuses `list` and runs the release for every other verb, swapped in behind the shim. */
const LIST_REFUSING_STAND_IN_PATH = join(INTEGRATION_DIR, 'fixtures', 'agent-director-list-refusing.sh')

/** The value of the first literal `<name>=<path>` assignment in a shell file, or undefined. */
function literalAssignment(source: string, name: string): string | undefined {
  return new RegExp(`^${name}=(/[^\\s"'$;]+)$`, 'm').exec(source)?.[1]
}

describe('static audit: the list-refusing stand-in checks the image marker first (b.jg5 SRJ-1306)', () => {
  test('the current tree: its first step is the /etc/cscb-ci-image check that exits non-zero', () => {
    expect(existsSync(LIST_REFUSING_STAND_IN_PATH)).toBe(true)
    expect(shellEntryFindings(relative(REPO_ROOT, LIST_REFUSING_STAND_IN_PATH), readFileSync(LIST_REFUSING_STAND_IN_PATH, 'utf-8'))).toEqual([])
  })

  test('the stand-in with a step before its marker check is flagged, naming the file and the rule', () => {
    const source = readFileSync(LIST_REFUSING_STAND_IN_PATH, 'utf-8')
    const stepFirst = source.replace(/\nif \[\[ ! -e \/etc\/cscb-ci-image \]\]; then\n/, '\nrelease=/opt/agent-director/bin/agent-director; "${release}" version\n$&')

    expect(stepFirst).not.toBe(source)
    expectNamedFindings(shellEntryFindings('agent-director-list-refusing.sh', stepFirst), 'agent-director-list-refusing.sh', IMAGE_GUARD_RULE.markerFirst)
  })

  test('the binary it runs is the release scenario.sh names (SCENARIO_RELEASE_BIN), never the shim or a binary on PATH', () => {
    const release = literalAssignment(readFileSync(SCENARIO_PATH, 'utf-8'), 'SCENARIO_RELEASE_BIN')
    const standIn = readFileSync(LIST_REFUSING_STAND_IN_PATH, 'utf-8')

    expect(release).toBeDefined()
    expect(literalAssignment(standIn, 'release')).toBe(release)
    expect(standIn).toContain('exec -a "$0" "${release}" "$@"')
    expect(standIn).not.toContain('CSCB_CI_AGENT_DIRECTOR_SHIM_MARKER')
  })
})

// ---------------------------------------------------------------------------
// Static audit: the harness's one agent-director delete (b.jg5 SRJ-1306)
// ---------------------------------------------------------------------------

/** agent-director's global flags, which it takes from anywhere in its argv, each with a value. */
const AD_GLOBAL_FLAGS: readonly string[] = ['--store-path', '--home', '--tmux-command']

/** The scenario.sh helper that holds the harness's one `delete`: scenario 25's removal of the row with the unusable name. */
const HARNESS_DELETE_HELPER = 'ad_delete_unusable_row'

/** The files under tests/integration that are neither shell nor TypeScript, so hold no command or call: shellcheck's and bun's config. */
const INTEGRATION_NON_CODE_FILES: readonly string[] = ['.shellcheckrc', 'bunfig.toml']

/**
 * scenario.sh's readers of the agent-director shim's log, whose first
 * argument is the verb they count or print (`cscb_ad_count delete`): each is
 * a scenario.sh function with no step, so it runs no agent-director.
 */
const AD_LOG_READERS: readonly string[] = ['cscb_ad_count', 'cscb_ad_calls', 'shim_verb_lines']

/** The verb of an agent-director argv: the first word after its global flags. */
function agentDirectorVerb(args: readonly string[]): string {
  for (let k = 0; k < args.length; k++) {
    const word = args[k]
    if (AD_GLOBAL_FLAGS.includes(word)) k++
    else if (!AD_GLOBAL_FLAGS.some((flag) => word.startsWith(`${flag}=`))) return word
  }
  return ''
}

/**
 * `<file>:<line>` of every command in the shell file `file` whose first
 * argument after agent-director's global flags is `delete`, whatever the
 * command: `ad`, `ad_capture`, the binary or the shim by a path or by any
 * variable (`"${real}"`, `"${STATUS_BIN}"`), or any other name but the log
 * readers (AD_LOG_READERS). Comments, strings and heredoc bodies are not
 * commands.
 */
function shellDeleteCalls(file: string, source: string): string[] {
  return shellLogicalLines(source)
    .flatMap((line) => line.commands)
    .filter((c) => agentDirectorVerb(c.args) === 'delete' && !AD_LOG_READERS.includes(c.name))
    .map((c) => `${file}:${c.line}`)
}

/**
 * Whether `receiver` (its text, whitespace and optional chaining removed) is
 * one `verb` deletes a row on, by tests/fmk-source-audit.test.ts's
 * `client-delete` rule: `delete` on the client (a last segment ending in
 * `client`, or `getClient()`), the CLI's `deps` or a `director…`; `destroy`
 * on a `director…`.
 */
function isDeleteReceiver(receiver: string, verb: string): boolean {
  const last = receiver.split('.').at(-1)!
  if (verb === 'destroy') return /^director/i.test(last)
  return /client$/i.test(last) || last === 'getClient()' || last === 'deps' || /^director/i.test(last)
}

/**
 * `<file>:<line>: <what>` of every agent-director delete in the TypeScript
 * file `file`: a `client-delete` call (see isDeleteReceiver; `.delete(`,
 * `?.delete(`, `['delete'](`, the receiver's parentheses and `await`
 * dropped), and any `'delete'` string, which is how an argv names the CLI's
 * verb (`spawn(bin, ['delete', …])`). Read with the TypeScript parser, so
 * comments and other text never count.
 */
function tsDeleteCalls(file: string, source: string): string[] {
  const sf = parse(source, file)
  const out: string[] = []
  forEachNode(sf, (node) => {
    if (stringText(node) === 'delete') out.push(`${file}:${finding(sf, node, "the string 'delete'")}`)
    if (!ts.isCallExpression(node)) return
    const callee = unwrap(node.expression)
    let verb: string | undefined
    if (ts.isPropertyAccessExpression(callee)) verb = callee.name.text
    else if (ts.isElementAccessExpression(callee)) verb = stringText(callee.argumentExpression)
    if ((verb !== 'delete' && verb !== 'destroy') || !(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) return
    const receiver = unwrap(callee.expression).getText(sf).replace(/\s+/g, '').replace(/\?\./g, '.')
    if (isDeleteReceiver(receiver, verb)) out.push(`${file}:${finding(sf, node, `${receiver}.${verb}(`)}`)
  })
  return out
}

describe('static audit: the harness’s one agent-director delete is scenario 25’s step (b.jg5 SRJ-1306)', () => {
  describe('shell', () => {
    const flagged: [label: string, source: string][] = [
      ['ad delete', 'ad delete --claude-instance-id t0-x'],
      ['ad_capture delete', 'ad_capture delete --claude-instance-id "${id}"'],
      ['ad_admin delete', 'ad_admin delete --claude-instance-id t0-x'],
      ['ad_admin_capture delete', 'ad_admin_capture delete --claude-instance-id "${id}"'],
      ['agent-director-admin by its path', '"${HOME}/.agent-director/admin/agent-director-admin" delete --claude-instance-id t0-x'],
      ['agent-director-admin by its image variable', '"${SCENARIO_RELEASE_ADMIN}" delete --claude-instance-id t0-x'],
      ['a delete after a global flag with its value', 'ad --home /h delete --claude-instance-id t0-x'],
      ['a delete after a global flag joined by =', 'ad_capture --store-path=/s/state.db delete --claude-instance-id t0-x'],
      ['the shim by its variable', '"${SCENARIO_AD_BIN}" delete --claude-instance-id t0-x'],
      ['the binary by its path', '"${HOME}/.agent-director/bin/agent-director.real" delete --claude-instance-id t0-x'],
      ['the binary by a local variable', '"${real}" delete --claude-instance-id t0-x'],
      ['the hook binary by its variable', '"${STATUS_BIN}" delete --claude-instance-id "${id}"'],
      ['a command of any other name', 'drop_row delete --claude-instance-id t0-x'],
      ['a delete through exec -a', 'exec -a agent-director "${bin}" delete --claude-instance-id t0-x'],
      ['a delete under timeout with a signal option', 'timeout -s KILL 5 "${bin}" delete --claude-instance-id t0-x'],
      ['a delete under env with assignments', 'env -u TMUX HOME=/h "${bin}" delete --claude-instance-id t0-x'],
      ['a delete in a command substitution', 'out="$(ad delete --claude-instance-id t0-x 2>&1)"'],
      ['a delete in a subshell after cd', '( cd /x && "${ad_path}" delete --claude-instance-id t0-x )'],
      ['a delete after &&', 'true && ad delete --claude-instance-id t0-x'],
    ]

    test.each(flagged)('finds %s', (_label, source) => {
      expect(shellDeleteCalls('x.sh', lines('#!/usr/bin/env bash', source))).toEqual(['x.sh:2'])
    })

    const allowed: [label: string, source: string][] = [
      ['a comment', '# ad delete --claude-instance-id t0-x'],
      ['a string', 'echo "ad delete --claude-instance-id t0-x"'],
      ['a synthetic shim log line', "printf 'call\\t1.000000\\t1\\t2\\tx\\t%s\\n' 'delete --claude-instance-id cscb_x' >> \"${log}\""],
      ['another verb carrying the word', 'ad get --claude-instance-id delete'],
      ['a global flag whose value is delete', 'ad --home delete get --claude-instance-id t0-x'],
      ['a heredoc body', lines('cat << EOF', 'ad delete --claude-instance-id t0-x', 'EOF')],
      ['the word as a loop value', lines('for verb in kill delete; do', '    :', 'done')],
      ['the word as a later argument of a log reader', 'cscb_lines "${LOG}" delete "${SCENARIO_ROOT}/leg-b-delete"'],
      ['the word in a test and a case pattern', lines('[[ "${_L_VERB}" == delete ]] || continue', 'case "${verb}" in', '    delete) n=1 ;;', 'esac')],
      ['the verb a log reader counts or prints', lines('[[ "$(cscb_ad_count delete)" == 0 ]] || fail x', 'cscb_ad_calls delete --claude-instance-id > "${out}"')],
    ]

    test.each(allowed)('does not count %s', (_label, source) => {
      expect(shellDeleteCalls('x.sh', lines('#!/usr/bin/env bash', source))).toEqual([])
    })
  })

  describe('TypeScript', () => {
    const flagged: [label: string, source: string][] = [
      ['getClient().delete', 'await getClient().delete({ claude_instance_id: id })'],
      ['a delete on the awaited client in parentheses', 'await (await getClient()).delete({ claude_instance_id: id })'],
      ['client?.delete', 'await client?.delete({ claude_instance_id: id })'],
      ['client.delete?.()', 'await client.delete?.({ claude_instance_id: id })'],
      ["client['delete']", "await client['delete']({ claude_instance_id: id })"],
      ['this.adClient.delete', 'await this.adClient.delete({ claude_instance_id: id })'],
      ['deps.delete', 'await deps.delete(id)'],
      ['director.destroy', 'await director.destroy(id)'],
      ["the CLI's verb in an argv", "spawnSync(adBin, ['delete', '--claude-instance-id', id])"],
    ]

    test.each(flagged)('finds %s', (_label, source) => {
      // A module, as each fixture is, so a top-level `await` is the operator.
      const calls = tsDeleteCalls('x.ts', lines('export {}', source))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((call) => call.startsWith('x.ts:2: '))).toBe(true)
    })

    const allowed: [label: string, source: string][] = [
      ['a Map and a Set delete', lines('tickets.delete(ticket)', 'sockets.delete(ws)', 'const seen = new Set<string>(); seen.delete(key)')],
      ['the delete operator', 'delete env.TMUX'],
      ['comments and longer strings', lines('// await getClient().delete(x)', "const s = 'client.delete(x)'", 'const t = `the delete verb`')],
      ['another client verb', 'await getClient().kill({ claude_instance_id: id })'],
      ['destroy on a client', 'client.destroy()'],
    ]

    test.each(allowed)('does not count %s', (_label, source) => {
      expect(tsDeleteCalls('x.ts', lines('export {}', source))).toEqual([])
    })
  })

  test('the log readers are scenario.sh functions with no step, so they run no agent-director', () => {
    const { functions, stepFunctions } = shellStepModel(readFileSync(SCENARIO_PATH, 'utf-8'))

    expect(AD_LOG_READERS.filter((name) => !functions.has(name) || stepFunctions.has(name))).toEqual([])
  })

  /** Every file under tests/integration, by kind. */
  function integrationFiles(): { shell: string[]; typescript: string[]; other: string[] } {
    const all = filesUnder(INTEGRATION_DIR, () => true).sort()
    return {
      shell: all.filter((path) => path.endsWith('.sh')),
      typescript: all.filter((path) => path.endsWith('.ts')),
      other: all.filter((path) => !path.endsWith('.sh') && !path.endsWith('.ts')),
    }
  }

  test('the audited files: every file under tests/integration is shell or TypeScript, shellcheck’s and bun’s config aside', () => {
    const { shell, typescript, other } = integrationFiles()
    const named = (paths: string[]): string[] => paths.map((path) => relative(INTEGRATION_DIR, path))

    expect(named(other)).toEqual([...INTEGRATION_NON_CODE_FILES])
    expect(named(shell)).toEqual(expect.arrayContaining([join('lib', 'scenario.sh'), join('fixtures', 'stub-claude.sh'), join('fixtures', 'agent-director-shim.sh')]))
    expect(named(typescript)).toEqual(expect.arrayContaining(
      ['driver.ts', 'fmk-driver.ts', 'stub-mcp-session.ts', 'switch-over.ts', 'phase1-client-check.ts', 'slack-stub-server.ts'].map((name) => join('fixtures', name)),
    ))
  })

  test(`the current tree: the only agent-director delete under tests/integration is scenario.sh's ${HARNESS_DELETE_HELPER}`, () => {
    const { shell, typescript } = integrationFiles()
    const calls = [
      ...shell.flatMap((path) => shellDeleteCalls(relative(REPO_ROOT, path), readFileSync(path, 'utf-8'))),
      ...typescript.flatMap((path) => tsDeleteCalls(relative(REPO_ROOT, path), readFileSync(path, 'utf-8'))),
    ]
    const helper = shellFunctions(readFileSync(SCENARIO_PATH, 'utf-8')).get(HARNESS_DELETE_HELPER) ?? []
    const own = helper.filter((c) => agentDirectorVerb(c.args) === 'delete')

    expect(own).toHaveLength(1)
    expect(calls).toEqual([`${relative(REPO_ROOT, SCENARIO_PATH)}:${own[0].line}`])
  })
})

// ---------------------------------------------------------------------------
// Preload check, then the un-injected gate checks
// ---------------------------------------------------------------------------

/** A new prefixed HOME directly under the OS temp directory, as the preload makes it; removed in `afterEach`. */
function preloadTempHome(): string {
  const dir = mkdtempSync(join(osTempDir(), PRELOAD_HOME_PREFIX))
  outsideRoot.push(dir)
  return dir
}

/**
 * An environment the check passes, as the preload builds it: a new prefixed
 * HOME, a clean absolute PATH, no TMUX / TMUX_PANE, this process's
 * `TMUX_TMPDIR` and a state directory under the new HOME.
 */
function preloadEnv(home: string = preloadTempHome()): PreloadEnv {
  return { HOME: home, PATH: dirUnder('bin'), TMUX_TMPDIR: childTmuxTmpDir(), SLACK_STATE_DIR: join(home, 'state') }
}

describe('preload check', () => {
  /** `preloadEnv()` with `name` removed. */
  function preloadEnvWithout(name: keyof PreloadEnv): PreloadEnv {
    const env = preloadEnv()
    delete env[name]
    return env
  }

  // Each row builds its fixture and returns the environment to check.
  type PreloadRow = [label: string, failure: PreloadCheckFailure, build: () => PreloadEnv]

  const failing: PreloadRow[] = [
    ['HOME is unset', PRELOAD_CHECK.homeNotAbsolute, () => ({ PATH: dirUnder('bin') })],
    ['HOME is relative', PRELOAD_CHECK.homeNotAbsolute, () => ({ HOME: 'home', PATH: dirUnder('bin') })],
    ['HOME is the home the run started with (the preload did not apply)', PRELOAD_CHECK.realHome, () => ({ HOME: homedir(), PATH: dirUnder('bin') })],
    ['HOME is the real home', PRELOAD_CHECK.realHome, () => ({ HOME: realHome(), PATH: dirUnder('bin') })],
    ['HOME is a temp directory without the prefix', PRELOAD_CHECK.homeNotPreloadTemp, () => ({ HOME: root, PATH: dirUnder('bin') })],
    ['HOME is a prefixed directory not directly under the OS temp directory', PRELOAD_CHECK.homeNotPreloadTemp, () => ({ HOME: dirUnder(`${PRELOAD_HOME_PREFIX}nested`), PATH: dirUnder('bin') })],
    ['HOME is a prefixed symlink to a directory', PRELOAD_CHECK.homeNotDirectory, () => {
      const link = join(tmpdir(), `${PRELOAD_HOME_PREFIX}${basename(root)}-link`)
      outsideRoot.push(link)
      symlinkSync(dirUnder('link-target'), link)
      return { HOME: link, PATH: dirUnder('bin') }
    }],
    ['HOME holds an agent-director install directory', PRELOAD_CHECK.homeHoldsInstall, () => {
      const home = preloadTempHome()
      mkdirSync(join(home, AGENT_DIRECTOR_INSTALL_DIR))
      return { HOME: home, PATH: dirUnder('bin') }
    }],
    ['HOME holds the standard install path (a plain file)', PRELOAD_CHECK.homeHoldsInstall, () => {
      const home = preloadTempHome()
      plainFile(join(home, AGENT_DIRECTOR_INSTALL_PATH))
      return { HOME: home, PATH: dirUnder('bin') }
    }],
    ['PATH is unset', PRELOAD_CHECK.pathUnset, () => ({ HOME: preloadTempHome() })],
    ['PATH has an empty entry', PRELOAD_CHECK.pathEntryNotAbsolute, () => ({ HOME: preloadTempHome(), PATH: `${dirUnder('bin')}${delimiter}` })],
    ['PATH has a relative entry', PRELOAD_CHECK.pathEntryNotAbsolute, () => ({ HOME: preloadTempHome(), PATH: 'bin' })],
    ['a PATH directory holds an agent-director file', PRELOAD_CHECK.pathDirHoldsAgentDirector, () => {
      const bin = dirUnder('bin')
      plainFile(join(bin, AGENT_DIRECTOR_BINARY_NAME))
      return { HOME: preloadTempHome(), PATH: [dirUnder('other'), bin].join(delimiter) }
    }],
    ['a PATH directory holds a dangling agent-director symlink', PRELOAD_CHECK.pathDirHoldsAgentDirector, () => {
      const bin = dirUnder('bin')
      symlinkSync(join(root, 'no-such-target'), join(bin, AGENT_DIRECTOR_BINARY_NAME))
      return { HOME: preloadTempHome(), PATH: bin }
    }],
    ['TMUX is set (inside the host’s tmux session)', PRELOAD_CHECK.tmuxSet, () => ({ ...preloadEnv(), TMUX: `${join(root, 'tmux-socket')},1,0` })],
    ['TMUX is set but empty', PRELOAD_CHECK.tmuxSet, () => ({ ...preloadEnv(), TMUX: '' })],
    ['TMUX_PANE is set', PRELOAD_CHECK.tmuxPaneSet, () => ({ ...preloadEnv(), TMUX_PANE: '%0' })],
    ['TMUX_PANE is set but empty', PRELOAD_CHECK.tmuxPaneSet, () => ({ ...preloadEnv(), TMUX_PANE: '' })],
    ['CLAUDE_CONFIG_DIR is set (a persona’s, inherited from a bot’s session)', PRELOAD_CHECK.claudeConfigDirSet, () => ({ ...preloadEnv(), CLAUDE_CONFIG_DIR: dirUnder('persona-claude') })],
    ['CLAUDE_CONFIG_DIR is set but empty', PRELOAD_CHECK.claudeConfigDirSet, () => ({ ...preloadEnv(), CLAUDE_CONFIG_DIR: '' })],
    ['TMUX_TMPDIR is unset', PRELOAD_CHECK.tmuxTmpDirNotFenced, () => preloadEnvWithout('TMUX_TMPDIR')],
    ['TMUX_TMPDIR is relative', PRELOAD_CHECK.tmuxTmpDirNotFenced, () => ({ ...preloadEnv(), TMUX_TMPDIR: basename(childTmuxTmpDir()) })],
    ['TMUX_TMPDIR is a temp directory without the prefix', PRELOAD_CHECK.tmuxTmpDirNotFenced, () => ({ ...preloadEnv(), TMUX_TMPDIR: root })],
    ['TMUX_TMPDIR is the OS temp directory', PRELOAD_CHECK.tmuxTmpDirNotFenced, () => ({ ...preloadEnv(), TMUX_TMPDIR: tmpdir() })],
    ['TMUX_TMPDIR is a prefixed path that does not exist', PRELOAD_CHECK.tmuxTmpDirNotFenced, () => ({
      ...preloadEnv(),
      TMUX_TMPDIR: join(tmpdir(), `${CHILD_TMUX_TMPDIR_PREFIX}${basename(root)}-missing`),
    })],
    ['TMUX_TMPDIR is another fenced directory, not this process’s', PRELOAD_CHECK.tmuxTmpDirNotProcess, () => {
      const other = mkdtempSync(join(tmpdir(), CHILD_TMUX_TMPDIR_PREFIX))
      outsideRoot.push(other)
      return { ...preloadEnv(), TMUX_TMPDIR: other }
    }],
    ['SLACK_STATE_DIR is unset (the resolvers would fall back to the launch-time home)', PRELOAD_CHECK.stateDirUnset, () => preloadEnvWithout('SLACK_STATE_DIR')],
    ['SLACK_STATE_DIR is empty', PRELOAD_CHECK.stateDirUnset, () => ({ ...preloadEnv(), SLACK_STATE_DIR: '' })],
    ['SLACK_STATE_DIR is under the home the run started with', PRELOAD_CHECK.stateDirNotUnderHome, () => ({ ...preloadEnv(), SLACK_STATE_DIR: join(homedir(), 'state') })],
    ['SLACK_STATE_DIR is outside HOME', PRELOAD_CHECK.stateDirNotUnderHome, () => ({ ...preloadEnv(), SLACK_STATE_DIR: dirUnder('state') })],
    ['SLACK_STATE_DIR is HOME itself', PRELOAD_CHECK.stateDirNotUnderHome, () => {
      const home = preloadTempHome()
      return { ...preloadEnv(home), SLACK_STATE_DIR: home }
    }],
    ['SLACK_STATE_DIR starts with HOME but leaves it through ..', PRELOAD_CHECK.stateDirNotUnderHome, () => {
      const home = preloadTempHome()
      return { ...preloadEnv(home), SLACK_STATE_DIR: `${home}${sep}..${sep}state` }
    }],
    ['SLACK_STATE_DIR is a sibling of HOME sharing its name as a prefix', PRELOAD_CHECK.stateDirNotUnderHome, () => {
      const home = preloadTempHome()
      return { ...preloadEnv(home), SLACK_STATE_DIR: `${home}-state` }
    }],
    ['SLACK_STATE_DIR is relative', PRELOAD_CHECK.stateDirNotUnderHome, () => ({ ...preloadEnv(), SLACK_STATE_DIR: 'state' })],
  ]

  test.each(failing)('fails when %s (%s)', (_label, failure, build) => {
    expect(preloadCheckFailures(build())).toContain(failure)
  })

  test('passes for a prefixed temp HOME, empty or not, a PATH of clean absolute directories, no tmux session, this process’s TMUX_TMPDIR and a state directory under HOME', () => {
    const home = preloadTempHome()
    const env = preloadEnv(home)
    const path = [dirUnder('bin-a'), dirUnder('bin-b')].join(delimiter)

    expect(preloadCheckFailures(env)).toEqual([])
    expect(preloadCheckFailures({ ...env, PATH: path })).toEqual([])
    // An earlier test file may have written under the shared HOME.
    plainFile(join(env.SLACK_STATE_DIR!, 'server.log'))
    expect(preloadCheckFailures({ ...env, PATH: path })).toEqual([])
    expect(preloadCheckFailures({ ...env, PATH: EMPTY_CHILD_PATH })).toEqual([])
    // Any state directory strictly under HOME passes, however deep.
    expect(preloadCheckFailures({ ...env, SLACK_STATE_DIR: join(home, 'a', 'b', 'state') })).toEqual([])
  })

  test('each clean-environment row fails for its own reason alone', () => {
    // The TMUX, CLAUDE_CONFIG_DIR, TMUX_TMPDIR and SLACK_STATE_DIR rows start
    // from preloadEnv(), so each must report exactly its failure and nothing
    // about HOME or PATH.
    const fromCleanEnv = new Set<PreloadCheckFailure>([
      PRELOAD_CHECK.tmuxSet,
      PRELOAD_CHECK.tmuxPaneSet,
      PRELOAD_CHECK.claudeConfigDirSet,
      PRELOAD_CHECK.tmuxTmpDirNotFenced,
      PRELOAD_CHECK.tmuxTmpDirNotProcess,
      PRELOAD_CHECK.stateDirUnset,
      PRELOAD_CHECK.stateDirNotUnderHome,
    ])
    const own = failing.filter(([, failure]) => fromCleanEnv.has(failure))
    expect(new Set(own.map(([, failure]) => failure))).toEqual(fromCleanEnv)
    for (const [label, failure, build] of own) {
      expect({ label, failures: preloadCheckFailures(build()) }).toEqual({ label, failures: [failure] })
    }
  })
})

describe('preload redirect (preloadRedirectedEnv)', () => {
  /** A directory under the root holding a plain, non-executable `agent-director` file. */
  function dirWithAgentDirectorFile(name: string): string {
    const dir = dirUnder(name)
    plainFile(join(dir, AGENT_DIRECTOR_BINARY_NAME))
    return dir
  }

  /** A directory under the root holding a dangling `agent-director` symlink. */
  function dirWithDanglingAgentDirector(name: string): string {
    const dir = dirUnder(name)
    symlinkSync(join(root, 'no-such-target'), join(dir, AGENT_DIRECTOR_BINARY_NAME))
    return dir
  }

  const path = (...entries: string[]): string => entries.join(delimiter)

  // Each row builds its fixture under the case's root and returns the inherited
  // environment and the PATH the redirect must produce from it.
  type RedirectRow = [label: string, build: () => { inherited: PreloadEnv; expectedPath: string }]

  const rows: RedirectRow[] = [
    ['a clean inherited PATH is kept as is', () => {
      const [a, b] = [dirUnder('a'), dirUnder('b')]
      return { inherited: { PATH: path(a, b) }, expectedPath: path(a, b) }
    }],
    ['a directory holding an agent-director file is dropped', () => {
      const [a, b] = [dirUnder('a'), dirUnder('b')]
      return { inherited: { PATH: path(a, dirWithAgentDirectorFile('ad'), b) }, expectedPath: path(a, b) }
    }],
    ['a directory holding a dangling agent-director symlink is dropped', () => {
      const a = dirUnder('a')
      return { inherited: { PATH: path(dirWithDanglingAgentDirector('ad-link'), a) }, expectedPath: a }
    }],
    ['duplicate entries keep their first place only', () => {
      const [a, b] = [dirUnder('a'), dirUnder('b')]
      return { inherited: { PATH: path(a, b, a, b) }, expectedPath: path(a, b) }
    }],
    ['empty entries (leading, doubled, trailing) are dropped', () => {
      const [a, b] = [dirUnder('a'), dirUnder('b')]
      return { inherited: { PATH: path('', a, '', b, '') }, expectedPath: path(a, b) }
    }],
    ['relative entries are dropped', () => {
      const a = dirUnder('a')
      return { inherited: { PATH: path('bin', a, join('node_modules', '.bin')) }, expectedPath: a }
    }],
    ['a . entry is dropped', () => {
      const a = dirUnder('a')
      return { inherited: { PATH: path('.', a, '.') }, expectedPath: a }
    }],
    ['no entry left gives EMPTY_CHILD_PATH', () => ({
      inherited: { PATH: path('.', '', dirWithAgentDirectorFile('ad'), dirWithDanglingAgentDirector('ad-link'), 'bin') },
      expectedPath: EMPTY_CHILD_PATH,
    })],
    ['an unset PATH gives EMPTY_CHILD_PATH', () => ({ inherited: {}, expectedPath: EMPTY_CHILD_PATH })],
    ['TMUX and TMUX_PANE set are unset', () => {
      const a = dirUnder('a')
      return { inherited: { PATH: a, TMUX: `${join(root, 'tmux-socket')},1,0`, TMUX_PANE: '%0' }, expectedPath: a }
    }],
    ['an inherited CLAUDE_CONFIG_DIR is unset', () => {
      const a = dirUnder('a')
      return { inherited: { PATH: a, CLAUDE_CONFIG_DIR: dirUnder('persona-claude') }, expectedPath: a }
    }],
    ['a foreign TMUX_TMPDIR is replaced by the fenced one', () => {
      const a = dirUnder('a')
      return { inherited: { PATH: a, TMUX_TMPDIR: dirUnder('foreign-tmux') }, expectedPath: a }
    }],
    ['a stray SLACK_STATE_DIR is replaced by the state directory under the new HOME', () => {
      const a = dirUnder('a')
      return { inherited: { PATH: a, SLACK_STATE_DIR: dirUnder('stray-state') }, expectedPath: a }
    }],
    ['a stray HOME is replaced by the new HOME', () => {
      const a = dirUnder('a')
      return { inherited: { PATH: a, HOME: dirUnder('stray-home') }, expectedPath: a }
    }],
    ['everything dirty at once', () => {
      const [a, b] = [dirUnder('a'), dirUnder('b')]
      return {
        inherited: {
          HOME: dirUnder('stray-home'),
          PATH: path('', '.', a, dirWithAgentDirectorFile('ad'), 'bin', a, dirWithDanglingAgentDirector('ad-link'), b, ''),
          TMUX: `${join(root, 'tmux-socket')},1,0`,
          TMUX_PANE: '%0',
          TMUX_TMPDIR: dirUnder('foreign-tmux'),
          SLACK_STATE_DIR: dirUnder('stray-state'),
          CLAUDE_CONFIG_DIR: dirUnder('persona-claude'),
        },
        expectedPath: path(a, b),
      }
    }],
  ]

  test.each(rows)('%s', (_label, build) => {
    const { inherited, expectedPath } = build()
    const home = preloadTempHome()
    const fenced = childTmuxTmpDir()

    const redirected = preloadRedirectedEnv(inherited, home, fenced)

    // Exactly these names: TMUX, TMUX_PANE and CLAUDE_CONFIG_DIR are absent, so the preload deletes them.
    expect(redirected).toStrictEqual({
      HOME: home,
      PATH: expectedPath,
      TMUX_TMPDIR: fenced,
      SLACK_STATE_DIR: join(home, PRELOAD_STATE_DIR_PATH),
    })
    // What the redirect produces is what the shared check accepts.
    expect(preloadCheckFailures(redirected)).toEqual([])
  })

  test('changes nothing: not the inherited environment, not process.env, not the file system', () => {
    const inherited: PreloadEnv = {
      PATH: path('.', dirUnder('a'), dirWithAgentDirectorFile('ad'), ''),
      TMUX: `${join(root, 'tmux-socket')},1,0`,
      TMUX_PANE: '%0',
      TMUX_TMPDIR: dirUnder('foreign-tmux'),
      SLACK_STATE_DIR: dirUnder('stray-state'),
      CLAUDE_CONFIG_DIR: dirUnder('persona-claude'),
    }
    const inheritedBefore = { ...inherited }
    const processBefore = Object.fromEntries(PRELOAD_ENV_NAMES.map((name) => [name, process.env[name]]))
    const home = preloadTempHome()
    const rootBefore = treeSnapshot(root)
    const homeBefore = treeSnapshot(home)

    preloadRedirectedEnv(inherited, home, childTmuxTmpDir())

    expect(inherited).toStrictEqual(inheritedBefore)
    expect(Object.fromEntries(PRELOAD_ENV_NAMES.map((name) => [name, process.env[name]]))).toStrictEqual(processBefore)
    expect(treeSnapshot(root)).toEqual(rootBefore)
    expect(treeSnapshot(home)).toEqual(homeBefore)
  })
})

describe('a non-normalized OS temp directory (TMPDIR)', () => {
  // Each value names the OS temp directory, spelled so that the raw
  // os.tmpdir() differs from its normalized form. The checks run in a bun
  // child started with that TMPDIR: in this process os.tmpdir() stops
  // following process.env.TMPDIR once a test file has replaced process.env.
  const spellings: [label: string, spell: (dir: string) => string][] = [
    ['with a doubled trailing separator', (dir) => `${dir}${sep}${sep}`],
    ['with a trailing /.', (dir) => `${dir}${sep}.`],
    ['through .. and back', (dir) => `${dir}${sep}..${sep}${basename(dir)}`],
  ]

  test.each(spellings)('%s: osTempDir() normalizes it, and TMUX_TMPDIR reuse, the preload check and the redirect still hold', (_label, spell) => {
    const normalized = osTempDir()
    const spelled = spell(normalized)
    const inherited = mkdtempSync(join(normalized, CHILD_TMUX_TMPDIR_PREFIX))
    outsideRoot.push(inherited)
    const home = preloadTempHome()
    const bin = dirUnder('bin')
    const checkEnv = { HOME: home, PATH: bin, SLACK_STATE_DIR: join(home, 'state') }
    const dirtyEnv = { PATH: ['.', bin, ''].join(delimiter), TMUX: `${join(root, 'tmux-socket')},1,0`, TMUX_PANE: '%0' }
    const script = `
      const { tmpdir } = await import('node:os');
      const h = await import(${JSON.stringify(HELPER_PATH)});
      const home = ${JSON.stringify(home)};
      const fenced = h.childTmuxTmpDir();
      process.stdout.write(JSON.stringify({
        rawIsNormalized: tmpdir() === h.osTempDir(),
        normalized: h.osTempDir(),
        reused: h.inheritedChildTmuxTmpDir(${JSON.stringify(inherited)}),
        fencedIsInherited: fenced === process.env.TMUX_TMPDIR,
        check: h.preloadCheckFailures({ ...${JSON.stringify(checkEnv)}, TMUX_TMPDIR: fenced }),
        redirect: h.preloadCheckFailures(h.preloadRedirectedEnv(${JSON.stringify(dirtyEnv)}, home, fenced)),
      }));
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      env: hostSafeChildEnv(dirUnder('child-home'), { tools: [], extras: { TMPDIR: spelled } }),
      encoding: 'utf-8',
      timeout: 30_000,
    })

    expect(child.stderr).toBe('')
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({
      // The child's raw os.tmpdir() is the non-normalized spelling (Bun strips one trailing separator).
      rawIsNormalized: false,
      normalized,
      reused: inherited,
      // The parent's fenced TMUX_TMPDIR is reused, not a second one made.
      fencedIsInherited: true,
      check: [],
      redirect: [],
    })
  })
})

describe('un-injected gate checks (after the preload check)', () => {
  test('with the preload applied, runStartupGate() and runInstallCheck() with their defaults fail as not found', async () => {
    // Every one of the preload's variables (PRELOAD_ENV_NAMES), as this run has it.
    const env = Object.fromEntries(PRELOAD_ENV_NAMES.map((name) => [name, process.env[name]])) as PreloadEnv
    // The gate calls below run only when this passes: with this HOME and PATH
    // the client's discovery finds no candidate, so it throws
    // ErrSystemInstallNotFound before its version probe could start a process.
    // TMUX, TMUX_PANE, CLAUDE_CONFIG_DIR, TMUX_TMPDIR and SLACK_STATE_DIR are
    // what the preload set; nothing else in the run pins them.
    expect(Object.keys(env)).toEqual(['HOME', 'PATH', 'TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'SLACK_STATE_DIR', 'CLAUDE_CONFIG_DIR'])
    expect(preloadCheckFailures(env)).toEqual([])

    const gate = await runStartupGate()
    expect(gate.ok).toBe(false)
    expect(gate).toMatchObject({ phase: 'construct', classLabel: AD_SYSTEM_INSTALL_NOT_FOUND })

    // Another file may leave a synthetic floor cached; read the real one.
    resetCacheForTests()
    const check = await runInstallCheck()
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.classLabel).toBe(AD_SYSTEM_INSTALL_NOT_FOUND)
    // Discovery looked at the preload's HOME and PATH, and nowhere else.
    const checked = (check.detail as { checkedLocations: { detail: string | null }[] }).checkedLocations
    expect(checked.map((location) => location.detail)).toEqual([join(env.HOME!, AGENT_DIRECTOR_INSTALL_PATH), env.PATH!])
  })
})

// ---------------------------------------------------------------------------
// Static audit: end_stub_mcp_session's guards come before its signal (harness addition, b.jg5 SRJ-1306)
// ---------------------------------------------------------------------------

/** scenario.sh's helper that ends a stub worker's MCP session client with a signal. */
const MCP_SESSION_END_HELPER = 'end_stub_mcp_session'

/** Whether `command` only declares or assigns: `local …`, or a lone `NAME=…`. */
function isDeclarationOnly(command: ShellCommand): boolean {
  return command.name === '' || command.name === 'local' || SHELL_ASSIGNMENT.test(command.name)
}

/**
 * The guard findings for `helper` in scenario.sh's `source`: before its first
 * `kill`, the helper runs `require_ci_image` as its first command after its
 * declarations, then `require_scenario_home`, each unconditionally (at the
 * top of its body, at the start of a logical line or after `;`).
 */
function signalGuardFindings(source: string, helper: string): string[] {
  const body = shellFunctions(source).get(helper)
  if (body === undefined) return [`${helper} is not defined`]
  const signal = body.findIndex((c) => c.name === 'kill')
  if (signal < 0) return [`${helper} sends no signal the audit can see`]
  const unconditional: string[] = []
  let depth = 0
  for (const command of body.slice(0, signal)) {
    if (depth === 0 && isUnconditional(command) && !isDeclarationOnly(command)) unconditional.push(command.name)
    depth += shellDepthChange(command)
  }
  const findings: string[] = []
  if (unconditional[0] !== IMAGE_GUARD) findings.push(`${helper}: its first step is ${unconditional[0] ?? 'none'}, not ${IMAGE_GUARD}`)
  if (unconditional.indexOf(HOME_GUARD) < 1) findings.push(`${helper}: no unconditional ${HOME_GUARD} after ${IMAGE_GUARD} and before its kill`)
  return findings
}

describe(`${MCP_SESSION_END_HELPER}: both guards before its signal`, () => {
  const source = readFileSync(SCENARIO_PATH, 'utf-8')
  const guard = (name: string): RegExp => new RegExp(`(\\n${MCP_SESSION_END_HELPER}\\(\\) \\{\\n(?:.*\\n)*?)    ${name} "[^"\\n]*"\\n`)

  test('the current tree: require_ci_image first, then require_scenario_home, both before its kill', () => {
    expect(signalGuardFindings(source, MCP_SESSION_END_HELPER)).toEqual([])
  })

  test.each([
    ['require_scenario_home', 'no unconditional require_scenario_home'],
    ['require_ci_image', 'not require_ci_image'],
  ])('without its %s it is flagged', (name, finding) => {
    const unguarded = source.replace(guard(name), '$1')

    expect(unguarded).not.toBe(source)
    const findings = signalGuardFindings(unguarded, MCP_SESSION_END_HELPER)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.join('\n')).toContain(finding)
  })

  test('with its HOME check only inside an if, it is flagged', () => {
    const conditional = source.replace(guard(HOME_GUARD), `$1    if [[ -n "\${STRICT:-}" ]]; then\n        ${HOME_GUARD} "\${step}"\n    fi\n`)

    expect(conditional).not.toBe(source)
    expect(signalGuardFindings(conditional, MCP_SESSION_END_HELPER).join('\n')).toContain(`no unconditional ${HOME_GUARD}`)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the Slack stub and stub MCP session helpers refuse outside the
// /ci image (harness additions, b.jg5 SRJ-1306, b.deo SRI-1404)
// ---------------------------------------------------------------------------

/**
 * scenario.sh's helpers for the Slack stub's pushes and the stub MCP
 * session's records. They work in both modes, so none runs
 * `require_scenario_home` (shared mode has no scenario HOME); `/ci` always
 * carries the marker, so this static pin is the only proof of their refusal.
 */
const IMAGE_GUARDED_STUB_HELPERS: readonly string[] = ['slack_stub_push', 'stub_session_deliveries', 'stub_session_call']

/**
 * The image-check findings for `helpers` in the shell file `file`: the first
 * command of each, after its unconditional declarations (`local …`, a lone
 * `NAME=…`), is an unconditional `require_ci_image`, called directly, and not
 * piped on (`|`) nor run in the background (`&`, its own or its `&&` / `||`
 * list's): bash runs those in a subshell, so `fail`'s exit ends only that.
 * A command substitution in a declaration runs before it, and so is its first
 * command. A helper that is not defined is a finding too.
 */
function helperImageCheckFindings(file: string, source: string, helpers: readonly string[] = IMAGE_GUARDED_STUB_HELPERS): string[] {
  const functions = shellFunctions(source)
  const rule = IMAGE_GUARD_RULE.helperImageCheckFirst
  const findings: string[] = []
  for (const helper of helpers) {
    const body = functions.get(helper)
    if (body === undefined) {
      findings.push(`${file}:1: ${rule}: ${helper} is not defined`)
      continue
    }
    const first = body.find((c) => !(isUnconditional(c) && isDeclarationOnly(c)))
    if (first === undefined) findings.push(`${file}:1: ${rule}: ${helper}: no ${IMAGE_GUARD} after its declarations`)
    else if (first.name !== IMAGE_GUARD || !isUnconditional(first)) {
      const shown = [...first.keywords, first.name].filter((w) => w !== '').join(' ')
      findings.push(`${file}:${first.line}: ${rule}: ${helper}: its first step after its declarations is \`${shown}\`, not an unconditional ${IMAGE_GUARD}`)
    } else if (first.next === '|' || first.next === '&') {
      findings.push(`${file}:${first.line}: ${rule}: ${helper}: its ${IMAGE_GUARD} runs in a subshell (\`${first.next}\` after it), so its refusal ends only that subshell`)
    }
  }
  return findings
}

/**
 * The functions of `source` that call `require_scenario_home`, as reached
 * from each of `helpers`: the helper itself, and every function of `source`
 * a reached function names (as its command or an argument word), transitively.
 * Each finding names the helper and the function that calls the guard.
 */
function homeGuardCallFindings(source: string, helpers: readonly string[]): string[] {
  const functions = shellFunctions(source)
  const findings: string[] = []
  for (const helper of helpers) {
    const reached = new Set([helper])
    for (const name of reached) {
      for (const c of functions.get(name) ?? []) {
        for (const word of [c.name, ...c.args]) if (word !== HOME_GUARD && functions.has(word)) reached.add(word)
      }
    }
    for (const name of reached) {
      if ((functions.get(name) ?? []).some((c) => namesFunction(c, HOME_GUARD))) findings.push(`${helper} runs ${HOME_GUARD} in ${name}`)
    }
  }
  return findings
}

describe('static audit: the Slack stub and stub MCP session helpers run require_ci_image first (b.jg5 SRJ-1306, b.deo SRI-1404)', () => {
  const RULE = IMAGE_GUARD_RULE.helperImageCheckFirst
  const fn = (name: string, ...body: string[]): string => lines(`${name}() {`, ...body, '}')
  const DECLARATIONS = lines('    local dir="${1:-}" step', '    step="stub_session_deliveries ${dir}"')
  const STEP = '    jq -c . "${file}"'

  const flagged: [label: string, source: string][] = [
    ['no guard at all', fn('stub_session_deliveries', DECLARATIONS, STEP)],
    ['a command before the guard', fn('stub_session_deliveries', DECLARATIONS, '    [[ -d "${dir}" ]] || fail x', `    ${IMAGE_GUARD} "\${step}"`, STEP)],
    ['a command substitution in a declaration before the guard', fn('stub_session_deliveries', '    local key="$(sha256sum <<< "$1")"', `    ${IMAGE_GUARD} x`, STEP)],
    ['the guard only after an ||', fn('stub_session_deliveries', DECLARATIONS, `    [[ -e /x ]] || ${IMAGE_GUARD} "\${step}"`, STEP)],
    ['the guard only in a subshell', fn('stub_session_deliveries', DECLARATIONS, `    ( ${IMAGE_GUARD} "\${step}" )`, STEP)],
    ['the guard only inside an if', fn('stub_session_deliveries', DECLARATIONS, '    if [[ -n "${STRICT:-}" ]]; then', `        ${IMAGE_GUARD} "\${step}"`, '    fi', STEP)],
    ['the guard through a private wrapper', fn('stub_session_deliveries', DECLARATIONS, '    _scenario_require_image "${step}"', STEP)],
    ['the guard piped on', fn('stub_session_deliveries', DECLARATIONS, `    ${IMAGE_GUARD} "\${step}" | tee x`, STEP)],
    ['the guard in the background', fn('stub_session_deliveries', DECLARATIONS, `    ${IMAGE_GUARD} "\${step}" &`, STEP)],
    ['the guard in an && list run in the background', fn('stub_session_deliveries', DECLARATIONS, `    ${IMAGE_GUARD} "\${step}" && jq -c . "\${file}" &`, STEP)],
  ]

  test.each(flagged)('flags %s, naming the helper, the file and the rule', (_label, source) => {
    const findings = helperImageCheckFindings('scenario.sh', source, ['stub_session_deliveries'])

    expectNamedFindings(findings, 'scenario.sh', RULE)
    expect(findings).toContainEqual(expect.stringContaining(`: ${RULE}: stub_session_deliveries`))
  })

  test('flags a helper that is not defined', () => {
    expectNamedFindings(helperImageCheckFindings('scenario.sh', fn('other', `    ${IMAGE_GUARD} x`), ['stub_session_call']), 'scenario.sh', RULE)
  })

  const allowed: [label: string, source: string][] = [
    ['declarations, then the guard', fn('stub_session_deliveries', DECLARATIONS, `    ${IMAGE_GUARD} "\${step}"`, STEP)],
    ['the guard with no declarations, after a comment', fn('stub_session_deliveries', '    # The image first.', `    ${IMAGE_GUARD} x`, STEP)],
    ['the guard after `;` following a declaration', fn('stub_session_deliveries', `    local step=x; ${IMAGE_GUARD} "\${step}"`, STEP)],
    ['the guard ahead of an && list run in the helper’s shell', fn('stub_session_deliveries', DECLARATIONS, `    ${IMAGE_GUARD} "\${step}" && jq -c . "\${file}"`, STEP)],
  ]

  test.each(allowed)('allows %s', (_label, source) => {
    expect(helperImageCheckFindings('scenario.sh', source, ['stub_session_deliveries'])).toEqual([])
  })

  const source = readFileSync(SCENARIO_PATH, 'utf-8')

  test('the current tree: slack_stub_push, stub_session_deliveries and stub_session_call each run require_ci_image first', () => {
    expect(helperImageCheckFindings(relative(REPO_ROOT, SCENARIO_PATH), source)).toEqual([])
  })

  test('the current tree: none of the three runs require_scenario_home, nor any function it calls, so each works in shared mode', () => {
    expect(homeGuardCallFindings(source, IMAGE_GUARDED_STUB_HELPERS)).toEqual([])
  })

  test('a private helper two calls down that runs require_scenario_home is found, naming the helper and the caller of the guard', () => {
    const synthetic = lines(
      fn('stub_session_deliveries', DECLARATIONS, `    ${IMAGE_GUARD} "\${step}"`, '    stub="$(_scenario_stub_dir "${step}")" || exit 1'),
      fn('_scenario_stub_dir', '    _scenario_stub_root "$1"'),
      fn('_scenario_stub_root', `    ${HOME_GUARD} "$1"`),
    )

    expect(homeGuardCallFindings(synthetic, ['stub_session_deliveries'])).toEqual([`stub_session_deliveries runs ${HOME_GUARD} in _scenario_stub_root`])
  })

  test.each(IMAGE_GUARDED_STUB_HELPERS.map((helper) => [helper]))('scenario.sh with %s’s require_ci_image removed is flagged, naming it', (helper) => {
    const unguarded = source.replace(new RegExp(`(\\n${helper}\\(\\) \\{\\n(?:.*\\n)*?)    ${IMAGE_GUARD} "[^"\\n]*"\\n`), '$1')
    const findings = helperImageCheckFindings('scenario.sh', unguarded)

    expect(unguarded).not.toBe(source)
    expectNamedFindings(findings, 'scenario.sh', RULE)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain(`: ${RULE}: ${helper}: `)
  })

  test.each(IMAGE_GUARDED_STUB_HELPERS.map((helper) => [helper]))('scenario.sh with %s’s require_ci_image only inside an if is flagged, naming it', (helper) => {
    const conditional = source.replace(
      new RegExp(`(\\n${helper}\\(\\) \\{\\n(?:.*\\n)*?)    ${IMAGE_GUARD} ("[^"\\n]*")\\n`),
      `$1    if [[ -n "\${STRICT:-}" ]]; then\n        ${IMAGE_GUARD} $2\n    fi\n`,
    )
    const findings = helperImageCheckFindings('scenario.sh', conditional)

    expect(conditional).not.toBe(source)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain(`: ${RULE}: ${helper}: its first step after its declarations is \`if [[\``)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the Slack stub loads only node: built-ins statically
// (b.jg5 SRJ-1306, b.deo SRI-1402)
// ---------------------------------------------------------------------------

/**
 * The loopback Slack stub. It has no marker check, so it is not one of
 * IMAGE_GUARDED_TS_PATHS; it stays self-contained (Bun and `node:` only), as
 * the container copies `tests/` without `src/`.
 */
const SLACK_STUB_SERVER_PATH = join(INTEGRATION_DIR, 'fixtures', 'slack-stub-server.ts')

/** The Slack stub's static-import findings for `file` (the shared matcher, with its own rule). */
function stubImportFindings(file: string, source: string): string[] {
  return nodeOnlyImportFindings(file, parse(source, file), IMAGE_GUARD_RULE.stubStaticImport, 'is not a node: built-in; the stub stays self-contained')
}

describe('static audit: slack-stub-server.ts statically imports only node: built-ins (b.jg5 SRJ-1306, b.deo SRI-1402)', () => {
  const source = readFileSync(SLACK_STUB_SERVER_PATH, 'utf-8')
  /** The stub's source with `line` added after its first `node:` import. */
  const withImport = (line: string): string => source.replace(/(\nimport [^\n]* from 'node:[^']+'\n)/, `$1${line}\n`)

  test('the current tree: the stub imports only node: built-ins statically', () => {
    expect(stubImportFindings(relative(REPO_ROOT, SLACK_STUB_SERVER_PATH), source)).toEqual([])
  })

  test('the stub with a static import of a src/ module is flagged, naming the file and the rule', () => {
    const changed = withImport("import { parsePersonaConfig } from '../../../src/config.ts'")
    const findings = stubImportFindings('slack-stub-server.ts', changed)

    expect(changed).not.toBe(source)
    expectNamedFindings(findings, 'slack-stub-server.ts', IMAGE_GUARD_RULE.stubStaticImport)
    expect(findings).toHaveLength(1)
  })
})
