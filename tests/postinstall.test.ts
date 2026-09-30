/**
 * postinstall.test.ts — Tests for runPostinstall() and the SR-5.2
 * agent-director probe.
 *
 * Isolation (b.av2 SR-13.2): every runPostinstall() call goes through
 * `postinstall()`, which refuses options without `homeDir`, and every sandbox
 * from `makeSandbox()` puts the home (so the skills link target
 * `<home>/.claude/skills`), the state dir and the MCP config path under one
 * `mkdtempSync` root, removed in afterEach. No call falls back to the OS home.
 * Cases that leave `stateDir` unset control SLACK_STATE_DIR in-process and
 * restore it (and the working directory) in afterEach.
 *
 * The agent-director probe (b.jg5 SRJ-121) is driven in process with an
 * injected install check (`deps.runInstallCheck`) answering canned results
 * from `tests/test-helpers/install-check-fixtures.ts`, so no case runs the
 * real install check, resolves the host binary, builds a client or opens an
 * agent-director store. Every probe case checks that the probe adds no
 * install, upgrade or `bun add` advice of its own (AC 81); a failure warning
 * carries the install check's message, which is excluded from that scan.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach, beforeEach, spyOn } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'
import {
  runAgentDirectorPostinstallProbe,
  runPostinstall,
  type PostinstallInstallCheck,
  type PostinstallOptions,
} from '../src/postinstall.ts'
import { MCP_SERVER_NAME, loadPersonaConfig } from '../src/config.ts'
import {
  INSTALL_CHECK_PHASE1_NOTE_PHRASE,
  PHASE1_RUNBOOK_SECTION_TITLE,
  buildInstallCheckPhase1Note,
} from '../src/ad-version-gate.ts'
import {
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
} from '../src/install-check-labels.ts'
import type { InstallCheckResult } from '../src/install-check.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import {
  DEV_PLACEHOLDER_VERSION,
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import { cannedFailureResult, cannedSuccessResult } from './test-helpers/install-check-fixtures.ts'
import { UPGRADE_FORMS, type ForbiddenForm } from './test-helpers/upgrade-forms.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The package's own skills directory, which postinstall links from. */
const PACKAGE_SKILLS = fileURLToPath(new URL('../skills', import.meta.url))
const DEBUG_SKILL = 'debug-slack-channel-bots'
const RETIRED_SKILL = 'claude-slack-channels-config'
/** Where postinstall's link for the retired skill pointed (the directory is gone). */
const RETIRED_PACKAGE_PATH = join(PACKAGE_SKILLS, RETIRED_SKILL)

const isRoot = process.getuid?.() === 0

let tempDirs: string[] = []
let savedStateDirEnv: string | undefined
let savedCwd: string

beforeEach(() => {
  savedStateDirEnv = process.env.SLACK_STATE_DIR
  savedCwd = process.cwd()
})

afterEach(() => {
  process.chdir(savedCwd)
  if (savedStateDirEnv === undefined) delete process.env.SLACK_STATE_DIR
  else process.env.SLACK_STATE_DIR = savedStateDirEnv
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tempDirs = []
})

/** Create a fresh temp dir, removed in afterEach. */
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'postinstall-test-'))
  tempDirs.push(d)
  return d
}

/** One temp root holding the home, state dir and MCP config path of a run. */
interface Sandbox {
  root: string
  home: string
  /** `<home>/.claude/skills`, the link target. */
  skillsDir: string
  stateDir: string
  mcpConfigPath: string
  /** Full options: nothing resolves outside `root`. */
  opts: PostinstallOptions
}

function makeSandbox(): Sandbox {
  const root = makeTempDir()
  const home = join(root, 'home')
  const stateDir = join(root, 'state')
  const mcpConfigPath = join(root, 'mcp', 'slack-mcp.json')
  return {
    root,
    home,
    skillsDir: join(home, '.claude', 'skills'),
    stateDir,
    mcpConfigPath,
    opts: { homeDir: home, stateDir, mcpConfigPath },
  }
}

/** runPostinstall(opts) with its console.log lines captured; refuses options with no temp home. */
function postinstall(opts: PostinstallOptions): string[] {
  if (opts.homeDir === undefined) {
    throw new Error('postinstall test: pass homeDir, or the run would use the real home')
  }
  const lines: string[] = []
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    runPostinstall(opts)
  } finally {
    spy.mockRestore()
  }
  return lines
}

/** Read and parse a JSON file from disk. */
function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

/** Every path under `dir`, relative to it, sorted; symlinks are listed, not followed. */
function listTree(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = join(rel, name)
      out.push(r)
      const st = lstatSync(join(dir, r))
      if (st.isDirectory() && !st.isSymbolicLink()) walk(r)
    }
  }
  walk('')
  return out.sort()
}

/** True when anything, a dangling symlink included, sits at `path`. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Assert `path` is a symlink whose text is exactly `target`. */
function expectLink(path: string, target: string): void {
  expect(lstatSync(path).isSymbolicLink()).toBe(true)
  expect(readlinkSync(path)).toBe(target)
}

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

describe('directory creation', () => {
  test('creates STATE_DIR when it does not exist', () => {
    const s = makeSandbox()
    const stateDir = join(s.root, 'nested', 'state')

    postinstall({ ...s.opts, stateDir })

    expect(statSync(stateDir).isDirectory()).toBe(true)
  })

  test('creates MCP config parent directory when it does not exist', () => {
    const s = makeSandbox()
    const mcpConfigPath = join(s.root, 'deep', 'nested', 'slack-mcp.json')

    postinstall({ ...s.opts, mcpConfigPath })

    expect(statSync(join(s.root, 'deep', 'nested')).isDirectory()).toBe(true)
  })

  test('does not throw when STATE_DIR already exists', () => {
    const s = makeSandbox()
    mkdirSync(s.stateDir, { recursive: true })

    expect(() => postinstall(s.opts)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

describe('config.json — creation', () => {
  test('a fresh install writes config.json as {"personas": []}, which loads through the persona loader with zero personas (b.av2 SR-1.7)', () => {
    const s = makeSandbox()
    const loaderHome = makeTempDir()

    postinstall(s.opts)

    const configPath = join(s.stateDir, 'config.json')
    expect(readJson(configPath)).toEqual({ personas: [] })
    // Explicit path and injected temp home: nothing resolves under the real home.
    const cfg = loadPersonaConfig(configPath, loaderHome)
    expect(cfg.personas).toEqual([])
    expect(Object.hasOwn(cfg, 'routes')).toBe(false)
  })
})

describe('config.json — skip if exists', () => {
  test('does not overwrite config.json when it already exists', () => {
    const s = makeSandbox()
    const configPath = join(s.stateDir, 'config.json')

    // First run creates it
    postinstall(s.opts)
    const originalContent = readFileSync(configPath, 'utf-8')

    // Manually modify the file
    const edited = {
      personas: [
        {
          name: 'edited',
          credentials_file: join(s.root, 'credentials.json'),
          working_directory: s.root,
          channels: [{ id: 'C0TEST1', delivery: 'all' }],
          permission_prompts: 'C0TEST1',
        },
      ],
    }
    writeFileSync(configPath, JSON.stringify(edited, null, 2) + '\n')
    const modifiedContent = readFileSync(configPath, 'utf-8')

    // Second run — should not overwrite
    postinstall(s.opts)
    const afterSecondRun = readFileSync(configPath, 'utf-8')

    expect(afterSecondRun).toBe(modifiedContent)
    expect(afterSecondRun).not.toBe(originalContent)
  })
})

// ---------------------------------------------------------------------------
// routing.json → config.json migration
// ---------------------------------------------------------------------------

describe('migration: routing.json → config.json', () => {
  test('renames routing.json to config.json when routing.json exists and config.json does not', () => {
    const s = makeSandbox()
    mkdirSync(s.stateDir, { recursive: true })
    const legacyPath = join(s.stateDir, 'routing.json')
    const configPath = join(s.stateDir, 'config.json')

    // Seed a legacy routing.json
    const legacyContent = JSON.stringify({ routes: { C_OLD: { cwd: '/tmp/old' } } }, null, 2) + '\n'
    writeFileSync(legacyPath, legacyContent)

    postinstall(s.opts)

    // routing.json should be gone and config.json should exist with same content
    expect(existsSync(legacyPath)).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).toBe(legacyContent)
  })

  test('does not overwrite config.json when both routing.json and config.json exist', () => {
    const s = makeSandbox()
    mkdirSync(s.stateDir, { recursive: true })
    const legacyPath = join(s.stateDir, 'routing.json')
    const configPath = join(s.stateDir, 'config.json')

    // Seed both files with distinct content
    const legacyContent = JSON.stringify({ routes: { C_OLD: { cwd: '/tmp/old' } } }, null, 2) + '\n'
    const existingContent = JSON.stringify({ routes: { C_NEW: { cwd: '/tmp/new' } } }, null, 2) + '\n'
    writeFileSync(legacyPath, legacyContent)
    writeFileSync(configPath, existingContent)

    postinstall(s.opts)

    // config.json is unchanged and routing.json is left in place
    expect(readFileSync(configPath, 'utf-8')).toBe(existingContent)
    expect(existsSync(legacyPath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// access.json — retired (b.av2 SR-10.1)
// ---------------------------------------------------------------------------

describe('access.json — retired (b.av2 SR-10.1)', () => {
  test('a fresh run creates no access.json: config.json is the only file in the state dir', () => {
    const s = makeSandbox()

    postinstall(s.opts)

    expect(existsSync(join(s.stateDir, 'access.json'))).toBe(false)
    expect(readdirSync(s.stateDir)).toEqual(['config.json'])
  })

  test.each([
    ['a pre-persona access object', Buffer.from(JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U123'], channels: {}, pending: {} }, null, 2) + '\n')],
    ['bytes that are not JSON', Buffer.from([0x7b, 0xff, 0xfe, 0x00, 0x0a])],
    ['an empty file', Buffer.alloc(0)],
  ])('a pre-existing access.json (%s) is left in place byte-for-byte, mode included', (_label, bytes) => {
    const s = makeSandbox()
    mkdirSync(s.stateDir, { recursive: true })
    const accessPath = join(s.stateDir, 'access.json')
    writeFileSync(accessPath, bytes, { mode: 0o640 })
    const before = statSync(accessPath)

    const lines = postinstall(s.opts)

    expect(readFileSync(accessPath).equals(bytes)).toBe(true)
    const after = statSync(accessPath)
    expect(after.mode).toBe(before.mode)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(lines.some((l) => l.includes('access.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// slack-mcp.json
// ---------------------------------------------------------------------------

describe('slack-mcp.json — creation', () => {
  test('creates slack-mcp.json at the given path with an http router entry for localhost 3100', () => {
    const s = makeSandbox()

    postinstall(s.opts)

    expect(readJson(s.mcpConfigPath)).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: { type: 'http', url: 'http://127.0.0.1:3100/mcp' },
      },
    })
  })
})

describe('slack-mcp.json — skip if exists', () => {
  test('does not overwrite slack-mcp.json when it already exists', () => {
    const s = makeSandbox()

    // First run creates it
    postinstall(s.opts)

    // Manually modify the file
    const customContent = JSON.stringify({ mcpServers: { custom: { type: 'stdio', command: 'foo' } } }, null, 2) + '\n'
    writeFileSync(s.mcpConfigPath, customContent)

    // Second run — should not overwrite
    postinstall(s.opts)

    expect(readFileSync(s.mcpConfigPath, 'utf-8')).toBe(customContent)
  })
})

// ---------------------------------------------------------------------------
// homeDir: the base of every default
// ---------------------------------------------------------------------------

describe('homeDir — the base of every default', () => {
  test.each([
    ['unset', undefined],
    ['empty (counts as unset)', ''],
  ])('with only homeDir and SLACK_STATE_DIR %s, a fresh run writes exactly the state, MCP config and skill link under that home', (_label, envValue) => {
    const s = makeSandbox()
    if (envValue === undefined) delete process.env.SLACK_STATE_DIR
    else process.env.SLACK_STATE_DIR = envValue

    postinstall({ homeDir: s.home })

    expect(listTree(s.root)).toEqual([
      'home',
      join('home', '.claude'),
      join('home', '.claude', 'channels'),
      join('home', '.claude', 'channels', 'slack'),
      join('home', '.claude', 'channels', 'slack', 'config.json'),
      join('home', '.claude', 'skills'),
      join('home', '.claude', 'skills', DEBUG_SKILL),
      join('home', '.claude', 'slack-mcp.json'),
    ])
    expect(readJson(join(s.home, '.claude', 'channels', 'slack', 'config.json'))).toEqual({ personas: [] })
    expect(readJson(join(s.home, '.claude', 'slack-mcp.json'))).toHaveProperty(['mcpServers', MCP_SERVER_NAME])
  })
})

// ---------------------------------------------------------------------------
// SLACK_STATE_DIR override
// ---------------------------------------------------------------------------

describe('SLACK_STATE_DIR env override', () => {
  test('without a stateDir option, the config.json skeleton goes to SLACK_STATE_DIR and nothing to the home state dir', () => {
    const s = makeSandbox()
    const envStateDir = join(s.root, 'env-state')
    process.env.SLACK_STATE_DIR = envStateDir

    postinstall({ homeDir: s.home, mcpConfigPath: s.mcpConfigPath })

    expect(readdirSync(envStateDir)).toEqual(['config.json'])
    expect(readJson(join(envStateDir, 'config.json'))).toEqual({ personas: [] })
    expect(existsSync(join(s.home, '.claude', 'channels'))).toBe(false)
  })

  test('a relative SLACK_STATE_DIR resolves against the working directory, as the server resolves it', () => {
    const s = makeSandbox()
    const cwd = join(s.root, 'cwd')
    mkdirSync(cwd)
    process.chdir(cwd)
    process.env.SLACK_STATE_DIR = join('rel', 'state')

    postinstall({ homeDir: s.home, mcpConfigPath: s.mcpConfigPath })

    expect(readJson(join(cwd, 'rel', 'state', 'config.json'))).toEqual({ personas: [] })
    expect(existsSync(join(s.home, '.claude', 'channels'))).toBe(false)
  })

  test('stateDir option takes precedence over SLACK_STATE_DIR env var', () => {
    const s = makeSandbox()
    const envStateDir = join(s.root, 'env-state')
    process.env.SLACK_STATE_DIR = envStateDir

    postinstall(s.opts)

    expect(existsSync(join(s.stateDir, 'config.json'))).toBe(true)
    expect(existsSync(envStateDir)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Skill links: the debugging skill in, the retired skill's link out (SR-10.1)
// ---------------------------------------------------------------------------

describe('skill links — debug-slack-channel-bots', () => {
  test('a fresh run links debug-slack-channel-bots to the package skill and creates no claude-slack-channels-config entry', () => {
    const s = makeSandbox()

    const lines = postinstall(s.opts)

    const dest = join(s.skillsDir, DEBUG_SKILL)
    expectLink(dest, join(PACKAGE_SKILLS, DEBUG_SKILL))
    expect(statSync(join(dest, 'SKILL.md')).isFile()).toBe(true)
    expect(readdirSync(s.skillsDir)).toEqual([DEBUG_SKILL])
    expect(lines).toContain(`linked: ${dest} -> ${join(PACKAGE_SKILLS, DEBUG_SKILL)}`)
  })

  test('a second run keeps the link as it is, logs it as already linked and fails nothing', () => {
    const s = makeSandbox()
    postinstall(s.opts)
    const dest = join(s.skillsDir, DEBUG_SKILL)
    const first = lstatSync(dest)

    let lines: string[] = []
    expect(() => { lines = postinstall(s.opts) }).not.toThrow()

    const second = lstatSync(dest)
    expect(second.ino).toBe(first.ino)
    expect(second.mtimeMs).toBe(first.mtimeMs)
    expect(readdirSync(s.skillsDir)).toEqual([DEBUG_SKILL])
    expect(lines).toContain(`skipped: ${dest} (already linked)`)
    expect(lines.filter((l) => l.startsWith('linked:') || l.startsWith('warning:'))).toEqual([])
  })

  test('a relative link that resolves to the package skill counts as already linked', () => {
    const s = makeSandbox()
    mkdirSync(s.skillsDir, { recursive: true })
    const dest = join(s.skillsDir, DEBUG_SKILL)
    const relTarget = relative(s.skillsDir, join(PACKAGE_SKILLS, DEBUG_SKILL))
    symlinkSync(relTarget, dest)

    const lines = postinstall(s.opts)

    expectLink(dest, relTarget)
    expect(lines).toContain(`skipped: ${dest} (already linked)`)
  })

  test.each([
    ['a dangling link', (s: Sandbox) => join(s.root, 'gone')],
    ['a link to an unrelated directory', (s: Sandbox) => { const d = join(s.root, 'elsewhere'); mkdirSync(d); return d }],
  ])('%s at the debug skill name is replaced by a link to the package skill', (_label, makeTarget) => {
    const s = makeSandbox()
    mkdirSync(s.skillsDir, { recursive: true })
    const dest = join(s.skillsDir, DEBUG_SKILL)
    symlinkSync(makeTarget(s), dest)

    const lines = postinstall(s.opts)

    expectLink(dest, join(PACKAGE_SKILLS, DEBUG_SKILL))
    expect(lines).toContain(`linked: ${dest} -> ${join(PACKAGE_SKILLS, DEBUG_SKILL)}`)
  })

  test.each([
    ['a real directory', {
      make: (dest: string) => {
        mkdirSync(dest, { recursive: true })
        writeFileSync(join(dest, 'SKILL.md'), 'operator notes\n')
      },
      check: (dest: string) => {
        expect(lstatSync(dest).isDirectory()).toBe(true)
        expect(readdirSync(dest)).toEqual(['SKILL.md'])
        expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toBe('operator notes\n')
      },
    }],
    ['a regular file', {
      make: (dest: string) => {
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, 'operator file\n')
      },
      check: (dest: string) => {
        expect(lstatSync(dest).isFile()).toBe(true)
        expect(readFileSync(dest, 'utf-8')).toBe('operator file\n')
      },
    }],
  ])('%s at the debug skill name is kept, contents unchanged, with one skipped line and no warning', (_label, entry) => {
    const s = makeSandbox()
    const dest = join(s.skillsDir, DEBUG_SKILL)
    entry.make(dest)

    let lines: string[] = []
    expect(() => { lines = postinstall(s.opts) }).not.toThrow()

    entry.check(dest)
    // A fresh sandbox otherwise creates everything, so this is the run's only skipped line.
    expect(lines.filter((l) => l.startsWith('skipped:'))).toEqual([
      `skipped: ${dest} (not a link; left in place — remove it to let postinstall link the skill)`,
    ])
    expect(lines.filter((l) => l.startsWith('warning:') || l.startsWith('linked:'))).toEqual([])
    // The rest of the run still completed.
    expect(existsSync(s.mcpConfigPath)).toBe(true)
  })
})

describe('skill links — the retired claude-slack-channels-config link', () => {
  test.each([
    ['an absolute link to the package\'s retired skill path (dangling)', (_s: Sandbox) => RETIRED_PACKAGE_PATH],
    ['a relative link that resolves, from the link\'s own directory, to the package\'s retired skill path', (s: Sandbox) => relative(s.skillsDir, RETIRED_PACKAGE_PATH)],
  ])('%s, which postinstall created, is removed and the debug skill linked', (_label, makeTarget) => {
    const s = makeSandbox()
    mkdirSync(s.skillsDir, { recursive: true })
    const retired = join(s.skillsDir, RETIRED_SKILL)
    symlinkSync(makeTarget(s), retired)

    const lines = postinstall(s.opts)

    expect(entryExists(retired)).toBe(false)
    expect(readdirSync(s.skillsDir)).toEqual([DEBUG_SKILL])
    expectLink(join(s.skillsDir, DEBUG_SKILL), join(PACKAGE_SKILLS, DEBUG_SKILL))
    expect(lines).toContain(`removed: ${retired} (retired skill link)`)
  })

  /** An entry at the retired name that postinstall did not create, and how to check it is untouched. */
  interface OperatorEntry {
    make: (s: Sandbox, retired: string) => void
    check: (s: Sandbox, retired: string) => void
  }

  const OPERATOR_ENTRIES: Array<[string, OperatorEntry]> = [
    ['an operator-owned real directory', {
      make: (_s, retired) => {
        mkdirSync(retired)
        writeFileSync(join(retired, 'SKILL.md'), 'operator skill\n')
      },
      check: (_s, retired) => {
        expect(lstatSync(retired).isDirectory()).toBe(true)
        expect(readdirSync(retired)).toEqual(['SKILL.md'])
        expect(readFileSync(join(retired, 'SKILL.md'), 'utf-8')).toBe('operator skill\n')
      },
    }],
    ['a regular file', {
      make: (_s, retired) => writeFileSync(retired, 'operator file\n'),
      check: (_s, retired) => {
        expect(lstatSync(retired).isFile()).toBe(true)
        expect(readFileSync(retired, 'utf-8')).toBe('operator file\n')
      },
    }],
    ['a link to an unrelated temp directory outside the package', {
      make: (s, retired) => {
        mkdirSync(join(s.root, 'operator-skill'))
        symlinkSync(join(s.root, 'operator-skill'), retired)
      },
      check: (s, retired) => expectLink(retired, join(s.root, 'operator-skill')),
    }],
    ['a relative link that names the package path only when resolved against the working directory', {
      make: (_s, retired) => symlinkSync(relative(process.cwd(), RETIRED_PACKAGE_PATH), retired),
      check: (_s, retired) => expectLink(retired, relative(process.cwd(), RETIRED_PACKAGE_PATH)),
    }],
    ['a link to another skill of this package', {
      make: (_s, retired) => symlinkSync(join(PACKAGE_SKILLS, DEBUG_SKILL), retired),
      check: (_s, retired) => expectLink(retired, join(PACKAGE_SKILLS, DEBUG_SKILL)),
    }],
  ]

  test.each(OPERATOR_ENTRIES)('%s at that name is left untouched and logged as skipped; the debug skill is still linked', (_label, entry) => {
    const s = makeSandbox()
    mkdirSync(s.skillsDir, { recursive: true })
    const retired = join(s.skillsDir, RETIRED_SKILL)
    entry.make(s, retired)

    const lines = postinstall(s.opts)

    entry.check(s, retired)
    expectLink(join(s.skillsDir, DEBUG_SKILL), join(PACKAGE_SKILLS, DEBUG_SKILL))
    expect(lines).toContain(`skipped: ${retired} (not created by postinstall; left in place)`)
    expect(lines.some((l) => l.startsWith('removed:'))).toBe(false)
  })

  test.skipIf(isRoot)('a retired link in a read-only skills dir is kept with warnings naming each error\'s code and message, and no throw (skipped as root: permission bits do not bind root)', () => {
    const s = makeSandbox()
    mkdirSync(s.skillsDir, { recursive: true })
    const retired = join(s.skillsDir, RETIRED_SKILL)
    symlinkSync(RETIRED_PACKAGE_PATH, retired)
    chmodSync(s.skillsDir, 0o555)

    let lines: string[] = []
    try {
      expect(() => { lines = postinstall(s.opts) }).not.toThrow()
    } finally {
      chmodSync(s.skillsDir, 0o755)
    }

    expectLink(retired, RETIRED_PACKAGE_PATH)
    const warnings = lines.filter((l) => l.startsWith('warning:'))
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toStartWith(`warning: could not symlink ${DEBUG_SKILL}: `)
    expect(warnings[1]).toStartWith(`warning: could not remove ${RETIRED_SKILL} link: `)
    // Each names the error by its described form: type, code and its message
    // (through `redactSlackLogText`), then frames.
    for (const w of warnings) expect(w).toMatch(/: \w*Error code=(E[A-Z]+) message="\1: [^"]*"/)
    expect(existsSync(s.mcpConfigPath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Running twice
// ---------------------------------------------------------------------------

describe('running twice', () => {
  test('a second run changes nothing: same config.json, slack-mcp.json and skill links, and no access.json', () => {
    const s = makeSandbox()
    postinstall(s.opts)
    const configBefore = readFileSync(join(s.stateDir, 'config.json'), 'utf-8')
    const mcpBefore = readFileSync(s.mcpConfigPath, 'utf-8')
    const treeBefore = listTree(s.root)

    postinstall(s.opts)

    expect(listTree(s.root)).toEqual(treeBefore)
    expect(readFileSync(join(s.stateDir, 'config.json'), 'utf-8')).toBe(configBefore)
    expect(readFileSync(s.mcpConfigPath, 'utf-8')).toBe(mcpBefore)
    expect(readdirSync(s.stateDir)).toEqual(['config.json'])
    expectLink(join(s.skillsDir, DEBUG_SKILL), join(PACKAGE_SKILLS, DEBUG_SKILL))
  })
})

// ---------------------------------------------------------------------------
// SR-5.2 / b.jg5 SRJ-121: the agent-director probe over an injected install check
// ---------------------------------------------------------------------------

describe('runAgentDirectorPostinstallProbe (SR-5.2, b.jg5 SRJ-121)', () => {
  let warnLines: string[]
  let logLines: string[]
  let warnSpy: ReturnType<typeof spyOn>
  let logSpy: ReturnType<typeof spyOn>
  /** How many times the injected install check ran in the current test. */
  let checkCalls: number

  beforeEach(() => {
    warnLines = []
    logLines = []
    checkCalls = 0
    warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnLines.push(args.map(String).join(' '))
    })
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  /** An injected install check that counts its calls and answers `result`. */
  function checkReturning(result: InstallCheckResult): PostinstallInstallCheck {
    return async () => {
      checkCalls++
      return result
    }
  }

  /** Forbidden forms: the shared upgrade and install-command forms, plus this probe's retired advice. */
  const PROBE_FORBIDDEN_FORMS: readonly ForbiddenForm[] = [
    ...UPGRADE_FORMS,
    ['"Upgrade agent-director" in any case', /upgrade agent-director/i, 'upgrade Agent-Director and retry'],
    ['`bun add agent-director`', /bun add agent-director/, 'bun add agent-director@^0.7.0'],
  ]

  test.each(PROBE_FORBIDDEN_FORMS.map((row) => [row[0], row] as const))(
    'forbidden form self-check (%s): its pattern matches its sample',
    (_label, [, pattern, sample]) => {
      expect(pattern.test(sample)).toBe(true)
    },
  )

  /**
   * The probe's own text in every captured line carries no install, upgrade
   * or `bun add` advice (AC 81). `checkMessage`, when given, is the install
   * check's message a failure warning carries; it must appear in a captured
   * line and is removed before the scan, so only the probe's own text is
   * checked.
   */
  function expectNoUpgradeAdvice(checkMessage?: string): void {
    const lines = [...logLines, ...warnLines]
    expect(lines.length).toBeGreaterThan(0)
    if (checkMessage !== undefined) {
      expect(lines.some((line) => line.includes(checkMessage))).toBe(true)
    }
    for (const line of lines) {
      const own = checkMessage === undefined ? line : line.split(checkMessage).join(' ')
      const flat = own.replace(/\s+/g, ' ')
      for (const [label, pattern] of PROBE_FORBIDDEN_FORMS) {
        expect({ line, form: label, matched: pattern.test(flat) }).toEqual({ line, form: label, matched: false })
      }
    }
  }

  test('a success at or above the Phase 1 floor: resolves to undefined, runs the check once and logs the OK line only', async () => {
    const result = cannedSuccessResult()
    expect(result.note).toBeUndefined()

    await expect(runAgentDirectorPostinstallProbe({ runInstallCheck: checkReturning(result) })).resolves.toBeUndefined()

    expect(checkCalls).toBe(1)
    expect(logLines).toEqual([`postinstall: agent-director ${PHASE1_RC_VERSION} OK`])
    expect(warnLines).toEqual([])
    expectNoUpgradeAdvice()
  })

  test.each([
    ['the last pre-Phase-1 release', OLD_AD_VERSION],
    ['the dev placeholder', DEV_PLACEHOLDER_VERSION],
  ] as const)('a success below the Phase 1 floor (%s): logs the OK line, then the note naming the runbook section', async (_label, version) => {
    const result = cannedSuccessResult({ binaryVersion: version })
    expect(result.note).toBe(buildInstallCheckPhase1Note(version))

    await expect(runAgentDirectorPostinstallProbe({ runInstallCheck: checkReturning(result) })).resolves.toBeUndefined()

    expect(checkCalls).toBe(1)
    expect(logLines).toEqual([
      `postinstall: agent-director ${version} OK`,
      `postinstall: note: ${buildInstallCheckPhase1Note(version)}`,
    ])
    expect(logLines[1]).toContain(INSTALL_CHECK_PHASE1_NOTE_PHRASE)
    expect(logLines[1]).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expect(warnLines).toEqual([])
    expectNoUpgradeAdvice()
  })

  test.each([
    AD_SYSTEM_INSTALL_NOT_FOUND,
    AD_SYSTEM_INSTALL_TOO_OLD,
    AD_SYSTEM_INSTALL_UNREACHABLE,
    AD_VERSION_FLOOR_UNREADABLE,
  ] as const)('a failure (%s): resolves to undefined with exactly one warning naming the class label and carrying the check message', async (label) => {
    const result = cannedFailureResult(label)

    await expect(runAgentDirectorPostinstallProbe({ runInstallCheck: checkReturning(result) })).resolves.toBeUndefined()

    expect(checkCalls).toBe(1)
    expect(logLines).toEqual([])
    expect(warnLines).toHaveLength(1)
    expect(warnLines[0]).toStartWith(`postinstall warning: agent-director install check failed (${label}): `)
    expect(warnLines[0]).toContain(result.message)
    expect(warnLines[0]).toContain('`bun run install-check`')
    expectNoUpgradeAdvice(result.message)
  })

  test('the too-old failure warning names the switch-over runbook section', async () => {
    const result = cannedFailureResult(AD_SYSTEM_INSTALL_TOO_OLD)

    await runAgentDirectorPostinstallProbe({ runInstallCheck: checkReturning(result) })

    expect(warnLines).toHaveLength(1)
    expect(warnLines[0]).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expectNoUpgradeAdvice(result.message)
  })

  /** Injected checks that fail to produce a result, each throwing the value it is given. */
  const THROWING_CHECKS: readonly [label: string, make: (thrown: unknown) => PostinstallInstallCheck, thrown: unknown][] = [
    ['rejects with an Error', (thrown) => async () => { checkCalls++; throw thrown }, new Error('probe stub: check failed')],
    ['throws synchronously', (thrown) => () => { checkCalls++; throw thrown }, new Error('probe stub: sync throw')],
    ['rejects with a non-Error value', (thrown) => async () => { checkCalls++; throw thrown }, 'probe stub: bare string'],
  ]

  test.each(THROWING_CHECKS)('a check that %s: resolves to undefined with exactly one warning describing the thrown value', async (_label, make, thrown) => {
    await expect(runAgentDirectorPostinstallProbe({ runInstallCheck: make(thrown) })).resolves.toBeUndefined()

    expect(checkCalls).toBe(1)
    expect(logLines).toEqual([])
    expect(warnLines).toEqual([
      `postinstall warning: the agent-director install check could not run (${describeThrownValue(thrown)}); ` +
        'run `bun run install-check` for the full diagnosis.',
    ])
    expectNoUpgradeAdvice()
  })
})
