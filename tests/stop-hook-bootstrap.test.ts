/**
 * stop-hook-bootstrap.test.ts — Unit tests for src/stop-hook-bootstrap.ts
 *
 * Covers every SR-6.4 case listed in Epic t1.osj.72 / subtask t3.osj.72.ru.2x.
 *
 * Follows the tests/trust-bootstrap.test.ts pattern:
 *   - mkdtempSync per-test temp directories with afterEach cleanup
 *   - process.env save/restore in beforeEach/afterEach
 *   - SLACK_STATE_DIR redirection to capture startup-errors.log
 *   - Real fs; no mocks
 *
 * No hardcoded managed command literals (SR-6.1): expectations either derive
 * the canonical path from the module's own resolver, or assert that the
 * written command contains `slack-reply-guard.sh`, is an absolute path, and
 * points at an existing file.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
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
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { stopHookBootstrap } from '../src/stop-hook-bootstrap.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

/**
 * Absolute path to src/stop-hook-bootstrap.ts, used by subprocess runners so
 * their working directory does not matter.
 */
const STOP_HOOK_BOOTSTRAP_SRC = fileURLToPath(
  new URL('../src/stop-hook-bootstrap.ts', import.meta.url),
)

/**
 * Run stopHookBootstrap in a fresh Bun subprocess with a launch-time HOME so
 * that node:os `homedir()` inside the child resolves to `fakeHome` instead of
 * the operator's real home directory. Bun snapshots HOME at process launch, so
 * mutating process.env in-test is insufficient.
 *
 * The child prints one control line `HOMEDIR::<path>` to stdout so the parent
 * can assert HOME was actually honored before trusting the refusal behavior.
 */
interface SubprocessResult {
  status: number | null
  stdout: string
  stderr: string
  observedHomedir: string
}

function runBootstrapInSubprocess(
  cfg: unknown,
  env: { HOME: string; SLACK_STATE_DIR: string; extra?: Record<string, string> },
): SubprocessResult {
  const script = `
    const { homedir } = require('node:os');
    process.stdout.write('HOMEDIR::' + homedir() + '\\n');
    const cfg = JSON.parse(process.env.STOP_HOOK_CFG_JSON);
    const mod = await import(${JSON.stringify(STOP_HOOK_BOOTSTRAP_SRC)});
    mod.stopHookBootstrap(cfg);
  `
  const childEnv: Record<string, string> = {
    // Deliberately do NOT forward parent's HOME. Keep PATH so `bun` and `sh`
    // (used inside the module for jq detection) resolve.
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: env.HOME,
    SLACK_STATE_DIR: env.SLACK_STATE_DIR,
    ...(env.extra ?? {}),
    STOP_HOOK_CFG_JSON: JSON.stringify(cfg),
  }
  const res = spawnSync('bun', ['-e', script], {
    env: childEnv,
    encoding: 'utf-8',
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  const m = stdout.match(/^HOMEDIR::(.*)$/m)
  const observedHomedir = m ? m[1]! : ''
  return { status: res.status, stdout, stderr, observedHomedir }
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
    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      routes: { 'C_CREATE': { cwd: '/tmp/x' } },
    })

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

    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      routes: { 'C_IDEM': { cwd: '/tmp/x' } },
    })
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

    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      routes: { 'C_STALE': { cwd: '/tmp/x' } },
    })
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

    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      routes: { 'C_PRESERVE': { cwd: '/tmp/x' } },
    })
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

    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      routes: { 'C_BADJSON': { cwd: '/tmp/x' } },
    })

    expect(() => stopHookBootstrap(cfg)).not.toThrow()

    // File bytes unchanged
    expect(readFileSync(path, 'utf-8')).toBe(before)
    const log = readLog()
    expect(log).toContain('stop-hook-bootstrap-settings-parse')
    expect(log).toContain(path)
  })

  // -------------------------------------------------------------------------
  // Skip routes with no effective claude_config_dir
  // -------------------------------------------------------------------------

  test('skips a route with no effective claude_config_dir and writes nothing', () => {
    const cwdTemp = newTempDir()
    const cfg = makeRoutingConfig({
      // No top-level claude_config_dir
      claude_config_dir: undefined,
      routes: { 'C_NODIR': { cwd: cwdTemp } },
    })

    expect(() => stopHookBootstrap(cfg)).not.toThrow()

    // Nothing written into cwd (guard against resolve("") land) or into that temp
    expect(existsSync(join(cwdTemp, 'settings.json'))).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Skip empty/whitespace-only dir
  // -------------------------------------------------------------------------

  test('empty/whitespace-only claude_config_dir is skipped; nothing written to cwd', () => {
    const cwdBefore = process.cwd()
    const cfg = makeRoutingConfig({
      claude_config_dir: '   ',
      routes: { 'C_BLANK': { cwd: '/tmp/x' } },
    })

    expect(() => stopHookBootstrap(cfg)).not.toThrow()

    // Nothing written to cwd
    expect(existsSync(join(cwdBefore, 'settings.json'))).toBe(false)
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

    const cfg = makeRoutingConfig({
      claude_config_dir: personalClaude,
      routes: { 'C_HOME': { cwd: '/tmp/x' } },
    })

    const res = runBootstrapInSubprocess(cfg, { HOME: fakeHome, SLACK_STATE_DIR: logDir })

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

    const cfg = makeRoutingConfig({
      claude_config_dir: linkPath,
      routes: { 'C_HOMELINK': { cwd: '/tmp/x' } },
    })

    const res = runBootstrapInSubprocess(cfg, { HOME: fakeHome, SLACK_STATE_DIR: logDir })

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

  test('shared dir with mixed per-route flags → managed entry is installed (any-enabled wins)', () => {
    const dir = newTempDir()
    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      stop_hook_bootstrap: false, // default disabled
      routes: {
        'C_OFF': { cwd: '/tmp/a', stop_hook_bootstrap: false },
        'C_ON': { cwd: '/tmp/b', stop_hook_bootstrap: true },
      },
    })

    stopHookBootstrap(cfg)

    const doc = readSettings(dir)
    const managed = managedEntriesOf(doc)
    expect(managed).toHaveLength(1)
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

    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      stop_hook_bootstrap: false,
      routes: {
        'C_A': { cwd: '/tmp/a', stop_hook_bootstrap: false },
        'C_B': { cwd: '/tmp/b', stop_hook_bootstrap: false },
      },
    })

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

    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      routes: { 'C_DUP': { cwd: '/tmp/x' } },
    })
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
    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      routes: { 'C_SHAPE': { cwd: '/tmp/x' } },
    })
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

    const cfg = makeRoutingConfig({
      claude_config_dir: dir,
      routes: { 'C_JQ': { cwd: '/tmp/x' } },
    })

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
    writeFileSync(join(badDir, 'settings.json'), '{not json', 'utf-8')

    const cfg = makeRoutingConfig({
      claude_config_dir: goodDir, // fallback
      routes: {
        'C_GOOD': { cwd: '/tmp/g', claude_config_dir: goodDir },
        'C_BAD':  { cwd: '/tmp/b', claude_config_dir: badDir },
      },
    })

    expect(() => stopHookBootstrap(cfg)).not.toThrow()

    // Good dir patched
    const doc = readSettings(goodDir)
    expect(managedEntriesOf(doc)).toHaveLength(1)
    // Bad dir left untouched
    expect(readFileSync(join(badDir, 'settings.json'), 'utf-8')).toBe('{not json')
  })
})
