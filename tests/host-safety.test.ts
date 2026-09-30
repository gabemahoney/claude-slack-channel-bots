/**
 * host-safety.test.ts — Keeps unit tests' child processes away from the real
 * home and any agent-director binary, and checks the `bun test` preload guard
 * (b.jg5 SRJ-1304, SRJ-1301).
 *
 * Sections:
 * - `hostSafeChildEnv`: the environment it builds for a child and each of its
 *   refusals (`HostSafetyError.reason`, one of `HOST_SAFETY_REFUSAL`).
 * - Inherited `TMUX_TMPDIR`: which inherited values `inheritedChildTmuxTmpDir`
 *   reuses, and a `bun` child that loads the helper again reusing its
 *   parent's directory.
 * - `runInFakeHome`: refuses the real home before any child starts.
 * - Static audits (b.jg5 SRJ-1301, SRJ-101), read with the TypeScript parser
 *   so strings, regex literals and comments never count: no value import of
 *   `Client` / `resolveSystemBinary` from `agent-director`; every child
 *   process call's `env` is a direct `hostSafeChildEnv` call; no file imports
 *   the preload guard and `bunfig.toml` loads it; no named import or
 *   re-export of a Phase-1-only error class. Each matcher is pinned with
 *   synthetic flagged and allowed sources, then run over the tree.
 * - Preload check, then the un-injected gate checks: one case checks that the
 *   preload guard applied (HOME, PATH, `TMUX`, `TMUX_PANE`, `TMUX_TMPDIR`,
 *   `SLACK_STATE_DIR`) and only then calls `runStartupGate()`
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
 * `hostSafeChildEnv` with a HOME under the root) that runs only the helper.
 * The real-home cases pass `realHome()` (or a symlink to it made under the
 * root) and are refused before anything under it is looked at. Every
 * `agent-director` entry a case makes is a plain, non-executable file or a
 * dangling symlink. `process.env.PATH` and `process.env.TMUX_TMPDIR`, which
 * some cases point elsewhere, are restored in `afterEach`. The install path,
 * binary name and `TMUX_TMPDIR` prefix come from the helper. The audits only
 * read repository files (none under `node_modules`). The preload-check
 * synthetic cases make prefixed HOME directories directly under the OS temp
 * directory (`preloadTempHome()`) and one `CHILD_TMUX_TMPDIR_PREFIX`
 * directory there (another fenced `TMUX_TMPDIR`), removed in `afterEach`; they
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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  PRELOAD_HOME_PREFIX,
  RESERVED_CHILD_ENV_NAMES,
  childTmuxTmpDir,
  dirHoldsAgentDirector,
  homeHoldsAgentDirectorInstall,
  hostSafeChildEnv,
  inheritedChildTmuxTmpDir,
  isRealHome,
  realHome,
  resolveToolDir,
} from './test-helpers/host-safe-env.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
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

/** Whether `dir` is `parent` or lies under it. */
function isUnder(dir: string, parent: string): boolean {
  return dir === parent || dir.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** Every entry under `dir` with its kind, size and mtime, plus `dir`'s own mtime. */
function treeSnapshot(dir: string): string[] {
  const entries = (readdirSync(dir, { recursive: true }) as string[]).sort().map((rel) => {
    const st = lstatSync(join(dir, rel))
    return `${rel}:${st.isDirectory() ? 'd' : 'f'}:${st.size}:${st.mtimeMs}`
  })
  return [`.:${lstatSync(dir).mtimeMs}`, ...entries]
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
    expect(dirname(first)).toBe(tmpdir())
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

    expect(() => runInFakeHome({ modulePath, call: '', input: null, home: realHome(), stateDir: dirUnder('state') })).toThrow()
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
const BUNFIG_PATH = join(REPO_ROOT, 'bunfig.toml')

const AGENT_DIRECTOR_MODULE = 'agent-director'
/** Names a test may not hold as values from agent-director: they find and run the real binary. */
const DISCOVERY_NAMES: readonly string[] = ['Client', 'resolveSystemBinary']
/** Error classes only a Phase-1 agent-director release exports (b.jg5 SRJ-101's interim rule). */
const PHASE1_ONLY_NAMES: readonly string[] = ['ErrTmuxKillFailed', 'ErrTmuxUnresponsive', 'ErrTmuxSessionConflict']
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

/** Calls `visit` on every node under `root`, depth first. */
function forEachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node)
    ts.forEachChild(node, walk)
  }
  walk(root)
}

/** Whether `node` only wraps its operand (parentheses, `await`, `as`, `!`, `satisfies`). */
function isWrapper(node: ts.Node): node is ts.ParenthesizedExpression | ts.AwaitExpression | ts.AsExpression | ts.NonNullExpression | ts.SatisfiesExpression | ts.TypeAssertion {
  return ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)
}

/** `expr` without its wrappers. */
function unwrap(expr: ts.Expression): ts.Expression {
  while (isWrapper(expr)) expr = expr.expression
  return expr
}

/** The outermost wrapper around `node` (itself when unwrapped); its parent is the context `node` is used in. */
function outermost(node: ts.Node): ts.Node {
  while (node.parent !== undefined && isWrapper(node.parent)) node = node.parent
  return node
}

/** The text of a string literal (or a template with no substitution), else undefined. */
function stringText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

/** The specifier of a dynamic `import('…')` or `require('…')` call, else undefined. */
function moduleLoadOf(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined
  const callee = node.expression
  if (callee.kind !== ts.SyntaxKind.ImportKeyword && !(ts.isIdentifier(callee) && callee.text === 'require')) return undefined
  return stringText(node.arguments[0])
}

/**
 * Whether the dynamic load `node` (see `moduleLoadOf`) is an un-awaited
 * `import()` whose promise is used through a member (`.then(...)`, say): the
 * module's exports are then read where the audit cannot follow.
 */
function isPromiseMemberUse(node: ts.CallExpression): boolean {
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false
  let at: ts.Node = node
  while (at.parent !== undefined && isWrapper(at.parent)) {
    if (ts.isAwaitExpression(at.parent)) return false
    at = at.parent
  }
  const context = at.parent
  return context !== undefined && (ts.isPropertyAccessExpression(context) || ts.isElementAccessExpression(context)) && context.expression === at
}

/** The name a property or binding element is known by, when it is a plain identifier or string. */
function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isComputedPropertyName(name)) return stringText(name.expression)
  return stringText(name)
}

/** `1-based-line: what` for a finding at `node`. */
function finding(sf: ts.SourceFile, node: ts.Node, what: string): string {
  return `${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`
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
  const findings: string[] = []
  const flag = (node: ts.Node, what: string): void => {
    findings.push(finding(sf, node, what))
  }
  const namespaces = new Set<string>()

  const isNamespace = (expr: ts.Expression): boolean => {
    const inner = unwrap(expr)
    return (ts.isIdentifier(inner) && namespaces.has(inner.text)) || moduleLoadOf(inner) === AGENT_DIRECTOR_MODULE
  }
  const checkBindingPattern = (pattern: ts.ObjectBindingPattern): void => {
    for (const el of pattern.elements) {
      if (el.dotDotDotToken !== undefined) continue // a rest copy: collected as a namespace below
      const name = propertyNameText(el.propertyName ?? el.name)
      if (name === undefined && el.propertyName !== undefined) flag(el, 'computed destructuring of agent-director')
      else if (name !== undefined && DISCOVERY_NAMES.includes(name)) flag(el, `destructuring of ${name} from agent-director`)
    }
  }

  // Bindings: static imports and re-exports, and dynamic loads.
  forEachNode(sf, (node) => {
    if (ts.isImportDeclaration(node) && stringText(node.moduleSpecifier) === AGENT_DIRECTOR_MODULE) {
      const clause = node.importClause
      if (clause === undefined || clause.isTypeOnly) return
      if (clause.name !== undefined) namespaces.add(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      else if (bindings !== undefined) {
        for (const el of bindings.elements) {
          if (el.isTypeOnly) continue
          const imported = (el.propertyName ?? el.name).text
          if (DISCOVERY_NAMES.includes(imported)) flag(el, `value import of ${imported} from agent-director`)
          if (imported === 'default') namespaces.add(el.name.text)
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      && stringText(node.moduleReference.expression) === AGENT_DIRECTOR_MODULE) {
      namespaces.add(node.name.text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && stringText(node.moduleSpecifier) === AGENT_DIRECTOR_MODULE) {
      const clause = node.exportClause
      if (clause === undefined || ts.isNamespaceExport(clause)) flag(node, 'value re-export of the whole agent-director module')
      else {
        for (const el of clause.elements) {
          const exported = (el.propertyName ?? el.name).text
          if (!el.isTypeOnly && DISCOVERY_NAMES.includes(exported)) flag(el, `value re-export of ${exported} from agent-director`)
        }
      }
    } else if (moduleLoadOf(node) === AGENT_DIRECTOR_MODULE) {
      const outer = outermost(node)
      const context = outer.parent
      if (isPromiseMemberUse(node as ts.CallExpression)) flag(node, 'agent-director loaded in a form the audit cannot follow')
      else if (ts.isVariableDeclaration(context) && context.initializer === outer) {
        if (ts.isIdentifier(context.name)) namespaces.add(context.name.text)
        // An object pattern is checked with the other destructurings below.
        else if (!ts.isObjectBindingPattern(context.name)) flag(node, 'agent-director loaded into a pattern the audit cannot follow')
      } else if (!((ts.isPropertyAccessExpression(context) || ts.isElementAccessExpression(context)) && context.expression === outer) && !ts.isSpreadAssignment(context)) {
        flag(node, 'agent-director loaded in a form the audit cannot follow')
      }
    }
  })

  // Copies of a namespace: `const x = ns`, `const x = { ...ns }`, `const { ...x } = ns`.
  for (let grew = true; grew;) {
    grew = false
    forEachNode(sf, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return
      const copies: string[] = []
      const init = unwrap(node.initializer)
      if (ts.isIdentifier(node.name) && (isNamespace(init) || (ts.isObjectLiteralExpression(init) && init.properties.some((p) => ts.isSpreadAssignment(p) && isNamespace(p.expression))))) {
        copies.push(node.name.text)
      } else if (ts.isObjectBindingPattern(node.name) && isNamespace(init)) {
        for (const el of node.name.elements) if (el.dotDotDotToken !== undefined && ts.isIdentifier(el.name)) copies.push(el.name.text)
      }
      for (const name of copies) {
        if (!namespaces.has(name)) {
          namespaces.add(name)
          grew = true
        }
      }
    })
  }

  // Reads through a namespace or one of its copies.
  forEachNode(sf, (node) => {
    if (ts.isPropertyAccessExpression(node) && isNamespace(node.expression) && DISCOVERY_NAMES.includes(node.name.text)) {
      flag(node, `read of ${node.name.text} through the agent-director namespace`)
    } else if (ts.isElementAccessExpression(node) && isNamespace(node.expression)) {
      const name = stringText(node.argumentExpression)
      if (name === undefined) flag(node, 'computed read through the agent-director namespace')
      else if (DISCOVERY_NAMES.includes(name)) flag(node, `read of ${name} through the agent-director namespace`)
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined && isNamespace(node.initializer)) {
      checkBindingPattern(node.name)
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isNamespace(node.right)) {
      const left = unwrap(node.left)
      if (!ts.isObjectLiteralExpression(left)) return
      for (const prop of left.properties) {
        const name = ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop) ? propertyNameText(prop.name) : undefined
        if (name !== undefined && DISCOVERY_NAMES.includes(name)) flag(prop, `destructuring of ${name} from agent-director`)
      }
    }
  })
  return findings
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

/**
 * Why the `bunfig.toml` text `toml` (in `baseDir`) does not load `preload`
 * before the tests: its `[test]` table's `preload` (a string or a list) must
 * name it, relative to `baseDir`. An empty list means it does.
 */
function bunfigPreloadFindings(toml: string, baseDir: string, preload: string): string[] {
  const config = Bun.TOML.parse(toml) as { test?: { preload?: unknown } }
  const entries = config.test?.preload
  const list = typeof entries === 'string' ? [entries] : Array.isArray(entries) ? entries : []
  if (list.some((entry) => typeof entry === 'string' && resolve(baseDir, entry) === preload)) return []
  return [`[test] preload does not name ${relative(baseDir, preload)}`]
}

// ---------------------------------------------------------------------------
// Static audit: no named import or re-export of a Phase-1-only name
// ---------------------------------------------------------------------------

/**
 * Where `sf` names a Phase-1-only error class as an import from
 * agent-director: a named import or re-export (type-only included, aliased or
 * not), or destructuring of a dynamic `import()` or `require()`. Naming the
 * classes as strings (classification by `errName`) is allowed.
 */
function phase1ImportFindings(sf: ts.SourceFile): string[] {
  const findings: string[] = []
  const flag = (node: ts.Node, name: string, how: string): void => {
    findings.push(finding(sf, node, `${how} of ${name} from agent-director`))
  }
  forEachNode(sf, (node) => {
    if (ts.isImportDeclaration(node) && stringText(node.moduleSpecifier) === AGENT_DIRECTOR_MODULE) {
      const bindings = node.importClause?.namedBindings
      if (bindings === undefined || !ts.isNamedImports(bindings)) return
      for (const el of bindings.elements) {
        const name = (el.propertyName ?? el.name).text
        if (PHASE1_ONLY_NAMES.includes(name)) flag(el, name, 'named import')
      }
    } else if (ts.isExportDeclaration(node) && stringText(node.moduleSpecifier) === AGENT_DIRECTOR_MODULE) {
      const clause = node.exportClause
      if (clause === undefined || !ts.isNamedExports(clause)) return
      for (const el of clause.elements) {
        const name = (el.propertyName ?? el.name).text
        if (PHASE1_ONLY_NAMES.includes(name)) flag(el, name, 're-export')
      }
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined
      && moduleLoadOf(unwrap(node.initializer)) === AGENT_DIRECTOR_MODULE) {
      for (const el of node.name.elements) {
        const name = propertyNameText(el.propertyName ?? el.name)
        if (name !== undefined && PHASE1_ONLY_NAMES.includes(name)) flag(el, name, 'destructured import')
      }
    }
  })
  return findings
}

// ---------------------------------------------------------------------------
// Static audits: pinned matchers, then the tree
// ---------------------------------------------------------------------------

/** One source line per entry, so no synthetic line starts at column 0 in this file. */
const lines = (...parts: string[]): string => parts.join('\n')

const AD_NS = "import * as ad from 'agent-director'"
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
    // This file's one child (the inherited-TMUX_TMPDIR case) is found and accepted.
    expect(childProcessAudit(parseFile(join(TESTS_DIR, 'host-safety.test.ts')))).toEqual({ calls: 1, findings: [] })
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
  ]

  test.each(bunfigFlagged)('a bunfig.toml with %s does not load it', (_label, toml) => {
    expect(bunfigPreloadFindings(toml, REPO_ROOT, PRELOAD_PATH).length).toBeGreaterThan(0)
  })

  const bunfigAllowed: [label: string, toml: string][] = [
    ['a [test] preload list naming it', '[test]\npreload = ["./tests/test-helpers/host-safety-preload.ts"]'],
    ['a [test] preload string naming it', '[test]\npreload = "./tests/test-helpers/host-safety-preload.ts"'],
    ['a [test] preload list naming it after another', '[test]\npreload = ["./tests/other-preload.ts", "tests/test-helpers/host-safety-preload.ts"]'],
  ]

  test.each(bunfigAllowed)('a bunfig.toml with %s loads it', (_label, toml) => {
    expect(bunfigPreloadFindings(toml, REPO_ROOT, PRELOAD_PATH)).toEqual([])
  })

  test('the current tree: bunfig.toml’s [test] preload names it and no file in the repository imports it', () => {
    expect(existsSync(PRELOAD_PATH)).toBe(true)
    expect(bunfigPreloadFindings(readFileSync(BUNFIG_PATH, 'utf-8'), REPO_ROOT, PRELOAD_PATH)).toEqual([])
    const files = filesUnder(REPO_ROOT, (path) => SCRIPT_FILE.test(path))
    expect(files).toContain(join(TESTS_DIR, 'host-safety.test.ts'))
    expect(auditTree(files, (sf, path) => importsOfFile(sf, path, PRELOAD_PATH))).toEqual([])
  })
})

describe('static audit: no named import or re-export of a Phase-1-only name', () => {
  const flagged: [label: string, source: string][] = [
    ['a named import', "import { ErrTmuxKillFailed } from 'agent-director'"],
    ['an aliased named import beside another', "import { ErrSystemInstallNotFound, ErrTmuxSessionConflict as Conflict } from 'agent-director'"],
    ['a type-only import', "import type { ErrTmuxUnresponsive } from 'agent-director'"],
    ['an inline type-only import', "import { type ErrTmuxKillFailed } from 'agent-director'"],
    ['a re-export', "export { ErrTmuxKillFailed } from 'agent-director'"],
    ['an aliased type-only re-export', "export type { ErrTmuxUnresponsive as Unresponsive } from 'agent-director'"],
    ['a destructured dynamic import', "const { ErrTmuxSessionConflict } = await import('agent-director')"],
  ]

  test.each(flagged)('flags %s', (_label, source) => {
    expect(phase1ImportFindings(parse(source)).length).toBeGreaterThan(0)
  })

  const allowed: [label: string, source: string][] = [
    ['the names as strings (classification by name)', lines(
      "const PHASE1 = ['ErrTmuxKillFailed', 'ErrTmuxUnresponsive']",
      "if (err.errName === 'ErrTmuxSessionConflict') retry()",
    )],
    ['the names in comments', "// ErrTmuxKillFailed arrives with a Phase-1 agent-director release"],
    ['a released tmux error class', "import { ErrTmuxNotAvailable } from 'agent-director'"],
    ['a same-named class from another module', "import { ErrTmuxKillFailed } from './local-errors.ts'"],
  ]

  test.each(allowed)('allows %s', (_label, source) => {
    expect(phase1ImportFindings(parse(source))).toEqual([])
  })

  test('the current tree: no file in src/ or tests/ imports or re-exports one', () => {
    const files = [...filesUnder(SRC_DIR, (path) => SCRIPT_FILE.test(path)), ...filesUnder(TESTS_DIR, (path) => SCRIPT_FILE.test(path))]
    expect(files).toContain(join(SRC_DIR, 'install-check.ts'))
    expect(auditTree(files, phase1ImportFindings)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Preload check, then the un-injected gate checks
// ---------------------------------------------------------------------------

/** Why an environment is not one the preload guard produced (`preloadCheckFailures`). */
const PRELOAD_CHECK = Object.freeze({
  homeNotAbsolute: 'home-not-absolute',
  homeNotPreloadTemp: 'home-not-preload-temp',
  homeNotDirectory: 'home-not-directory',
  realHome: 'real-home',
  homeHoldsInstall: 'home-holds-install',
  pathUnset: 'path-unset',
  pathEntryNotAbsolute: 'path-entry-not-absolute',
  pathDirHoldsAgentDirector: 'path-dir-holds-agent-director',
  tmuxSet: 'tmux-set',
  tmuxPaneSet: 'tmux-pane-set',
  tmuxTmpDirNotFenced: 'tmux-tmpdir-not-fenced',
  tmuxTmpDirNotProcess: 'tmux-tmpdir-not-process',
  stateDirUnset: 'state-dir-unset',
  stateDirNotUnderHome: 'state-dir-not-under-home',
} as const)

type PreloadCheckFailure = (typeof PRELOAD_CHECK)[keyof typeof PRELOAD_CHECK]

/** The variables the preload guard sets or unsets, as `preloadCheckFailures` reads them. */
type PreloadEnv = {
  HOME?: string
  PATH?: string
  TMUX?: string
  TMUX_PANE?: string
  TMUX_TMPDIR?: string
  SLACK_STATE_DIR?: string
}

/**
 * Why `env` is not an environment the preload guard produced, or `[]` when it
 * is. HOME must be an absolute, real directory (not a symlink) directly under
 * the OS temp directory whose name carries `PRELOAD_HOME_PREFIX`, not the real
 * home (passwd or launch-time) nor under it, and hold no agent-director
 * install; it need not be empty (every test file shares it). Every `PATH`
 * entry must be absolute and hold no `agent-director` entry. `TMUX` and
 * `TMUX_PANE` must be unset. `TMUX_TMPDIR` must be a directory
 * `inheritedChildTmuxTmpDir` accepts and this process's one
 * (`childTmuxTmpDir()`). `SLACK_STATE_DIR` must be set and non-empty (unset,
 * the state-directory resolvers fall back to the launch-time home) and the
 * state directory it names (made absolute, as the resolvers do) must lie strictly under
 * HOME. Only `lstat`s (none under the real home: a HOME that is or lies
 * under it fails before any): it starts no process.
 */
function preloadCheckFailures(env: PreloadEnv): PreloadCheckFailure[] {
  const failures: PreloadCheckFailure[] = []
  const home = env.HOME
  if (home === undefined || !isAbsolute(home)) failures.push(PRELOAD_CHECK.homeNotAbsolute)
  else {
    const name = basename(home)
    if (dirname(home) !== tmpdir() || !name.startsWith(PRELOAD_HOME_PREFIX) || name.length <= PRELOAD_HOME_PREFIX.length) {
      failures.push(PRELOAD_CHECK.homeNotPreloadTemp)
    }
    // The real home (or a path under it) is refused before anything under it is looked at.
    if (isRealHome(home) || isUnder(resolve(home), realHome())) failures.push(PRELOAD_CHECK.realHome)
    else {
      let isDirectory = false
      try {
        isDirectory = lstatSync(home).isDirectory()
      } catch {
        isDirectory = false
      }
      if (!isDirectory) failures.push(PRELOAD_CHECK.homeNotDirectory)
      if (homeHoldsAgentDirectorInstall(home)) failures.push(PRELOAD_CHECK.homeHoldsInstall)
    }
  }
  const path = env.PATH
  if (path === undefined) failures.push(PRELOAD_CHECK.pathUnset)
  else {
    for (const dir of path.split(delimiter)) {
      if (dir === '' || !isAbsolute(dir)) failures.push(PRELOAD_CHECK.pathEntryNotAbsolute)
      else if (dirHoldsAgentDirector(dir)) failures.push(PRELOAD_CHECK.pathDirHoldsAgentDirector)
    }
  }
  if (env.TMUX !== undefined) failures.push(PRELOAD_CHECK.tmuxSet)
  if (env.TMUX_PANE !== undefined) failures.push(PRELOAD_CHECK.tmuxPaneSet)
  const tmuxTmpDir = env.TMUX_TMPDIR
  if (tmuxTmpDir === undefined || inheritedChildTmuxTmpDir(tmuxTmpDir) !== tmuxTmpDir) failures.push(PRELOAD_CHECK.tmuxTmpDirNotFenced)
  else if (tmuxTmpDir !== childTmuxTmpDir()) failures.push(PRELOAD_CHECK.tmuxTmpDirNotProcess)
  const stateDir = env.SLACK_STATE_DIR
  if (stateDir === undefined || stateDir === '') failures.push(PRELOAD_CHECK.stateDirUnset)
  else {
    const resolved = resolve(stateDir)
    if (home === undefined || !isAbsolute(home) || resolved === resolve(home) || !isUnder(resolved, resolve(home))) {
      failures.push(PRELOAD_CHECK.stateDirNotUnderHome)
    }
  }
  return failures
}

describe('preload check', () => {
  /** A new prefixed HOME directly under the OS temp directory, as the preload makes it; removed in `afterEach`. */
  function preloadTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), PRELOAD_HOME_PREFIX))
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
    // The TMUX, TMUX_TMPDIR and SLACK_STATE_DIR rows start from preloadEnv(),
    // so each must report exactly its failure and nothing about HOME or PATH.
    const fromCleanEnv = new Set<PreloadCheckFailure>([
      PRELOAD_CHECK.tmuxSet,
      PRELOAD_CHECK.tmuxPaneSet,
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

describe('un-injected gate checks (after the preload check)', () => {
  test('with the preload applied, runStartupGate() and runInstallCheck() with their defaults fail as not found', async () => {
    const env: PreloadEnv = {
      HOME: process.env['HOME'],
      PATH: process.env['PATH'],
      TMUX: process.env['TMUX'],
      TMUX_PANE: process.env['TMUX_PANE'],
      TMUX_TMPDIR: process.env['TMUX_TMPDIR'],
      SLACK_STATE_DIR: process.env['SLACK_STATE_DIR'],
    }
    // The gate calls below run only when this passes: with this HOME and PATH
    // the client's discovery finds no candidate, so it throws
    // ErrSystemInstallNotFound before its version probe could start a process.
    // TMUX, TMUX_PANE, TMUX_TMPDIR and SLACK_STATE_DIR are what the preload
    // set; nothing else in the run pins them.
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
