/**
 * stop-hook-bootstrap.test.ts — Unit tests for src/stop-hook-bootstrap.ts and
 * the per-persona reply-guard record helpers in src/reply-guard-record.ts
 * (b.av2 SR-6.2, SR-6.4, SR-6.5, SR-9.4).
 *
 * Covers the managed Stop hook's command shape and patch engine, the
 * record-aware install rule (effective flag, record, launched-with dir), the
 * start pass and the launch-time pass, the record written before each launch
 * (nothing written or patched for a persona outside the applied set, b.av2
 * SR-8.6),
 * the two-persona shared-dir case end to end through the installed command,
 * the undo of an optimistic launch, the teardown helper and the record
 * helpers. The AC 59 block drives the same rule through a confirmed reload
 * (`makeReloadHarness` with the real launch path, b.av2 SR-8.6): a changed
 * `stop_hook_bootstrap` or `claude_config_dir`, own or inherited, reaches the
 * record and the managed hook only at the persona's next launch, and a
 * neighbour's launch leaves a running persona's record unchanged.
 *
 * Isolation (b.av2 SR-13.2):
 *   - mkdtempSync per-test temp directories, removed in afterEach
 *   - process.env saved and restored; SLACK_STATE_DIR points at a per-test
 *     temp dir, so no recordStartupError write lands under HOME
 *   - the record state dir is a separate helper-made temp dir, passed
 *     explicitly; its path contains a space and a single quote, so every
 *     test also runs the managed command's quoting
 *   - launched-with dirs reset before and after each test
 *   - the ~/.claude refusal runs in a subprocess with a fake HOME
 *   - every sh child (the word splitter and the installed guard) gets its
 *     env from hostSafeChildEnv: a per-test temp HOME, a PATH of the named
 *     tools only, CSCB_PERSONA only as an explicit extra; the guard also
 *     runs with a timeout
 *
 * No hard-coded managed command: expectations use the module's
 * managedHookCommand over the test's state dir, and the shape test splits the
 * command with a real shell.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Persona, type PersonaConfig, type PersonaInput, resolvePersonaConfig } from '../src/config.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import {
  deleteReplyGuardRecord,
  readReplyGuardRecord,
  readReplyGuardRecordText,
  replyGuardRecordPath,
  writeReplyGuardRecord,
} from '../src/reply-guard-record.ts'
import {
  _resetLaunchedWithDirs,
  getLaunchedWithDir,
  managedHookCommand,
  preLaunchReplyGuard,
  stopHookBootstrap,
  teardownPersonaReplyGuard,
} from '../src/stop-hook-bootstrap.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import {
  makeMultiPersonaConfig,
  makePersona,
  makePersonaConfigInput,
  type PersonaSpec,
} from './test-helpers/persona-config.ts'
import {
  makeReloadHarness,
  TEMPLATE_REFRESH_KEY,
  type ReloadHarness,
  type ReloadRun,
} from './test-helpers/reload-harness.ts'
import { makeReplyGuardRecordDir, type ReplyGuardRecordDir } from './test-helpers/reply-guard-record.ts'

/** Absolute path to src/stop-hook-bootstrap.ts, for the fake-HOME subprocess. */
const STOP_HOOK_BOOTSTRAP_SRC = fileURLToPath(new URL('../src/stop-hook-bootstrap.ts', import.meta.url))

/** The packaged guard, resolved independently of the module under test. */
const GUARD_PATH = fileURLToPath(new URL('../stop-hooks/slack-reply-guard.sh', import.meta.url))

/** A via-carrying delivered Slack message with no reply: the guard reminds on it. */
const NO_REPLY_FIXTURE = fileURLToPath(
  new URL('./fixtures/slack-reply-guard/mention-no-reply.jsonl', import.meta.url),
)

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

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

function readSettings(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')) as Record<string, unknown>
}

function stopGroupsOf(doc: Record<string, unknown>): HookGroup[] {
  const stop = (doc.hooks as Record<string, unknown> | undefined)?.Stop
  return Array.isArray(stop) ? (stop as HookGroup[]) : []
}

function managedEntriesOf(doc: Record<string, unknown>): HookCmd[] {
  return stopGroupsOf(doc).flatMap((g) =>
    (g.hooks ?? []).filter((h) => typeof h?.command === 'string' && h.command.includes('slack-reply-guard.sh')),
  )
}

/** The managed commands in `<dir>/settings.json`. */
function managedCommands(dir: string): (string | undefined)[] {
  return managedEntriesOf(readSettings(dir)).map((h) => h.command)
}

function writeSettings(dir: string, doc: unknown): void {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(doc, null, 2), 'utf-8')
}

/** A settings.json holding one managed-only Stop group with the pre-E10 bare-path command. */
function seedManagedEntry(dir: string): void {
  writeSettings(dir, { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/seed/slack-reply-guard.sh' }] }] } })
}

/** Run `fn` with console.error captured; returns the captured lines. */
function captureConsoleError(fn: () => void): string[] {
  const spy = spyOn(console, 'error').mockImplementation(() => {})
  try {
    fn()
    return spy.mock.calls.map((args) => args.map(String).join(' '))
  } finally {
    spy.mockRestore()
  }
}

/** Split a command line into its words with a real shell (each word on its own line); `printf` is a shell builtin. */
function shellWords(command: string): string[] {
  const res = spawnSync('sh', ['-c', `printf '%s\\n' ${command}`], {
    env: hostSafeChildEnv(newTempDir(), { tools: ['sh'] }),
    encoding: 'utf-8',
    timeout: 20_000,
  })
  if (res.status !== 0) throw new Error(`shellWords: sh exited ${res.status}: ${res.stderr}`)
  return res.stdout.replace(/\n$/, '').split('\n')
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tempDirs: string[] = []
let savedEnv: typeof process.env
/** The per-test record state dir (path has a space and a single quote). */
let rec: ReplyGuardRecordDir
/** Reads the per-test startup-errors.log ('' when absent). */
let readStartupLog: () => string

function newTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'stop-hook-bootstrap-test-'))
  tempDirs.push(d)
  return d
}

/** Point SLACK_STATE_DIR at a fresh temp dir; returns its startup-errors.log reader. */
function captureStartupErrors(logDir: string = newTempDir()): () => string {
  process.env['SLACK_STATE_DIR'] = logDir
  const logPath = join(logDir, 'startup-errors.log')
  return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
}

/** Startup-error lines other than jq-missing (which depends on the host). */
function startupEntriesBesidesJq(): string[] {
  return readStartupLog().split('\n').filter((l) => l !== '' && !l.includes('stop-hook-bootstrap-jq-missing'))
}

/**
 * A resolved persona configuration whose personas' default paths sit in a
 * fresh temp dir. `claude_config_dir` / `stop_hook_bootstrap` in `overrides`
 * are the top-level values each persona inherits unless its spec sets its own.
 */
function personaConfigOf(specs: PersonaSpec[], overrides: Partial<Omit<PersonaConfig, 'personas'>> = {}): PersonaConfig {
  return makeMultiPersonaConfig(specs, newTempDir(), overrides)
}

function personaNamed(cfg: PersonaConfig, name: string): Persona {
  const p = cfg.personas.find((x) => x.name === name)
  if (p === undefined) throw new Error(`no persona named ${name}`)
  return p
}

/** The canonical managed command for this test's state dir. */
function canonical(): string {
  return managedHookCommand(rec.stateDir)
}

/** The start pass over `cfg`, with this test's state dir. */
function startPass(cfg: PersonaConfig): void {
  stopHookBootstrap(cfg, rec.stateDir)
}

/** The pre-launch reply-guard steps for `persona`, over the applied set `personas`. */
function launch(persona: Persona, personas: readonly Persona[]): () => void {
  return preLaunchReplyGuard(persona, personas, rec.stateDir)
}

/** Launch the persona named `name` of `cfg`, over `cfg`'s personas. */
function launchNamed(cfg: PersonaConfig, name: string): () => void {
  return launch(personaNamed(cfg, name), cfg.personas)
}

/** The two entry points that apply the install rule to a persona's dir. */
type Entry = 'start' | 'launch'
const ENTRIES: Entry[] = ['start', 'launch']

/** Run `entry` for the first persona of `cfg`. */
function runEntry(entry: Entry, cfg: PersonaConfig): void {
  if (entry === 'start') startPass(cfg)
  else launch(cfg.personas[0]!, cfg.personas)
}

/** One persona inheriting the top-level `claude_config_dir` = `dir`. */
function singlePersonaConfig(dir: string): PersonaConfig {
  return personaConfigOf([{}], { claude_config_dir: dir })
}

/** Every file under `root` with its contents (directories as `<dir>/`), for "touched nothing" checks. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      const rel = relative(root, p)
      if (entry.isDirectory()) {
        out[`${rel}/`] = ''
        walk(p)
      } else {
        out[rel] = readFileSync(p, 'utf-8')
      }
    }
  }
  walk(root)
  return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stop-hook-bootstrap and the reply-guard record', () => {
  beforeEach(() => {
    savedEnv = { ...process.env }
    // startup-errors.log goes to a temp dir, never under HOME. The record
    // state dir is a different temp dir, passed explicitly.
    readStartupLog = captureStartupErrors()
    rec = makeReplyGuardRecordDir({ parentDir: newTempDir(), spaceAndQuote: true })
    _resetLaunchedWithDirs()
  })

  afterEach(() => {
    _resetLaunchedWithDirs()
    process.env = savedEnv as NodeJS.ProcessEnv
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true })
    }
    tempDirs = []
  })

  // -------------------------------------------------------------------------
  // Command and entry shape
  // -------------------------------------------------------------------------

  test('creates settings.json with one managed group: no matcher, and the command is the guard path plus the quoted record dir', () => {
    const dir = newTempDir()
    startPass(singlePersonaConfig(dir))

    const groups = stopGroupsOf(readSettings(dir))
    expect(groups).toHaveLength(1)
    expect('matcher' in groups[0]!).toBe(false)
    expect(groups[0]!.hooks).toHaveLength(1)
    const hook = groups[0]!.hooks![0]!
    expect(hook.type).toBe('command')
    expect(hook.command).toBe(canonical())

    // Through a shell the command is exactly two words: the existing absolute
    // guard path, and the record dir (whose path has a space and a quote).
    const words = shellWords(hook.command!)
    expect(words).toEqual([GUARD_PATH, rec.recordDir])
    expect(isAbsolute(words[0]!)).toBe(true)
    expect(existsSync(words[0]!)).toBe(true)
    expect(rec.recordDir).toContain(' ')
    expect(rec.recordDir).toContain("'")
  })

  test('does not rewrite settings.json already holding the single canonical group, at start or at launch (mtime unchanged)', async () => {
    const dir = newTempDir()
    writeSettings(dir, { hooks: { Stop: [{ hooks: [{ type: 'command', command: canonical() }] }] } })
    const path = join(dir, 'settings.json')
    const mtimeBefore = statSync(path).mtimeMs
    await new Promise((r) => setTimeout(r, 15))

    const cfg = singlePersonaConfig(dir)
    startPass(cfg)
    launch(cfg.personas[0]!, cfg.personas)

    expect(statSync(path).mtimeMs).toBe(mtimeBefore)
  })

  // The pre-E10 entry is a bare path; an entry naming another record dir is
  // also stale. Either is replaced by one canonical group; everything the
  // operator owns is kept.
  test.each([
    ['the pre-E10 bare-path entry', (): string => '/seed/slack-reply-guard.sh'],
    ['an entry naming another record dir', (): string => managedHookCommand(newTempDir())],
  ] as const)('upgrades %s to exactly one canonical entry and preserves non-managed content', (_label, staleCommand) => {
    const dir = newTempDir()
    const stale = staleCommand()
    writeSettings(dir, {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: stale }] },
          {
            matcher: 'my-matcher',
            hooks: [
              { type: 'command', command: '/usr/local/bin/operator-hook.sh' },
              { type: 'command', command: stale },
            ],
          },
        ],
        PreToolUse: [{ hooks: [{ type: 'command', command: '/pre.sh' }] }],
      },
      otherTop: 'preserved',
    })

    startPass(singlePersonaConfig(dir))

    const doc = readSettings(dir)
    expect(doc.otherTop).toBe('preserved')
    expect(doc.permissions).toEqual({ allow: ['Bash(ls:*)'] })
    expect((doc.hooks as Record<string, unknown>).PreToolUse).toEqual([
      { hooks: [{ type: 'command', command: '/pre.sh' }] },
    ])
    expect(stopGroupsOf(doc)).toEqual([
      { matcher: 'my-matcher', hooks: [{ type: 'command', command: '/usr/local/bin/operator-hook.sh' }] },
      { hooks: [{ type: 'command', command: canonical() }] },
    ])
  })

  test('duplicate managed entries (the canonical one among them) collapse to one canonical entry in its own group', () => {
    const dir = newTempDir()
    writeSettings(dir, {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/dup1/slack-reply-guard.sh' }] },
          {
            matcher: 'x',
            hooks: [
              { type: 'command', command: canonical() },
              { type: 'command', command: '/keep.sh' },
            ],
          },
          { hooks: [{ type: 'command', command: canonical() }] },
        ],
      },
    })

    startPass(singlePersonaConfig(dir))

    expect(stopGroupsOf(readSettings(dir))).toEqual([
      { matcher: 'x', hooks: [{ type: 'command', command: '/keep.sh' }] },
      { hooks: [{ type: 'command', command: canonical() }] },
    ])
  })

  test('a dir with no enabled persona loses every managed duplicate; emptied managed-only groups are pruned, mixed groups kept', () => {
    const dir = newTempDir()
    writeSettings(dir, {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/first/slack-reply-guard.sh' }] },
          {
            matcher: 'keep-me',
            hooks: [
              { type: 'command', command: canonical() },
              { type: 'command', command: '/usr/local/bin/other.sh' },
            ],
          },
          { hooks: [{ type: 'command', command: canonical() }] },
        ],
      },
    })
    const cfg = personaConfigOf([{ name: 'off_bot_a' }, { name: 'off_bot_b' }], {
      claude_config_dir: dir,
      stop_hook_bootstrap: false,
    })

    startPass(cfg)

    expect(stopGroupsOf(readSettings(dir))).toEqual([
      { matcher: 'keep-me', hooks: [{ type: 'command', command: '/usr/local/bin/other.sh' }] },
    ])
  })

  // -------------------------------------------------------------------------
  // The record written at launch
  // -------------------------------------------------------------------------

  /**
   * Resolve a file-form config through the persona loader, so the per-persona
   * override and the top-level default apply exactly as at start. The
   * persona's name is not its own key.
   */
  function resolvedFromFile(dir: string, topLevel: boolean, own: boolean | undefined): PersonaConfig {
    const base = newTempDir()
    const persona = makePersona({ name: 'Override Bot', claude_config_dir: dir }, base)
    const raw = makePersonaConfigInput(
      { stop_hook_bootstrap: topLevel, personas: [own === undefined ? persona : { ...persona, stop_hook_bootstrap: own }] },
      base,
    )
    return resolvePersonaConfig(raw, base, base)
  }

  // The persona's own flag wins over the top-level one; without one it follows
  // the top level. The first two rows start with no reply-guard/ dir; the
  // last two start with the opposite record, which the launch overwrites. The
  // dir starts with a managed entry, so the hook follows the effective value.
  test.each([
    [true, false, false, null],
    [false, true, true, null],
    [false, undefined, false, 'true'],
    [true, undefined, true, 'false'],
  ] as const)(
    'top-level=%p, persona=%p: the launch writes reply-guard/<key> = %p (previous record %p), no temp file, hook follows',
    (topLevel, own, effective, previous) => {
      const dir = newTempDir()
      seedManagedEntry(dir)
      const cfg = resolvedFromFile(dir, topLevel, own)
      const persona = cfg.personas[0]!
      expect(persona.key).not.toBe(persona.name)
      expect(persona.stop_hook_bootstrap).toBe(effective)
      if (previous !== null) rec.writeRecord(persona.key, previous)
      expect(existsSync(rec.recordDir)).toBe(previous !== null)

      launch(persona, cfg.personas)

      // The file name is the key, the content exactly the effective value,
      // and nothing else (no .tmp, no file named after the name) is there.
      expect(readdirSync(rec.recordDir)).toEqual([persona.key])
      expect(rec.readRecord(persona.key)).toBe(String(effective))
      expect(managedCommands(dir)).toEqual(effective ? [canonical()] : [])
      expect(getLaunchedWithDir(persona.key)).toBe(dir)
    },
  )

  // -------------------------------------------------------------------------
  // Two personas sharing one config dir (the Task success criterion)
  // -------------------------------------------------------------------------

  test('shared dir, one enabled and one disabled: records true/false, one managed entry, and only the enabled persona is reminded through the installed command', () => {
    const dir = newTempDir()
    const cfg = personaConfigOf(
      [{ name: 'shared_on' }, { name: 'shared_off', stop_hook_bootstrap: false }],
      { claude_config_dir: dir },
    )
    const on = personaNamed(cfg, 'shared_on')
    const off = personaNamed(cfg, 'shared_off')

    startPass(cfg)
    launch(on, cfg.personas)
    launch(off, cfg.personas)

    expect(rec.readRecord(on.key)).toBe('true')
    expect(rec.readRecord(off.key)).toBe('false')
    const commands = managedCommands(dir)
    expect(commands).toEqual([canonical()])

    // Run the installed command as Claude Code does: through a shell, with the
    // instance's CSCB_PERSONA and the Stop-hook JSON on stdin. The guard is a
    // bash script that reads stdin with cat and parses it with jq.
    const runInstalled = (key: string) => {
      const res = spawnSync('sh', ['-c', commands[0]!], {
        input: JSON.stringify({ transcript_path: NO_REPLY_FIXTURE, stop_hook_active: false }),
        env: hostSafeChildEnv(newTempDir(), { tools: ['sh', 'bash', 'cat', 'jq'], extras: { CSCB_PERSONA: key } }),
        encoding: 'utf-8',
        timeout: 20_000,
      })
      if (res.signal !== null || res.error !== undefined) throw new Error(`guard did not exit normally: ${res.stderr}`)
      return res
    }
    const enabled = runInstalled(on.key)
    expect(enabled.status).toBe(2)
    expect(enabled.stderr).not.toBe('')
    const disabled = runInstalled(off.key)
    expect(disabled.status).toBe(0)
    expect(disabled.stderr).toBe('')
    expect(disabled.stdout).toBe('')
  })

  // -------------------------------------------------------------------------
  // A neighbour's launch, and next-launch semantics
  // -------------------------------------------------------------------------

  test("a neighbour's disabled launch into the same dir leaves a running persona's true record and the hook in place", () => {
    const dir = newTempDir()
    const cfg = personaConfigOf(
      [{ name: 'running_a' }, { name: 'neighbour_b', stop_hook_bootstrap: false }],
      { claude_config_dir: dir },
    )
    const a = personaNamed(cfg, 'running_a')
    const b = personaNamed(cfg, 'neighbour_b')
    launch(a, cfg.personas)

    launch(b, cfg.personas)

    expect(rec.readRecord(a.key)).toBe('true')
    expect(rec.readRecord(b.key)).toBe('false')
    expect(managedCommands(dir)).toEqual([canonical()])
  })

  test('a changed value takes effect only at the next launch: the true record and the hook stay until then', () => {
    const dir = newTempDir()
    seedManagedEntry(dir)
    const before = personaConfigOf([{ name: 'changing_a' }, { name: 'quiet_b', stop_hook_bootstrap: false }], {
      claude_config_dir: dir,
    })
    launchNamed(before, 'changing_a')
    // The operator turns changing_a off; its instance keeps running.
    const after: PersonaConfig = {
      ...before,
      personas: before.personas.map((p) => (p.name === 'changing_a' ? { ...p, stop_hook_bootstrap: false } : p)),
    }
    const a = personaNamed(after, 'changing_a')

    // A re-evaluation before a's next launch (a neighbour's launch, then a
    // start pass) keeps the hook: a's record still reads true.
    launchNamed(after, 'quiet_b')
    startPass(after)
    expect(rec.readRecord(a.key)).toBe('true')
    expect(managedCommands(dir)).toEqual([canonical()])

    // a's next launch writes false; no one in the dir is enabled any more.
    launch(a, after.personas)
    expect(rec.readRecord(a.key)).toBe('false')
    expect(managedEntriesOf(readSettings(dir))).toEqual([])
    expect(stopGroupsOf(readSettings(dir))).toEqual([])
  })

  // -------------------------------------------------------------------------
  // The install and remove rule
  // -------------------------------------------------------------------------

  interface RuleRow {
    /** The persona's configured value now. */
    own: boolean
    /** Record content seeded before the evaluation (null: none). */
    record: string | null
    /**
     * Launch the persona into the dir with this value first, then move its
     * configured dir elsewhere (its instance keeps the launched-with dir).
     */
    launchedHereWith?: boolean
    expected: 'installed' | 'removed'
  }

  const RULE_ROWS: [string, RuleRow][] = [
    ['enabled, no record', { own: true, record: null, expected: 'installed' }],
    ['disabled, record true', { own: false, record: 'true', expected: 'installed' }],
    ['disabled, record false', { own: false, record: 'false', expected: 'removed' }],
    ['disabled, no record', { own: false, record: null, expected: 'removed' }],
    ['moved elsewhere, launched here with true', { own: false, record: null, launchedHereWith: true, expected: 'installed' }],
    ['moved elsewhere, launched here with false', { own: false, record: null, launchedHereWith: false, expected: 'removed' }],
    ['moved elsewhere, never launched here, record true', { own: false, record: 'true', expected: 'removed' }],
  ]

  // The dir also holds a disabled neighbour, so both the start pass and the
  // neighbour's launch evaluate it. It starts with a stale managed-only group,
  // so an install shows as the canonical entry and a removal as no group.
  test.each(ENTRIES.flatMap((entry) => RULE_ROWS.map(([label, row]) => [entry, label, row.expected, row] as const)))(
    '%s evaluation: %s → %s',
    (entry, label, _expected, row) => {
      const dir = newTempDir()
      const elsewhere = newTempDir()
      const movedAway = label.startsWith('moved elsewhere')
      const personaDir = movedAway ? elsewhere : dir
      const specs = (own: boolean, cd: string): PersonaSpec[] => [
        { name: 'rule_p', claude_config_dir: cd, stop_hook_bootstrap: own },
        { name: 'rule_neighbour', claude_config_dir: dir, stop_hook_bootstrap: false },
      ]
      if (row.launchedHereWith !== undefined) {
        const then = personaConfigOf(specs(row.launchedHereWith, dir))
        launchNamed(then, 'rule_p')
        expect(getLaunchedWithDir(personaNamed(then, 'rule_p').key)).toBe(dir)
      }
      const cfg = personaConfigOf(specs(row.own, personaDir))
      if (row.record !== null) rec.writeRecord(personaNamed(cfg, 'rule_p').key, row.record)
      seedManagedEntry(dir)

      if (entry === 'start') startPass(cfg)
      else launchNamed(cfg, 'rule_neighbour')

      const doc = readSettings(dir)
      if (row.expected === 'installed') {
        expect(stopGroupsOf(doc)).toEqual([{ hooks: [{ type: 'command', command: canonical() }] }])
      } else {
        expect(stopGroupsOf(doc)).toEqual([])
      }
    },
  )

  // A relaunch into a new dir re-evaluates the dir the instance launched with:
  // it loses the hook unless another persona there still keeps it.
  test.each([
    ['no one else there', false, []],
    ['an enabled neighbour still there', true, ['canonical']],
  ] as const)('a persona relaunched into a new dir moves the hook to it; the old dir, with %s, keeps the hook = %p', (_label, withNeighbour, oldExpected) => {
    const oldDir = newTempDir()
    const newDir = newTempDir()
    const neighbour: PersonaSpec[] = withNeighbour ? [{ name: 'stay_bot', claude_config_dir: oldDir }] : []
    const before = personaConfigOf([{ name: 'moving_bot', claude_config_dir: oldDir }, ...neighbour])
    launchNamed(before, 'moving_bot')
    expect(managedCommands(oldDir)).toEqual([canonical()])
    const after = personaConfigOf([{ name: 'moving_bot', claude_config_dir: newDir }, ...neighbour])

    launchNamed(after, 'moving_bot')

    expect(managedCommands(newDir)).toEqual([canonical()])
    expect(managedCommands(oldDir)).toEqual(oldExpected.map(() => canonical()))
    expect(getLaunchedWithDir(personaNamed(after, 'moving_bot').key)).toBe(newDir)
  })

  // -------------------------------------------------------------------------
  // Start pass over every persona
  // -------------------------------------------------------------------------

  test('the start pass applies the rule to every distinct dir, and a malformed dir stops none of the others', () => {
    const badDir = newTempDir()
    const onDir = newTempDir()
    const offDir = newTempDir()
    const recordDir = newTempDir()
    writeFileSync(join(badDir, 'settings.json'), '{not json', 'utf-8')
    seedManagedEntry(offDir)
    seedManagedEntry(recordDir)
    // The bad persona comes first and overrides the top-level dir, so an
    // aborted loop, or one using the top-level dir, would show.
    const cfg = personaConfigOf(
      [
        { name: 'bad_bot', claude_config_dir: badDir },
        { name: 'on_bot' },
        { name: 'off_bot', claude_config_dir: offDir, stop_hook_bootstrap: false },
        { name: 'record_bot', claude_config_dir: recordDir, stop_hook_bootstrap: false },
      ],
      { claude_config_dir: onDir },
    )
    rec.writeRecord(personaNamed(cfg, 'record_bot').key, 'true')

    startPass(cfg)

    expect(managedCommands(onDir)).toEqual([canonical()])
    expect(managedCommands(recordDir)).toEqual([canonical()])
    expect(stopGroupsOf(readSettings(offDir))).toEqual([])
    expect(readFileSync(join(badDir, 'settings.json'), 'utf-8')).toBe('{not json')
    const log = readStartupLog()
    expect(log).toContain('stop-hook-bootstrap-settings-parse')
    expect(log).toContain(join(badDir, 'settings.json'))
  })

  // -------------------------------------------------------------------------
  // Grouping keys on the real path: a symlink to a dir joins that dir's group
  // -------------------------------------------------------------------------

  /** A real target (resolved first; the OS temp dir may be a link) and a symlink to it. */
  function realAndLink(makeTarget: (path: string) => void): { real: string; link: string } {
    const real = join(realpathSync(newTempDir()), 'target')
    makeTarget(real)
    const link = join(newTempDir(), 'config-link')
    symlinkSync(real, link)
    return { real, link }
  }

  // Grouped by configured path instead, the two would form two groups and
  // the later one would win, so one order would end with the entry removed.
  test.each([
    ['enabled persona first, on the real path', 'real'],
    ['disabled persona first, on the real path', 'link'],
  ] as const)('two personas reaching one dir through a symlink form one group (%s): exactly one managed entry', (_label, enabledVia) => {
    const { real, link } = realAndLink((p) => mkdirSync(p))
    const enabled = { name: 'enabled_bot', claude_config_dir: enabledVia === 'real' ? real : link, stop_hook_bootstrap: true }
    const disabled = { name: 'disabled_bot', claude_config_dir: enabledVia === 'real' ? link : real, stop_hook_bootstrap: false }
    const cfg = personaConfigOf(enabledVia === 'real' ? [enabled, disabled] : [disabled, enabled])

    startPass(cfg)
    launchNamed(cfg, 'disabled_bot')

    expect(managedCommands(real)).toEqual([canonical()])
    expect(readdirSync(real)).toEqual(['settings.json'])
    expect(realpathSync(link)).toBe(real)
  })

  // The shared path is a regular file: one not-a-dir record naming both
  // personas, with the first persona's configured path as the dir.
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

    startPass(cfg)

    const records = readStartupLog().split('\n').filter((l) => l.includes('[stop-hook-bootstrap-not-a-dir]'))
    expect(records).toHaveLength(1)
    expect(records[0]).toContain(`claude_config_dir ${paths[0]} is not a directory`)
    expect(records[0]).toContain(`personas=${renderPersonaRef('first_bot')}, ${renderPersonaRef('second_bot')}`)
    expect(readFileSync(real, 'utf-8')).toBe('not a dir')
  })

  // -------------------------------------------------------------------------
  // Per-dir failures: recorded at start, server-log lines only at launch
  // -------------------------------------------------------------------------

  // `settings` is written into the dir; `kind` makes the dir itself a file or
  // leaves it missing. The launch pass reports the same class but never adds
  // a startup-errors.log entry.
  test.each(
    ENTRIES.flatMap((entry) =>
      (
        [
          ['malformed JSON', 'stop-hook-bootstrap-settings-parse', 'settings', '{ this is not : valid json '],
          ['a non-object top level', 'stop-hook-bootstrap-settings-shape', 'settings', '[]'],
          ['a regular file as the dir', 'stop-hook-bootstrap-not-a-dir', 'file', 'not a dir'],
          ['a missing dir', 'stop-hook-bootstrap-dir-missing', 'missing', ''],
        ] as const
      ).map((row) => [entry, ...row] as const),
    ),
  )('%s with %s: file untouched, [%s] reported for the right sink', (entry, _label, cls, kind, content) => {
    const parent = newTempDir()
    const dir = kind === 'settings' ? parent : join(parent, 'config')
    if (kind === 'settings') writeFileSync(join(dir, 'settings.json'), content, 'utf-8')
    if (kind === 'file') writeFileSync(dir, content, 'utf-8')
    const cfg = singlePersonaConfig(dir)

    let lines: string[] = []
    expect(() => {
      lines = captureConsoleError(() => runEntry(entry, cfg))
    }).not.toThrow()

    if (kind === 'settings') expect(readFileSync(join(dir, 'settings.json'), 'utf-8')).toBe(content)
    if (kind === 'file') expect(readFileSync(dir, 'utf-8')).toBe(content)
    if (kind === 'missing') expect(existsSync(dir)).toBe(false)
    if (entry === 'start') {
      expect(readStartupLog()).toContain(`[${cls}]`)
    } else {
      expect(readStartupLog()).toBe('')
      expect(lines.some((l) => l.includes(`[${cls}]`))).toBe(true)
    }
  })

  test.each(ENTRIES)('jq absent from PATH (%s): the entry is still installed; only the start pass records jq-missing', (entry) => {
    const dir = newTempDir()
    process.env['PATH'] = newTempDir()

    expect(() => runEntry(entry, singlePersonaConfig(dir))).not.toThrow()

    expect(managedCommands(dir)).toEqual([canonical()])
    if (entry === 'start') expect(readStartupLog()).toContain('stop-hook-bootstrap-jq-missing')
    else expect(readStartupLog()).toBe('')
  })

  // -------------------------------------------------------------------------
  // No configured dir, and blank dirs
  // -------------------------------------------------------------------------

  test.each(ENTRIES)(
    'a persona with no configured dir is skipped (%s): nothing written, no startup error, a server-log line names it',
    (entry) => {
      const workDir = newTempDir()
      const otherDir = newTempDir()
      // No top-level dir: the first persona has none; the second sets its own.
      const cfg = personaConfigOf([
        { name: 'No Dir Bot', working_directory: workDir },
        { name: 'own_dir_bot', claude_config_dir: otherDir },
      ])
      const noDir = cfg.personas[0]!
      expect(noDir.claude_config_dir).toBeUndefined()

      let lines: string[] = []
      expect(() => {
        lines = captureConsoleError(() => runEntry(entry, cfg))
      }).not.toThrow()

      expect(readdirSync(workDir)).toEqual([])
      expect(startupEntriesBesidesJq()).toEqual([])
      expect(lines.some((l) => l.includes(renderPersonaRef(noDir.name, noDir.key)))).toBe(true)
      expect(getLaunchedWithDir(noDir.key)).toBeUndefined()
      // The skip does not stop the other persona's dir at start.
      if (entry === 'start') expect(managedCommands(otherDir)).toEqual([canonical()])
    },
  )

  test.each(ENTRIES.flatMap((entry) => [[entry, 'empty', ''], [entry, 'whitespace-only', '   ']] as const))(
    '%s: a persona with an %s claude_config_dir is skipped; nothing written to cwd',
    (entry, _label, blank) => {
      // An empty temp cwd, so a resolve("") regression lands there, never in the repo.
      const cwdTemp = newTempDir()
      const cwdBefore = process.cwd()
      const cfg = personaConfigOf([{ name: 'blank_dir_bot', claude_config_dir: blank }])

      let lines: string[] = []
      process.chdir(cwdTemp)
      try {
        expect(() => {
          lines = captureConsoleError(() => runEntry(entry, cfg))
        }).not.toThrow()
      } finally {
        process.chdir(cwdBefore)
      }

      expect(readdirSync(cwdTemp)).toEqual([])
      expect(startupEntriesBesidesJq()).toEqual([])
      expect(lines.some((l) => l.includes(renderPersonaRef('blank_dir_bot')))).toBe(true)
    },
  )

  // -------------------------------------------------------------------------
  // Refusal of the operator's ~/.claude (subprocess, fake HOME)
  // -------------------------------------------------------------------------

  // node:os homedir() is snapshotted at launch on Bun, so the refusal runs in
  // a child whose HOME is a temp dir: a regression can only write the fake
  // ~/.claude. The child runs one start pass, then three launches of every
  // persona, as a server would; the refusal is recorded once per start.
  test.each([
    ['directly, two personas', 'direct', ['home_bot_a', 'home_bot_b']],
    ['through a symlink', 'symlink', ['home_link_bot']],
  ] as const)(
    "a dir resolving to ~/.claude (%s) is never written; one start plus several launches record refuse-home exactly once",
    (_label, via, names) => {
      const fakeHome = newTempDir()
      const personalClaude = join(fakeHome, '.claude')
      mkdirSync(personalClaude, { recursive: true })
      let configured = personalClaude
      if (via === 'symlink') {
        configured = join(newTempDir(), 'shared-claude-link')
        symlinkSync(personalClaude, configured)
      }
      const cfg = personaConfigOf(names.map((name) => ({ name })), { claude_config_dir: configured })

      const res = runInFakeHome({
        modulePath: STOP_HOOK_BOOTSTRAP_SRC,
        call: [
          'mod.stopHookBootstrap(input.cfg, input.stateDir);',
          'for (let i = 0; i < 3; i++) {',
          '  for (const p of input.cfg.personas) mod.preLaunchReplyGuard(p, input.cfg.personas, input.stateDir);',
          '}',
        ].join('\n'),
        input: { cfg, stateDir: rec.stateDir },
        home: fakeHome,
        stateDir: rec.stateDir,
      })

      // Control: the child saw the fake HOME and ran the launches.
      expect(res.observedHomedir).toBe(fakeHome)
      expect(res.status).toBe(0)
      for (const p of cfg.personas) expect(rec.readRecord(p.key)).toBe('true')

      expect(readdirSync(personalClaude)).toEqual([])
      const log = readFileSync(join(rec.stateDir, 'startup-errors.log'), 'utf-8')
      expect(log.match(/stop-hook-bootstrap-refuse-home/g)).toHaveLength(1)
      expect(log).toContain(`personas=${names.map((n) => renderPersonaRef(n)).join(', ')}`)
    },
  )

  // -------------------------------------------------------------------------
  // Undo of an optimistic launch that met a live instance (Epic decision 9)
  // -------------------------------------------------------------------------

  test("undo restores a running instance's record and launched-with dir, and the hook it keeps", () => {
    const oldDir = newTempDir()
    const newDir = newTempDir()
    const running = personaConfigOf([{ name: 'live_bot', claude_config_dir: oldDir }])
    launchNamed(running, 'live_bot')
    const key = personaNamed(running, 'live_bot').key
    // The operator moves live_bot and turns it off; a ladder's optimistic
    // spawn runs the steps, then meets the live instance.
    const changed = personaConfigOf([{ name: 'live_bot', claude_config_dir: newDir, stop_hook_bootstrap: false }])

    const undo = launchNamed(changed, 'live_bot')
    expect(rec.readRecord(key)).toBe('false')
    expect(getLaunchedWithDir(key)).toBe(newDir)
    expect(managedEntriesOf(readSettings(oldDir))).toEqual([])

    undo()

    expect(rec.readRecord(key)).toBe('true')
    expect(getLaunchedWithDir(key)).toBe(oldDir)
    expect(managedCommands(oldDir)).toEqual([canonical()])
    // The pass re-runs over the new dir too: the restored true record counts there.
    expect(managedCommands(newDir)).toEqual([canonical()])
  })

  test('undo of a first launch deletes the record it wrote and forgets the launched-with dir', () => {
    const dir = newTempDir()
    const cfg = personaConfigOf([{ name: 'first_bot', claude_config_dir: dir }])
    const key = cfg.personas[0]!.key

    launchNamed(cfg, 'first_bot')()

    expect(rec.readRecord(key)).toBeNull()
    expect(getLaunchedWithDir(key)).toBeUndefined()
  })

  // A running live_bot (record true, launched in oldDir) meets an optimistic
  // launch into newDir with the flag off; something changes before the undo.
  test.each([
    ['a teardown of the persona', (p: Persona): void => teardownPersonaReplyGuard(rec.stateDir, p.key), null, 'none'],
    ['another writer rewriting the record', (p: Persona): void => void rec.writeRecord(p.key, 'true\n'), 'true\n', 'old'],
    // Same dir, so only the entry's identity tells the two launches apart.
    ['a second launch of the persona', (p: Persona): void => void launch({ ...p, stop_hook_bootstrap: true }, [p]), 'true', 'new'],
  ] as const)('an undo after %s leaves that change in place', (_label, intervene, record, launchedWith) => {
    const oldDir = newTempDir()
    const newDir = newTempDir()
    const running = personaConfigOf([{ name: 'live_bot', claude_config_dir: oldDir }])
    launchNamed(running, 'live_bot')
    const changed = personaConfigOf([{ name: 'live_bot', claude_config_dir: newDir, stop_hook_bootstrap: false }])
    const persona = personaNamed(changed, 'live_bot')
    const undo = launch(persona, changed.personas)

    intervene(persona)
    undo()

    expect(rec.readRecord(persona.key)).toBe(record)
    expect(getLaunchedWithDir(persona.key)).toBe({ none: undefined, old: oldDir, new: newDir }[launchedWith])
  })

  // One persona (a_bot) launches for the first time into a dir; the applied
  // set changes before the undo, and the undo's pass follows the set as it is then.
  test.each([
    ['an enabled neighbour added', { aEnabled: false, bBefore: false, after: 'with b' }, false, true],
    ['the enabled neighbour removed', { aEnabled: false, bBefore: true, after: 'without b' }, true, false],
    ['no applied set any more (the pass is skipped)', { aEnabled: true, bBefore: false, after: 'none' }, true, true],
  ] as const)('the undo reads the applied set afresh: %s', (_label, row, hookedAfterStep, hookedAfterUndo) => {
    const dir = newTempDir()
    const cfg = personaConfigOf(
      [{ name: 'a_bot', stop_hook_bootstrap: row.aEnabled }, { name: 'b_bot' }],
      { claude_config_dir: dir },
    )
    const a = personaNamed(cfg, 'a_bot')
    const withB = cfg.personas
    const withoutB = [a]
    let applied: readonly Persona[] | undefined = row.bBefore ? withB : withoutB
    const hook = (): (string | undefined)[] => (existsSync(join(dir, 'settings.json')) ? managedCommands(dir) : [])
    const expected = (hooked: boolean): string[] => (hooked ? [canonical()] : [])

    const undo = preLaunchReplyGuard(a, () => applied, rec.stateDir)
    expect(hook()).toEqual(expected(hookedAfterStep))
    applied = { 'with b': withB, 'without b': withoutB, none: undefined }[row.after]
    undo()

    expect(hook()).toEqual(expected(hookedAfterUndo))
  })

  test('with no applied set (a getter returning undefined) the step writes no record, patches nothing, and its undo does nothing', () => {
    const dir = newTempDir()
    seedManagedEntry(dir)
    const cfg = personaConfigOf([{ name: 'unloaded_bot', claude_config_dir: dir }])
    const persona = cfg.personas[0]!
    rec.writeRecord(persona.key, 'false')
    const snapshot = (): unknown => [snapshotTree(dir), snapshotTree(rec.stateDir)]
    const before = snapshot()

    const undo = preLaunchReplyGuard(persona, () => undefined, rec.stateDir)
    expect(snapshot()).toEqual(before)
    expect(getLaunchedWithDir(persona.key)).toBeUndefined()

    undo()
    expect(snapshot()).toEqual(before)
    expect(getLaunchedWithDir(persona.key)).toBeUndefined()
  })

  // b.av2 SR-8.6: a late launch of a persona a confirmed apply removed (its
  // teardown deleted its record) must neither re-create the record nor run a
  // launch pass, which here would strip the managed hook from its dir since no
  // applied persona there has the flag on.
  test('for a persona outside the applied set the step writes no record, patches nothing, and its undo does nothing', () => {
    const dir = newTempDir()
    seedManagedEntry(dir)
    const cfg = personaConfigOf([
      { name: 'removed_bot', claude_config_dir: dir },
      { name: 'kept_bot', claude_config_dir: newTempDir() },
    ])
    const removed = personaNamed(cfg, 'removed_bot')
    const applied = [personaNamed(cfg, 'kept_bot')]
    const snapshot = (): unknown => [snapshotTree(dir), snapshotTree(rec.stateDir)]
    const before = snapshot()

    const undo = preLaunchReplyGuard(removed, () => applied, rec.stateDir)
    expect(snapshot()).toEqual(before)
    expect(rec.readRecord(removed.key)).toBeNull()
    expect(getLaunchedWithDir(removed.key)).toBeUndefined()

    undo()
    expect(snapshot()).toEqual(before)
    expect(getLaunchedWithDir(removed.key)).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Record write failure (no permission bits: works as root too)
  // -------------------------------------------------------------------------

  test.each([
    ['a regular file where reply-guard/ should be', (_key: string) => writeFileSync(rec.recordDir, 'not a dir', 'utf-8')],
    ['a directory where the .tmp file should be, over a stale true record', (key: string) => {
      rec.writeRecord(key, 'true')
      mkdirSync(join(rec.recordDir, `${key}.tmp`))
    }],
  ] as const)('an unwritable record (%s) does not throw into the launch, leaves no record, and is logged', (_label, block) => {
    const dir = newTempDir()
    seedManagedEntry(dir)
    const cfg = personaConfigOf([{ name: 'Blocked Bot', claude_config_dir: dir, stop_hook_bootstrap: false }])
    const persona = cfg.personas[0]!
    block(persona.key)

    let undo: unknown
    let lines: string[] = []
    expect(() => {
      lines = captureConsoleError(() => {
        undo = launch(persona, cfg.personas)
      })
    }).not.toThrow()

    expect(typeof undo).toBe('function')
    expect(readReplyGuardRecord(rec.stateDir, persona.key)).toBe('absent')
    const ref = renderPersonaRef(persona.name, persona.key)
    expect(lines.some((l) => l.includes(ref) && l.includes(rec.recordPath(persona.key)))).toBe(true)
    expect(readStartupLog()).toBe('')
    // The launch pass still ran: with no true record the stale entry is removed.
    expect(stopGroupsOf(readSettings(dir))).toEqual([])
    expect(getLaunchedWithDir(persona.key)).toBe(dir)
  })

  test('the undo of a launch whose record write failed does not bring the old record back', () => {
    const cfg = personaConfigOf([{ name: 'blocked_bot', claude_config_dir: newTempDir(), stop_hook_bootstrap: false }])
    const persona = cfg.personas[0]!
    rec.writeRecord(persona.key, 'true')
    const blocker = join(rec.recordDir, `${persona.key}.tmp`)
    mkdirSync(blocker)
    let undo = (): void => {}
    captureConsoleError(() => {
      undo = launch(persona, cfg.personas)
    })
    expect(rec.readRecord(persona.key)).toBeNull()
    // The obstacle clears, so a restore attempted now would succeed.
    rmSync(blocker, { recursive: true })

    undo()

    expect(rec.readRecord(persona.key)).toBeNull()
  })

  test('an undo that cannot restore the record logs the persona and path, keeps the record, and does not throw', () => {
    const cfg = personaConfigOf([{ name: 'Stuck Bot', claude_config_dir: newTempDir(), stop_hook_bootstrap: false }])
    const persona = cfg.personas[0]!
    rec.writeRecord(persona.key, 'true')
    const undo = launch(persona, cfg.personas)
    mkdirSync(join(rec.recordDir, `${persona.key}.tmp`))

    let lines: string[] = []
    expect(() => {
      lines = captureConsoleError(undo)
    }).not.toThrow()

    expect(rec.readRecord(persona.key)).toBe('false')
    const ref = renderPersonaRef(persona.name, persona.key)
    expect(lines.filter((l) => l.includes(ref) && l.includes(rec.recordPath(persona.key)))).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Teardown helper (b.av2 SR-6.5)
  // -------------------------------------------------------------------------

  test.each([
    ['the record present', 'present'],
    ['the record missing', 'missing'],
    ['reply-guard/ missing', 'no-dir'],
  ] as const)('teardown with %s deletes only that record, forgets launched-with, and never throws', (_label, state) => {
    const dir = newTempDir()
    const cfg = personaConfigOf([{ name: 'gone_bot', claude_config_dir: dir }, { name: 'kept_bot' }])
    const gone = personaNamed(cfg, 'gone_bot')
    const kept = personaNamed(cfg, 'kept_bot')
    launch(gone, cfg.personas)
    if (state === 'missing') rec.removeRecord(gone.key)
    if (state === 'no-dir') rec.removeRecordDir()
    else rec.writeRecord(kept.key, 'true')

    let lines: string[] = []
    expect(() => {
      lines = captureConsoleError(() => teardownPersonaReplyGuard(rec.stateDir, gone.key))
    }).not.toThrow()

    expect(lines).toEqual([])
    expect(rec.readRecord(gone.key)).toBeNull()
    expect(getLaunchedWithDir(gone.key)).toBeUndefined()
    if (state === 'no-dir') expect(existsSync(rec.recordDir)).toBe(false)
    else expect(rec.readRecord(kept.key)).toBe('true')
  })

  test('teardown that cannot delete the record logs the key and path and does not throw', () => {
    const key = 'stuck_bot'
    mkdirSync(join(rec.recordDir, key), { recursive: true })

    let lines: string[] = []
    expect(() => {
      lines = captureConsoleError(() => teardownPersonaReplyGuard(rec.stateDir, key))
    }).not.toThrow()

    expect(lines.some((l) => l.includes(`"${key}"`) && l.includes(rec.recordPath(key)))).toBe(true)
    expect(existsSync(join(rec.recordDir, key))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Record helpers
  // -------------------------------------------------------------------------

  test.each([
    ['true', 'true'],
    ['true\n', 'true'],
    ['false', 'other'],
    ['TRUE', 'other'],
    [' true', 'other'],
    ['true\n\n', 'other'],
    ['', 'other'],
    [null, 'absent'],
  ] as const)('the record read of %p is %p', (content, expected) => {
    const key = 'read_bot'
    if (content !== null) rec.writeRecord(key, content)

    expect(readReplyGuardRecord(rec.stateDir, key)).toBe(expected)
    expect(readReplyGuardRecordText(rec.stateDir, key)).toBe(content ?? undefined)
  })

  test.each(['a', 'bot_1', 'x'.repeat(49)])('the record helpers accept the key %p', (key) => {
    writeReplyGuardRecord(rec.stateDir, key, true)
    expect(readdirSync(rec.recordDir)).toEqual([key])
    expect(readReplyGuardRecord(rec.stateDir, key)).toBe('true')
    deleteReplyGuardRecord(rec.stateDir, key)
    expect(readReplyGuardRecord(rec.stateDir, key)).toBe('absent')
  })

  // Where the key names a file, that file is seeded with `true` first, so a
  // helper that skipped the check would read it, overwrite it or delete it.
  test.each([
    'a/b',
    '..',
    '../escape',
    'Upper',
    'has-dash',
    'has space',
    'bot.name',
    '',
    'x'.repeat(50),
  ])('every record helper rejects the key %p and touches nothing on disk', (key) => {
    const target = join(rec.recordDir, key)
    if (key !== '' && key !== '..') {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, 'true', 'utf-8')
    }
    rec.writeRecord('neighbour', 'true')
    const before = snapshotTree(rec.stateDir)

    expect(() => replyGuardRecordPath(rec.stateDir, key)).toThrow()
    expect(() => writeReplyGuardRecord(rec.stateDir, key, false)).toThrow()
    expect(readReplyGuardRecord(rec.stateDir, key)).toBe('absent')
    expect(readReplyGuardRecordText(rec.stateDir, key)).toBeUndefined()
    expect(() => deleteReplyGuardRecord(rec.stateDir, key)).toThrow()
    captureConsoleError(() => {
      expect(() => teardownPersonaReplyGuard(rec.stateDir, key)).not.toThrow()
    })

    expect(snapshotTree(rec.stateDir)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// AC 59: next-launch values through a confirmed reload (b.av2 SR-8.6
// `stop_hook_bootstrap` and `claude_config_dir` rows, SR-9.4, SR-6.2)
//
// Every case runs a server through `makeReloadHarness` with the real launch
// path (`realLaunch`: `spawnForPersona` with the reply-guard steps over the
// harness's temp state directory), confirms a change with the operator's
// gesture, then drives each persona's next launch through the restart path
// (`run.relaunch`, its row seeded `ended` so the ladder resumes or spawns
// afresh, which is when the reply-guard steps run). Every persona has its own
// temp `claude_config_dir` (or a shared temp one); none resolves to ~/.claude,
// and the start-time Stop-hook bootstrap is not run, so every managed entry
// and record here was written by a launch. E10's direct-launch, install-matrix,
// quoting and refusal cases are above and not repeated.
// ---------------------------------------------------------------------------

describe('AC 59: a confirmed stop_hook_bootstrap or claude_config_dir change reaches the record and the hook only at the next launch', () => {
  let h: ReloadHarness
  let savedStateDirEnv: string | undefined

  beforeEach(() => {
    h = makeReloadHarness({ personaConfigDirs: true })
    // Nothing here is a startup launch, but a recordStartupError write would
    // still land in a temp dir, never under HOME.
    savedStateDirEnv = process.env['SLACK_STATE_DIR']
    process.env['SLACK_STATE_DIR'] = h.stateDir
  })

  afterEach(async () => {
    try {
      await h.cleanup()
    } finally {
      if (savedStateDirEnv === undefined) delete process.env['SLACK_STATE_DIR']
      else process.env['SLACK_STATE_DIR'] = savedStateDirEnv
    }
  })

  /** The managed commands in `<dir>/settings.json`; none when the file does not exist. */
  function hookIn(dir: string): (string | undefined)[] {
    return existsSync(join(dir, 'settings.json')) ? managedCommands(dir) : []
  }

  /** The one managed command, from the module's resolver over the harness's state directory. */
  function installed(): string[] {
    return [managedHookCommand(h.stateDir)]
  }

  type TopLevel = { stop_hook_bootstrap?: boolean; claude_config_dir?: string }

  /**
   * A server running `personas` from a byte-equal record and config file
   * (with the top-level settings `top`), detection started and its first
   * check run; every start launch is a fresh spawn through the real path.
   */
  async function running(personas: PersonaInput[], top: TopLevel = {}): Promise<ReloadRun> {
    h.materialize(...personas)
    h.writeRecord({ ...top, personas })
    h.writeConfig({ ...top, personas })
    const run = await h.startDetecting({ realLaunch: true })
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(false)
    for (const p of personas) expect(h.rowOf(p.name)?.state).toBe('waiting')
    return run
  }

  /**
   * Confirm `personas` (with `top`) as the new configuration and await the
   * apply. Returns the apply's lifecycle records as `<op> <name>` (`<op>`
   * alone for step 5's template refresh).
   */
  async function apply(run: ReloadRun, personas: PersonaInput[], top: TopLevel = {}): Promise<string[]> {
    h.writeConfig({ ...top, personas })
    const cp = run.checkpoint()
    await (await run.confirmPending()).applying
    expect(h.readRecord()).toEqual(h.readConfig()!)
    const nameOf = new Map(personas.map((p) => [h.key(p.name), p.name]))
    return run.since(cp).lifecycle.map((r) => (r.key === TEMPLATE_REFRESH_KEY ? r.op : `${r.op} ${nameOf.get(r.key) ?? r.key}`))
  }

  /** The persona's next launch: its instance has ended, and the restart path launches it again. */
  async function nextLaunch(run: ReloadRun, persona: PersonaInput): Promise<void> {
    h.seedRow(persona, { state: 'ended' })
    expect(await run.relaunch(persona.name)).toBe(true)
  }

  /** The persona's spawns and resumes that succeeded (an optimistic spawn that met the row is not one), as `<verb> <CLAUDE_CONFIG_DIR>`. */
  function launchesOf(run: ReloadRun, persona: PersonaInput): string[] {
    return run
      .composition!.instanceCallsOf(persona.name)
      .filter((c) => (c.verb === 'spawn' || c.verb === 'resume') && c.result === 'ok')
      .map((c) => (c.verb === 'spawn' ? `spawn ${c.claudeConfigDir}` : 'resume'))
  }

  /** Every persona's instance calls, to show an apply made none. */
  function instanceCalls(run: ReloadRun, personas: PersonaInput[]): Record<string, string[]> {
    return Object.fromEntries(
      personas.map((p) => [p.name, run.composition!.instanceCallsOf(p.name).map((c) => c.verb)]),
    )
  }

  /** Closing checks: nothing posted, and no token in the logs, records, settings files or anything else captured. */
  function expectNoPostNoLeak(run: ReloadRun, dirs: string[]): void {
    expect(run.slackPosts()).toEqual([])
    assertNoLeak(
      run.captured({
        records: writtenFile(h.replyGuardDir),
        settings: dirs.map((d) => writtenFile(d)),
        sessionNotices: run.sessionNotices,
      }),
    )
  }

  test('AC 59 own value true → false: the apply leaves the true record and the hook; the next launch writes false and removes the hook', async () => {
    const d = h.configDir('d')
    const a = h.persona('Hook A', { claude_config_dir: d })
    const run = await running([a])
    expect(h.readReplyGuardRecord(a.name)).toBe('true')
    expect(hookIn(d)).toEqual(installed())
    const before = instanceCalls(run, [a])

    // The apply itself neither tore down nor launched A, nor rewrote its record or the hook.
    expect(await apply(run, [{ ...a, stop_hook_bootstrap: false }])).toEqual([])
    expect(instanceCalls(run, [a])).toEqual(before)
    expect(h.readReplyGuardRecord(a.name)).toBe('true')
    expect(hookIn(d)).toEqual(installed())

    await nextLaunch(run, a)

    expect(launchesOf(run, a)).toEqual([`spawn ${d}`, 'resume'])
    expect(h.readReplyGuardRecord(a.name)).toBe('false')
    expect(hookIn(d)).toEqual([])
    expectNoPostNoLeak(run, [d])
  })

  // A runs in D with true, and its value is confirmed as false; B (false)
  // launches into D before A relaunches: added by the same apply (its apply
  // bring-up launches it), or already running and restarted after the apply.
  test.each(['added in the same apply', 'restarted after the apply'] as const)(
    "AC 59 a neighbour's launch into the same dir (%s) leaves A's true record and the hook; A's own next launch then removes it",
    async (how) => {
      const d = h.configDir('shared')
      const a = h.persona('Hook A', { claude_config_dir: d })
      const b = h.persona('Hook B', { claude_config_dir: d, stop_hook_bootstrap: false })
      const aOff = { ...a, stop_hook_bootstrap: false }
      let run: ReloadRun
      if (how === 'added in the same apply') {
        run = await running([a])
        h.materialize(b)
        expect(await apply(run, [aOff, b])).toEqual([`bring-up ${b.name}`, `launch ${b.name}`])
        expect(launchesOf(run, b)).toEqual([`spawn ${d}`])
      } else {
        run = await running([a, b])
        expect(await apply(run, [aOff, b])).toEqual([])
        await nextLaunch(run, b)
        expect(launchesOf(run, b)).toEqual([`spawn ${d}`, 'resume'])
      }
      expect(launchesOf(run, a)).toEqual([`spawn ${d}`])

      expect(h.readReplyGuardRecord(b.name)).toBe('false')
      expect(h.readReplyGuardRecord(a.name)).toBe('true')
      expect(hookIn(d)).toEqual(installed())

      // A's own next launch writes false; no one in D needs the hook now.
      await nextLaunch(run, aOff)
      expect(h.readReplyGuardRecord(a.name)).toBe('false')
      expect(hookIn(d)).toEqual([])
      expectNoPostNoLeak(run, [d])
    },
  )

  // A and B inherit the top-level value, which the apply flips; C overrides
  // it with the old value, so C's record would change only if C wrongly
  // followed the new default. Each has its own dir.
  test.each([
    [true, false],
    [false, true],
  ] as const)(
    'AC 59 inherited default %p → %p: the apply changes no record; each inheriting persona\'s record changes only at its own next launch; the overriding one never changes',
    async (was, now) => {
      const a = h.persona('Inherit A')
      const b = h.persona('Inherit B')
      const c = h.persona('Override C', { stop_hook_bootstrap: was })
      const personas = [a, b, c]
      const run = await running(personas, { stop_hook_bootstrap: was })
      const records = () => personas.map((p) => h.readReplyGuardRecord(p.name))
      const old = String(was)
      const fresh = String(now)
      expect(records()).toEqual([old, old, old])
      const before = instanceCalls(run, personas)

      expect(await apply(run, personas, { stop_hook_bootstrap: now })).toEqual([])
      expect(instanceCalls(run, personas)).toEqual(before)
      expect(records()).toEqual([old, old, old])

      await nextLaunch(run, b)
      expect(records()).toEqual([old, fresh, old])

      await nextLaunch(run, c)
      expect(records()).toEqual([old, fresh, old])

      await nextLaunch(run, a)
      expect(records()).toEqual([fresh, fresh, old])
      // Each dir's hook follows its own persona's record.
      expect(personas.map((p) => hookIn(p.claude_config_dir!))).toEqual([
        now ? installed() : [],
        now ? installed() : [],
        was ? installed() : [],
      ])
      expectNoPostNoLeak(run, personas.map((p) => p.claude_config_dir!))
    },
  )

  // A (true) moves from D1 to D2, as its own value or as the inherited
  // top-level one. M, which stays in D1, relaunches after the apply and
  // before A: D1's hook then stays only because A's running instance
  // launched with D1 and has a true record. After A's next launch D1 keeps
  // the hook only if M needs it.
  test.each(
    (['own', 'inherited'] as const).flatMap((source) =>
      ([false, true] as const).map((neighbourOn) => [source, neighbourOn] as const),
    ),
  )(
    'AC 59 claude_config_dir moved D1 → D2 (%s value; D1 neighbour stop_hook_bootstrap=%p): D1 keeps the hook until A relaunches; then D2 has it and A\'s record, and D1 keeps it only for the neighbour',
    async (source, neighbourOn) => {
      const d1 = h.configDir('d1')
      const d2 = h.configDir('d2')
      const dirOf = (dir: string): Partial<PersonaInput> =>
        source === 'own' ? { claude_config_dir: dir } : { claude_config_dir: undefined }
      const topOf = (dir: string): TopLevel => (source === 'own' ? {} : { claude_config_dir: dir })
      const a = h.persona('Mover A', dirOf(d1))
      const m = h.persona('Stayer M', { claude_config_dir: d1, stop_hook_bootstrap: neighbourOn })
      const run = await running([a, m], topOf(d1))
      expect(hookIn(d1)).toEqual(installed())
      expect(existsSync(join(d2, 'settings.json'))).toBe(false)
      const before = instanceCalls(run, [a, m])

      const aMoved = { ...a, ...dirOf(d2) }
      // Step 5 refreshes the template (the config dirs changed); nothing else runs.
      expect(await apply(run, [aMoved, m], topOf(d2))).toEqual(['template-refresh'])
      expect(instanceCalls(run, [a, m])).toEqual(before)
      expect(hookIn(d1)).toEqual(installed())
      expect(hookIn(d2)).toEqual([])

      // M's launch re-evaluates D1 over the applied set, in which A now names D2.
      await nextLaunch(run, m)
      expect(h.readReplyGuardRecord(m.name)).toBe(String(neighbourOn))
      expect(h.readReplyGuardRecord(a.name)).toBe('true')
      expect(hookIn(d1)).toEqual(installed())
      expect(hookIn(d2)).toEqual([])

      // A's next launch: a fresh spawn with D2 (the row's config_dir label is D1's).
      await nextLaunch(run, aMoved)
      expect(launchesOf(run, a)).toEqual([`spawn ${d1}`, `spawn ${d2}`])
      expect(h.readReplyGuardRecord(a.name)).toBe('true')
      expect(hookIn(d2)).toEqual(installed())
      expect(hookIn(d1)).toEqual(neighbourOn ? installed() : [])
      expectNoPostNoLeak(run, [d1, d2])
    },
  )
})
