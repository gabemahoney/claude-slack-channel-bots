/**
 * stop-hook-bootstrap.test.ts — Unit tests for src/stop-hook-bootstrap.ts
 *
 * Covers every SR-6.4 case listed in Epic t1.osj.72 / subtask t3.osj.72.ru.2x.
 *
 * Follows the tests/trust-bootstrap.test.ts pattern:
 *   - mkdtempSync per-test temp directories with afterEach cleanup
 *   - process.env save/restore in beforeEach/afterEach
 *   - SLACK_STATE_DIR redirected to a per-test temp dir in beforeEach, so no
 *     recordStartupError write (e.g. jq absent on the host) lands under HOME;
 *     tests that read the log point it at their own dir
 *   - Real fs; no mocks
 *
 * No hardcoded managed command literals (SR-6.1): expectations either derive
 * the canonical path from the module's own resolver, or assert that the
 * written command contains `slack-reply-guard.sh`, is an absolute path, and
 * points at an existing file.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
  symlinkSync,
  chmodSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type PersonaConfig, resolvePersonaConfig } from '../src/config.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { stopHookBootstrap } from '../src/stop-hook-bootstrap.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import {
  makeMultiPersonaConfig,
  makePersona,
  makePersonaConfigInput,
  type PersonaSpec,
} from './test-helpers/persona-config.ts'

/**
 * Absolute path to src/stop-hook-bootstrap.ts, used by subprocess runners so
 * their working directory does not matter.
 */
const STOP_HOOK_BOOTSTRAP_SRC = fileURLToPath(
  new URL('../src/stop-hook-bootstrap.ts', import.meta.url),
)

/** Child-side call for runInFakeHome: `input` is the persona config. */
const STOP_HOOK_CALL = 'mod.stopHookBootstrap(input);'

/**
 * Run stopHookBootstrap in a fresh Bun subprocess whose launch-time HOME is
 * `home` (see tests/test-helpers/fake-home-subprocess.ts), so the personal
 * ~/.claude the bootstrap refuses lies inside the fake home.
 */
function runBootstrapInFakeHome(cfg: PersonaConfig, home: string, stateDir: string) {
  return runInFakeHome({ modulePath: STOP_HOOK_BOOTSTRAP_SRC, call: STOP_HOOK_CALL, input: cfg, home, stateDir })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'stop-hook-bootstrap-test-'))
}

function readSettings(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')) as Record<string, unknown>
}

function captureStartupErrors(logDir: string): () => string {
  process.env['SLACK_STATE_DIR'] = logDir
  const logPath = join(logDir, 'startup-errors.log')
  return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
}

/**
 * The canonical managed command path, derived from the module's own resolver
 * logic (no hardcoded absolute string). Mirrors resolveManagedCommand() in
 * src/stop-hook-bootstrap.ts.
 */
function expectedCanonicalCommand(): string {
  // src/stop-hook-bootstrap.ts computes:
  //   join(dirname(import.meta.url path), '..', 'stop-hooks', 'slack-reply-guard.sh')
  const srcModuleUrl = new URL('../src/stop-hook-bootstrap.ts', import.meta.url)
  const moduleDir = dirname(fileURLToPath(srcModuleUrl))
  return join(moduleDir, '..', 'stop-hooks', 'slack-reply-guard.sh')
}

interface HookCmd {
  type?: string
  command?: string
  [k: string]: unknown
}
interface HookGroup {
  matcher?: string
  hooks?: HookCmd[]
  [k: string]: unknown
}

function stopGroupsOf(doc: Record<string, unknown>): HookGroup[] {
  const hooks = doc.hooks as Record<string, unknown> | undefined
  if (!hooks) return []
  const stop = hooks.Stop
  return Array.isArray(stop) ? (stop as HookGroup[]) : []
}

function managedEntriesOf(doc: Record<string, unknown>): HookCmd[] {
  const out: HookCmd[] = []
  for (const g of stopGroupsOf(doc)) {
    for (const h of g.hooks ?? []) {
      if (typeof h?.command === 'string' && h.command.includes('slack-reply-guard.sh')) {
        out.push(h)
      }
    }
  }
  return out
}

/** Prepend a PATH dir with no jq to simulate jq-absent. */
function pathWithoutJq(): string {
  return newTempDir()
}

/**
 * A resolved persona configuration whose personas' default paths sit in a
 * fresh temp dir of their own. `claude_config_dir` / `stop_hook_bootstrap`
 * in `overrides` are the top-level values each persona inherits unless its
 * spec sets its own.
 */
function personaConfigOf(
  specs: PersonaSpec[],
  overrides: Partial<Omit<PersonaConfig, 'personas'>> = {},
): PersonaConfig {
  return makeMultiPersonaConfig(specs, newTempDir(), overrides)
}

/** One persona inheriting the top-level `claude_config_dir` = `dir`. */
function singlePersonaConfig(dir: string): PersonaConfig {
  return personaConfigOf([{}], { claude_config_dir: dir })
}

/** Run `fn` with console.error captured; returns the joined lines. */
function captureConsoleError(fn: () => void): string {
  const spy = spyOn(console, 'error').mockImplementation(() => {})
  try {
    fn()
    return spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
  } finally {
    spy.mockRestore()
  }
}

/** A settings.json seed holding one managed-only Stop group. */
function seedManagedEntry(dir: string): void {
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/seed/slack-reply-guard.sh' }] }] } }),
    'utf-8',
  )
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tempDirs: string[] = []
let savedEnv: typeof process.env

function newTempDir(): string {
  const d = makeTempDir()
  tempDirs.push(d)
  return d
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stopHookBootstrap (SR-6.4)', () => {
  beforeEach(() => {
    savedEnv = { ...process.env }
    // Every test's startup-errors.log goes to a temp dir, never under HOME:
    // a host without jq records stop-hook-bootstrap-jq-missing on every run.
    process.env['SLACK_STATE_DIR'] = newTempDir()
  })

  afterEach(() => {
    process.env = savedEnv as NodeJS.ProcessEnv
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    tempDirs = []
  })

  // -------------------------------------------------------------------------
  // Create-missing settings.json
  // -------------------------------------------------------------------------

  test('creates settings.json with canonical managed group when missing', () => {
    const dir = newTempDir()
    const cfg = singlePersonaConfig(dir)

    expect(() => stopHookBootstrap(cfg)).not.toThrow()

    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
    const doc = readSettings(dir)
    const managed = managedEntriesOf(doc)
    expect(managed).toHaveLength(1)
    const cmd = managed[0]!.command as string
    expect(cmd).toContain('slack-reply-guard.sh')
    expect(isAbsolute(cmd)).toBe(true)
    expect(existsSync(cmd)).toBe(true)
    // Managed entry has no matcher and its own group
    const groups = stopGroupsOf(doc)
    // The canonical group must have exactly one hook, and no matcher
    const canonicalGroup = groups.find((g) => (g.hooks ?? []).some(
      (h) => typeof h.command === 'string' && h.command.includes('slack-reply-guard.sh'),
    ))
    expect(canonicalGroup).toBeDefined()
    expect(canonicalGroup!.matcher).toBeUndefined()
    expect(canonicalGroup!.hooks).toHaveLength(1)
    expect(managed[0]!.type).toBe('command')
  })

  // -------------------------------------------------------------------------
  // Idempotent no-write when entry correct (mtime)
  // -------------------------------------------------------------------------

  test('does not rewrite settings.json when a single canonical managed group is already present (mtime unchanged)', async () => {
    const dir = newTempDir()
    const canonical = expectedCanonicalCommand()
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: 'command', command: canonical }] }] } },
        null,
        2,
      ),
      'utf-8',
    )
    const path = join(dir, 'settings.json')
    const mtimeBefore = statSync(path).mtimeMs

    // Wait a moment so any write would show up
    await new Promise((r) => setTimeout(r, 15))

    const cfg = singlePersonaConfig(dir)
    stopHookBootstrap(cfg)

    expect(statSync(path).mtimeMs).toBe(mtimeBefore)
  })

  // -------------------------------------------------------------------------
  // Stale entry rewrite (self-heal)
  // -------------------------------------------------------------------------

  test('rewrites a stale managed entry (wrong path) to the canonical entry', () => {
    const dir = newTempDir()
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: '/old/path/to/slack-reply-guard.sh' }] },
          ],
        },
      }),
      'utf-8',
    )

    const cfg = singlePersonaConfig(dir)
    stopHookBootstrap(cfg)

    const doc = readSettings(dir)
    const managed = managedEntriesOf(doc)
    expect(managed).toHaveLength(1)
    const cmd = managed[0]!.command as string
    expect(isAbsolute(cmd)).toBe(true)
    expect(existsSync(cmd)).toBe(true)
    expect(cmd).not.toBe('/old/path/to/slack-reply-guard.sh')
    expect(cmd).toBe(expectedCanonicalCommand())
  })

  // -------------------------------------------------------------------------
  // Preservation of operator (non-managed) hooks and other settings
  // -------------------------------------------------------------------------

  test('preserves non-managed Stop hooks in mixed groups and other settings content', () => {
    const dir = newTempDir()
    const seed = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        Stop: [
          {
            matcher: 'my-matcher',
            hooks: [
              { type: 'command', command: '/usr/local/bin/operator-hook.sh' },
              { type: 'command', command: '/old/slack-reply-guard.sh' },
            ],
          },
        ],
        PreToolUse: [{ hooks: [{ type: 'command', command: '/pre.sh' }] }],
      },
      otherTop: 'preserved',
    }
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(seed, null, 2), 'utf-8')

    const cfg = singlePersonaConfig(dir)
    stopHookBootstrap(cfg)

    const doc = readSettings(dir)
    // Preserved top-level
    expect(doc.otherTop).toBe('preserved')
    expect((doc.permissions as Record<string, unknown>).allow).toEqual(['Bash(ls:*)'])
    // PreToolUse untouched
    const hooks = doc.hooks as Record<string, unknown>
    expect(hooks.PreToolUse).toEqual([
      { hooks: [{ type: 'command', command: '/pre.sh' }] },
    ] as unknown)
    // Mixed Stop group retained non-managed hook, and canonical entry added
    const stop = stopGroupsOf(doc)
    const operatorGroup = stop.find((g) => g.matcher === 'my-matcher')
    expect(operatorGroup).toBeDefined()
    expect(operatorGroup!.hooks).toEqual([
      { type: 'command', command: '/usr/local/bin/operator-hook.sh' },
    ] as unknown as HookCmd[])
    // Canonical managed group present exactly once
    const managed = managedEntriesOf(doc)
    expect(managed).toHaveLength(1)
    expect(managed[0]!.command).toBe(expectedCanonicalCommand())
  })

  // -------------------------------------------------------------------------
  // Malformed JSON soft-fail — no clobber
  // -------------------------------------------------------------------------

  test('malformed JSON is not clobbered; startup error recorded naming the file', async () => {
    const dir = newTempDir()
    const logDir = newTempDir()
    const readLog = captureStartupErrors(logDir)

    const bad = '{ this is not : valid json '
    const path = join(dir, 'settings.json')
    writeFileSync(path, bad, 'utf-8')
    const before = readFileSync(path, 'utf-8')

    const cfg = singlePersonaConfig(dir)

    expect(() => stopHookBootstrap(cfg)).not.toThrow()

    // File bytes unchanged
    expect(readFileSync(path, 'utf-8')).toBe(before)
    const log = readLog()
    expect(log).toContain('stop-hook-bootstrap-settings-parse')
    expect(log).toContain(path)
  })

  // -------------------------------------------------------------------------
  // Skip personas with no effective claude_config_dir
  // -------------------------------------------------------------------------

  test('skips a persona with no effective claude_config_dir, names it, and writes nothing for it', () => {
    const workDir = newTempDir()
    const otherDir = newTempDir()
    // No top-level claude_config_dir: the first persona has no effective dir;
    // the second sets its own, so the skip must not stop it being patched.
    const cfg = personaConfigOf([
      { name: 'no_dir_bot', working_directory: workDir },
      { name: 'own_dir_bot', claude_config_dir: otherDir },
    ])
    expect(cfg.personas[0]!.claude_config_dir).toBeUndefined()

    let stderr = ''
    expect(() => { stderr = captureConsoleError(() => stopHookBootstrap(cfg)) }).not.toThrow()

    // Nothing written into the skipped persona's working directory.
    expect(readdirSync(workDir)).toEqual([])
    expect(stderr).toContain(`${renderPersonaRef('no_dir_bot')} has no claude_config_dir — skipping`)
    // The other persona's dir is still patched.
    expect(managedEntriesOf(readSettings(otherDir))).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Skip empty/whitespace-only dir
  // -------------------------------------------------------------------------

  test.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('%s persona claude_config_dir is skipped; nothing written to cwd', (_label, blank) => {
    // Run from an empty temp cwd so a resolve("") regression would land there,
    // never in the repo checkout.
    const cwdTemp = newTempDir()
    const cwdBefore = process.cwd()
    const cfg = personaConfigOf([{ name: 'blank_dir_bot', claude_config_dir: blank }])

    let stderr = ''
    process.chdir(cwdTemp)
    try {
      expect(() => { stderr = captureConsoleError(() => stopHookBootstrap(cfg)) }).not.toThrow()
    } finally {
      process.chdir(cwdBefore)
    }

    // Nothing written to cwd
    expect(readdirSync(cwdTemp)).toEqual([])
    expect(stderr).toContain(`${renderPersonaRef('blank_dir_bot')} has empty/whitespace claude_config_dir — skipping`)
  })

  // -------------------------------------------------------------------------
  // Personal-dir refusal (direct)
  // -------------------------------------------------------------------------

  test('refuses to touch operator\'s ~/.claude (direct); no file written, startup error recorded', () => {
    // node:os homedir() snapshots HOME at process launch on Bun, so mutating
    // process.env inside this test process cannot redirect it. We run the
    // bootstrap in a fresh subprocess whose HOME points at a temp dir. That
    // way the "personal ~/.claude" the bootstrap refuses is entirely inside
    // the fake home — the operator's real ~/.claude is never touched even if
    // the refusal logic regresses.
    const fakeHome = newTempDir()
    const personalClaude = join(fakeHome, '.claude')
    mkdirSync(personalClaude, { recursive: true })
    const settingsPath = join(personalClaude, 'settings.json')

    const logDir = newTempDir()
    const logPath = join(logDir, 'startup-errors.log')

    // Two personas share the personal dir: one refusal, naming both.
    const cfg = personaConfigOf(
      [{ name: 'home_bot_a' }, { name: 'home_bot_b' }],
      { claude_config_dir: personalClaude },
    )

    const res = runBootstrapInFakeHome(cfg, fakeHome, logDir)

    // Control: prove the subprocess actually saw the fake HOME.
    expect(res.observedHomedir).toBe(fakeHome)
    expect(res.status).toBe(0)

    // No settings.json created under the fake ~/.claude.
    expect(existsSync(settingsPath)).toBe(false)
    // Nothing else written under fake ~/.claude either.
    expect(readdirSync(personalClaude)).toEqual([])

    // Startup error recorded with the refuse-home code.
    expect(existsSync(logPath)).toBe(true)
    const log = readFileSync(logPath, 'utf-8')
    expect(log).toContain('stop-hook-bootstrap-refuse-home')
    expect(log).toContain(`personas=${renderPersonaRef('home_bot_a')}, ${renderPersonaRef('home_bot_b')}`)
    expect(log.match(/stop-hook-bootstrap-refuse-home/g)).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Personal-dir refusal (symlink resolves to $HOME/.claude)
  // -------------------------------------------------------------------------

  test('refuses to touch a symlink resolving to operator\'s ~/.claude; no file written, error recorded', () => {
    // Subprocess-with-fake-HOME variant: point HOME at a temp dir, then feed
    // the bootstrap a symlink that resolves (realpathSync) to that fake
    // $HOME/.claude. If the refusal regresses, only the fake home is written
    // to — the operator's real ~/.claude is safe.
    const fakeHome = newTempDir()
    const personalClaude = join(fakeHome, '.claude')
    mkdirSync(personalClaude, { recursive: true })
    const settingsPath = join(personalClaude, 'settings.json')

    const linkParent = newTempDir()
    const linkPath = join(linkParent, 'shared-claude-link')
    symlinkSync(personalClaude, linkPath)

    const logDir = newTempDir()
    const logPath = join(logDir, 'startup-errors.log')

    const cfg = personaConfigOf([{ name: 'home_link_bot', claude_config_dir: linkPath }])

    const res = runBootstrapInFakeHome(cfg, fakeHome, logDir)

    // Control: subprocess actually saw the fake HOME.
    expect(res.observedHomedir).toBe(fakeHome)
    expect(res.status).toBe(0)

    // No settings.json created in the fake ~/.claude via the symlink.
    expect(existsSync(settingsPath)).toBe(false)
    expect(readdirSync(personalClaude)).toEqual([])

    // Startup error recorded with the refuse-home code.
    expect(existsSync(logPath)).toBe(true)
    const log = readFileSync(logPath, 'utf-8')
    expect(log).toContain('stop-hook-bootstrap-refuse-home')
  })

  // -------------------------------------------------------------------------
  // Shared-dir mixed flags → install
  // -------------------------------------------------------------------------

  // Both orders: the enabled persona wins whether it comes first or last.
  test.each([
    ['disabled first', [false, true]],
    ['enabled first', [true, false]],
  ] as const)('shared dir with mixed per-persona flags (%s) → managed entry is installed (any-enabled wins)', (_label, flags) => {
    const dir = newTempDir()
    const cfg = personaConfigOf(
      flags.map((flag, i) => ({ name: `mixed_bot_${i}`, stop_hook_bootstrap: flag })),
      { claude_config_dir: dir, stop_hook_bootstrap: false }, // default disabled
    )

    stopHookBootstrap(cfg)

    const doc = readSettings(dir)
    const managed = managedEntriesOf(doc)
    expect(managed).toHaveLength(1)
    expect(managed[0]!.command).toBe(expectedCanonicalCommand())
  })

  // -------------------------------------------------------------------------
  // Grouping is per effective dir: each dir follows only its own personas
  // -------------------------------------------------------------------------

  test('personas in different dirs are grouped per dir: the enabled dir installs, the disabled dir removes', () => {
    const onDir = newTempDir()
    const offDir = newTempDir()
    seedManagedEntry(offDir)
    const cfg = personaConfigOf(
      [
        { name: 'on_bot', claude_config_dir: onDir, stop_hook_bootstrap: true },
        { name: 'off_bot', claude_config_dir: offDir, stop_hook_bootstrap: false },
      ],
      { stop_hook_bootstrap: false },
    )

    stopHookBootstrap(cfg)

    expect(managedEntriesOf(readSettings(onDir))).toHaveLength(1)
    // The disabled dir's managed entry is removed and its emptied group pruned.
    expect(managedEntriesOf(readSettings(offDir))).toHaveLength(0)
    expect(stopGroupsOf(readSettings(offDir))).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Grouping keys on the real path: a symlink to a dir joins that dir's group
  // -------------------------------------------------------------------------

  /**
   * A real target under this test's temp dir and a symlink to it, also under
   * a temp dir. The target is resolved with realpathSync first, since the OS
   * temp dir may itself be a symlink.
   */
  function realAndLink(makeTarget: (path: string) => void): { real: string; link: string } {
    const real = join(realpathSync(newTempDir()), 'target')
    makeTarget(real)
    const link = join(newTempDir(), 'config-link')
    symlinkSync(real, link)
    return { real, link }
  }

  // One persona reaches the dir directly and the other through the symlink;
  // one is enabled and one is disabled. Grouped by configured path instead,
  // they would form two groups and the later one would win, so one order
  // would end with the entry removed.
  test.each([
    ['enabled persona first, on the real path', 'real'],
    ['disabled persona first, on the real path', 'link'],
  ] as const)('two personas reaching one dir through a symlink form one group (%s): exactly one managed entry', (_label, enabledVia) => {
    const { real, link } = realAndLink((p) => mkdirSync(p))
    const enabled = { name: 'enabled_bot', claude_config_dir: enabledVia === 'real' ? real : link, stop_hook_bootstrap: true }
    const disabled = { name: 'disabled_bot', claude_config_dir: enabledVia === 'real' ? link : real, stop_hook_bootstrap: false }
    const specs = enabledVia === 'real' ? [enabled, disabled] : [disabled, enabled]
    const cfg = personaConfigOf(specs, { stop_hook_bootstrap: false })

    stopHookBootstrap(cfg)

    expect(managedEntriesOf(readSettings(real)).map((h) => h.command)).toEqual([expectedCanonicalCommand()])
    // One settings.json, written once (no leftover .tmp); the link still points at the real dir.
    expect(readdirSync(real)).toEqual(['settings.json'])
    expect(realpathSync(link)).toBe(real)
  })

  // The shared path is a regular file, so the one group is recorded as not a
  // directory: one record, naming both personas, with the first persona's
  // configured path as the dir.
  test.each([
    ['real path first', 'real'],
    ['symlink first', 'link'],
  ] as const)('diagnostics for a dir reached through a symlink name both personas once (%s)', (_label, first) => {
    const { real, link } = realAndLink((p) => writeFileSync(p, 'not a dir', 'utf-8'))
    const paths = first === 'real' ? [real, link] : [link, real]
    const cfg = personaConfigOf([
      { name: 'first_bot', claude_config_dir: paths[0]!, stop_hook_bootstrap: true },
      { name: 'second_bot', claude_config_dir: paths[1]!, stop_hook_bootstrap: false },
    ])
    const readLog = captureStartupErrors(newTempDir())

    stopHookBootstrap(cfg)

    const records = readLog().split('\n').filter((l) => l.includes('[stop-hook-bootstrap-not-a-dir]'))
    expect(records).toHaveLength(1)
    expect(records[0]).toContain(`claude_config_dir ${paths[0]} is not a directory`)
    expect(records[0]).toContain(`personas=${renderPersonaRef('first_bot')}, ${renderPersonaRef('second_bot')}`)
    expect(readFileSync(real, 'utf-8')).toBe('not a dir')
  })

  // -------------------------------------------------------------------------
  // Shared-dir all-disabled → remove; duplicate managed entries all removed;
  // emptied groups pruned
  // -------------------------------------------------------------------------

  test('shared dir all-disabled removes ALL managed duplicates and prunes emptied managed-only groups', () => {
    const dir = newTempDir()
    const seed = {
      hooks: {
        Stop: [
          // Managed-only group A — should be pruned
          { hooks: [{ type: 'command', command: '/first/slack-reply-guard.sh' }] },
          // Mixed group — managed removed, non-managed kept
          {
            matcher: 'keep-me',
            hooks: [
              { type: 'command', command: '/second/slack-reply-guard.sh' },
              { type: 'command', command: '/usr/local/bin/other.sh' },
            ],
          },
          // Managed-only group B — should also be pruned (duplicate)
          { hooks: [{ type: 'command', command: '/third/slack-reply-guard.sh' }] },
        ],
      },
    }
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(seed, null, 2), 'utf-8')

    const cfg = personaConfigOf(
      [
        { name: 'off_bot_a', stop_hook_bootstrap: false },
        { name: 'off_bot_b', stop_hook_bootstrap: false },
      ],
      { claude_config_dir: dir, stop_hook_bootstrap: false },
    )

    stopHookBootstrap(cfg)

    const doc = readSettings(dir)
    expect(managedEntriesOf(doc)).toHaveLength(0)
    const stop = stopGroupsOf(doc)
    // The two managed-only groups pruned; one mixed group remains
    expect(stop).toHaveLength(1)
    expect(stop[0]!.matcher).toBe('keep-me')
    expect(stop[0]!.hooks).toEqual([
      { type: 'command', command: '/usr/local/bin/other.sh' },
    ] as unknown as HookCmd[])
  })

  // -------------------------------------------------------------------------
  // Duplicate managed entries collapse to one canonical entry
  // -------------------------------------------------------------------------

  test('duplicate managed entries collapse to one canonical entry in its own group', () => {
    const dir = newTempDir()
    const seed = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/dup1/slack-reply-guard.sh' }] },
          {
            matcher: 'x',
            hooks: [
              { type: 'command', command: '/dup2/slack-reply-guard.sh' },
              { type: 'command', command: '/keep.sh' },
            ],
          },
          { hooks: [{ type: 'command', command: '/dup3/slack-reply-guard.sh' }] },
        ],
      },
    }
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(seed, null, 2), 'utf-8')

    const cfg = singlePersonaConfig(dir)
    stopHookBootstrap(cfg)

    const doc = readSettings(dir)
    const managed = managedEntriesOf(doc)
    expect(managed).toHaveLength(1)
    const cmd = managed[0]!.command as string
    expect(cmd).toContain('slack-reply-guard.sh')
    expect(isAbsolute(cmd)).toBe(true)
    expect(existsSync(cmd)).toBe(true)

    // The canonical group has no matcher and only the canonical hook
    const stop = stopGroupsOf(doc)
    const canonicalGroup = stop.find((g) =>
      (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('slack-reply-guard.sh')),
    )
    expect(canonicalGroup).toBeDefined()
    expect(canonicalGroup!.matcher).toBeUndefined()
    expect(canonicalGroup!.hooks).toHaveLength(1)
    // Non-managed operator hook preserved
    const keepGroup = stop.find((g) => g.matcher === 'x')
    expect(keepGroup).toBeDefined()
    expect(keepGroup!.hooks).toEqual([
      { type: 'command', command: '/keep.sh' },
    ] as unknown as HookCmd[])
  })

  // -------------------------------------------------------------------------
  // Managed entry shape: no matcher, own group, command = existing absolute path
  // -------------------------------------------------------------------------

  test('managed entry shape has NO matcher field, is its own group, and command is an existing absolute path', () => {
    const dir = newTempDir()
    const cfg = singlePersonaConfig(dir)
    stopHookBootstrap(cfg)

    const doc = readSettings(dir)
    const stop = stopGroupsOf(doc)
    const managedGroup = stop.find((g) =>
      (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('slack-reply-guard.sh')),
    )
    expect(managedGroup).toBeDefined()
    // No matcher on managed group
    expect('matcher' in (managedGroup as object)).toBe(false)
    // Own group — exactly one hook, which is the canonical managed one
    expect(managedGroup!.hooks).toHaveLength(1)
    const h = managedGroup!.hooks![0]!
    expect(h.type).toBe('command')
    const cmd = h.command as string
    expect(cmd).toContain('slack-reply-guard.sh')
    expect(isAbsolute(cmd)).toBe(true)
    expect(existsSync(cmd)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // jq absent → warn + recordStartupError + entry still installed
  // -------------------------------------------------------------------------

  test('jq absent from PATH → startup error recorded but managed entry still installed', () => {
    const dir = newTempDir()
    const logDir = newTempDir()

    const readLog = captureStartupErrors(logDir)
    // Point PATH at a dir with no jq — plus include /bin and /usr/bin for sh
    // itself. Actually, `command -v jq` runs under sh; we only need to prevent
    // jq from resolving. Restrict PATH to an empty dir. sh's builtin
    // `command -v` doesn't need PATH.
    const emptyBin = pathWithoutJq()
    process.env['PATH'] = emptyBin

    const cfg = singlePersonaConfig(dir)

    expect(() => stopHookBootstrap(cfg)).not.toThrow()

    const log = readLog()
    expect(log).toContain('stop-hook-bootstrap-jq-missing')
    // Managed entry still installed
    const doc = readSettings(dir)
    expect(managedEntriesOf(doc)).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Per-dir failure isolation — one dir failing does not prevent others
  // -------------------------------------------------------------------------

  test('one dir failing (malformed JSON) does not prevent the other dir from being patched', () => {
    const goodDir = newTempDir()
    const badDir = newTempDir()
    const logDir = newTempDir()
    const readLog = captureStartupErrors(logDir)
    writeFileSync(join(badDir, 'settings.json'), '{not json', 'utf-8')

    // Top-level dir is goodDir; the bad persona overrides it with badDir, so
    // using the top-level dir instead of the persona's would never reach
    // badDir. The bad persona comes first, so a failure that aborted the loop
    // would leave goodDir unpatched.
    const cfg = personaConfigOf(
      [
        { name: 'bad_bot', claude_config_dir: badDir },
        { name: 'good_bot', claude_config_dir: goodDir },
      ],
      { claude_config_dir: goodDir },
    )

    expect(() => stopHookBootstrap(cfg)).not.toThrow()

    // Good dir patched
    const doc = readSettings(goodDir)
    expect(managedEntriesOf(doc)).toHaveLength(1)
    // Bad dir was attempted (parse failure recorded for its file) and left untouched
    const log = readLog()
    expect(log).toContain('stop-hook-bootstrap-settings-parse')
    expect(log).toContain(join(badDir, 'settings.json'))
    expect(readFileSync(join(badDir, 'settings.json'), 'utf-8')).toBe('{not json')
  })

  // -------------------------------------------------------------------------
  // Per-persona stop_hook_bootstrap overrides the top-level default
  // -------------------------------------------------------------------------

  /**
   * Resolve a file-form config through the persona loader, so the per-persona
   * override and the top-level default are applied exactly as at start.
   */
  function resolvedFromFile(dir: string, topLevel: boolean, own: boolean | undefined): PersonaConfig {
    const base = newTempDir()
    const persona = makePersona({ name: 'override_bot', claude_config_dir: dir }, base)
    const raw = makePersonaConfigInput(
      {
        stop_hook_bootstrap: topLevel,
        personas: [own === undefined ? persona : { ...persona, stop_hook_bootstrap: own }],
      },
      base,
    )
    return resolvePersonaConfig(raw, base, base)
  }

  // The persona's own flag wins over the top-level default; without one it
  // follows the default. The dir starts with a managed entry, so a removal is
  // visible, and the expected count is the effective flag.
  test.each([
    [true, false, false],
    [false, true, true],
    [false, undefined, false],
    [true, undefined, true],
  ] as const)('top-level stop_hook_bootstrap=%p, persona=%p → effective %p', (topLevel, own, effective) => {
    const dir = newTempDir()
    seedManagedEntry(dir)
    const cfg = resolvedFromFile(dir, topLevel, own)
    expect(cfg.personas[0]!.stop_hook_bootstrap).toBe(effective)

    stopHookBootstrap(cfg)

    expect(managedEntriesOf(readSettings(dir)).map((h) => h.command)).toEqual(
      effective ? [expectedCanonicalCommand()] : [],
    )
  })
})
