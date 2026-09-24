/**
 * trust-bootstrap.test.ts — Unit tests for src/trust-bootstrap.ts (b.av2 SR-6.2).
 *
 * Covers both entry points over personas:
 *   - trustBootstrap(personaConfig): the start pass over every applied persona;
 *     failures are recorded in startup-errors.log.
 *   - trustPatchPersona(persona): the per-launch patch; failures are logged
 *     only, never recorded.
 *
 * Uses real file I/O. Every `.claude.json` lives in a mkdtempSync directory
 * removed in afterEach, and SLACK_STATE_DIR is redirected to a temp dir in
 * beforeEach so recordStartupError writes land in a log the test reads
 * (b.av2 SR-13.2). Cases for a persona with no configured claude_config_dir
 * run in a subprocess with a fake HOME (tests/test-helpers/fake-home-subprocess.ts),
 * so a regression that falls back to the default dir can only touch that fake
 * home.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PersonaConfig } from '../src/config.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { trustBootstrap, trustPatchPersona } from '../src/trust-bootstrap.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './test-helpers/persona-config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Projects = Record<string, Record<string, unknown>>

let tempDirs: string[] = []
let savedEnv: typeof process.env
/** Base dir for persona fixture paths; fresh per test. */
let baseDir: string
/** Where recordStartupError writes during this test. */
let logPath: string

function newTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'trust-bootstrap-test-'))
  tempDirs.push(d)
  return d
}

function claudeJsonPath(dir: string): string {
  return join(dir, '.claude.json')
}

function writeClaudeJson(dir: string, data: object): void {
  writeFileSync(claudeJsonPath(dir), JSON.stringify(data, null, 2), 'utf-8')
}

function projectsOf(dir: string): Projects {
  const doc = JSON.parse(readFileSync(claudeJsonPath(dir), 'utf-8')) as { projects?: Projects }
  return doc.projects ?? {}
}

function expectPatched(dir: string, cwd: string): void {
  const entry = projectsOf(dir)[cwd]
  expect(entry?.hasTrustDialogAccepted).toBe(true)
  expect(entry?.hasCompletedProjectOnboarding).toBe(true)
}

function readStartupErrors(): string {
  return existsSync(logPath) ? readFileSync(logPath, 'utf-8') : ''
}

/** Personas under this test's baseDir; names with spaces so key differs from name. */
function personas(specs: PersonaSpec[], overrides: Partial<Omit<PersonaConfig, 'personas'>> = {}): PersonaConfig {
  return makeMultiPersonaConfig(specs, baseDir, overrides)
}

/** One persona whose effective config dir is `dir`. */
function onePersona(dir: string, name = 'Solo Bot'): PersonaConfig {
  return personas([{ name, claude_config_dir: dir }])
}

beforeEach(() => {
  savedEnv = { ...process.env }
  baseDir = newTempDir()
  const logDir = newTempDir()
  process.env['SLACK_STATE_DIR'] = logDir
  logPath = join(logDir, 'startup-errors.log')
})

afterEach(() => {
  process.env = savedEnv as NodeJS.ProcessEnv
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tempDirs = []
})

// ---------------------------------------------------------------------------
// Start pass
// ---------------------------------------------------------------------------

describe('trustBootstrap (start pass over personas)', () => {
  test('missing project entry is created with both flags true; other entries preserved', async () => {
    const dir = newTempDir()
    writeClaudeJson(dir, { projects: { '/other/cwd': { hasTrustDialogAccepted: true } } })
    const cfg = onePersona(dir)
    const cwd = cfg.personas[0]!.working_directory

    await trustBootstrap(cfg)

    expectPatched(dir, cwd)
    expect(projectsOf(dir)['/other/cwd']).toEqual({ hasTrustDialogAccepted: true })
  })

  test('existing false flags are flipped to true; unrelated keys survive', async () => {
    const dir = newTempDir()
    const cfg = onePersona(dir)
    const cwd = cfg.personas[0]!.working_directory
    writeClaudeJson(dir, {
      projects: { [cwd]: { hasTrustDialogAccepted: false, hasCompletedProjectOnboarding: false, someOtherKey: 'preserved' } },
    })

    await trustBootstrap(cfg)

    expectPatched(dir, cwd)
    expect(projectsOf(dir)[cwd]!.someOtherKey).toBe('preserved')
  })

  test('file is not rewritten when both flags are already true (mtime unchanged)', async () => {
    const dir = newTempDir()
    const cfg = onePersona(dir)
    const cwd = cfg.personas[0]!.working_directory
    writeClaudeJson(dir, { projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } })
    const mtimeBefore = statSync(claudeJsonPath(dir)).mtimeMs

    await trustBootstrap(cfg)

    expect(statSync(claudeJsonPath(dir)).mtimeMs).toBe(mtimeBefore)
  })

  test('missing .claude.json records trust-bootstrap-config-missing naming the persona key, no throw, file not created', async () => {
    const dir = newTempDir()
    const cfg = onePersona(dir)
    const { key } = cfg.personas[0]!

    await expect(trustBootstrap(cfg)).resolves.toBeUndefined()

    expect(existsSync(claudeJsonPath(dir))).toBe(false)
    const log = readStartupErrors()
    expect(log).toContain('[trust-bootstrap-config-missing]')
    expect(log).toContain(key)
    expect(log).toContain(claudeJsonPath(dir))
  })

  test('malformed JSON records trust-bootstrap-config-parse naming the persona key, no throw', async () => {
    const dir = newTempDir()
    writeFileSync(claudeJsonPath(dir), '{ not valid json }', 'utf-8')
    const cfg = onePersona(dir)
    const { key } = cfg.personas[0]!

    await expect(trustBootstrap(cfg)).resolves.toBeUndefined()

    const log = readStartupErrors()
    expect(log).toContain('[trust-bootstrap-config-parse]')
    expect(log).toContain(key)
  })

  test('a per-persona claude_config_dir wins over the top-level one; a persona without one inherits it', async () => {
    const topDir = newTempDir()
    const ownDir = newTempDir()
    writeClaudeJson(topDir, { projects: {} })
    writeClaudeJson(ownDir, { projects: {} })
    const cfg = personas(
      [{ name: 'Inherits Bot' }, { name: 'Override Bot', claude_config_dir: ownDir }],
      { claude_config_dir: topDir },
    )
    const [inherits, override] = cfg.personas

    await trustBootstrap(cfg)

    expectPatched(topDir, inherits!.working_directory)
    expect(projectsOf(topDir)[override!.working_directory]).toBeUndefined()
    expectPatched(ownDir, override!.working_directory)
    expect(projectsOf(ownDir)[inherits!.working_directory]).toBeUndefined()
  })

  test('iterates every persona: two sharing one dir both patched there, a third patched in its own file, a malformed file first does not stop them', async () => {
    const badDir = newTempDir()
    const sharedDir = newTempDir()
    const otherDir = newTempDir()
    writeFileSync(claudeJsonPath(badDir), '{ not valid json }', 'utf-8')
    writeClaudeJson(sharedDir, { projects: {} })
    writeClaudeJson(otherDir, { projects: {} })
    const cfg = personas([
      { name: 'Broken Bot', claude_config_dir: badDir },
      { name: 'Shared One', claude_config_dir: sharedDir },
      { name: 'Shared Two', claude_config_dir: sharedDir },
      { name: 'Other Bot', claude_config_dir: otherDir },
    ])
    const [broken, one, two, other] = cfg.personas

    await expect(trustBootstrap(cfg)).resolves.toBeUndefined()

    expectPatched(sharedDir, one!.working_directory)
    expectPatched(sharedDir, two!.working_directory)
    expect(Object.keys(projectsOf(sharedDir)).sort()).toEqual([one!.working_directory, two!.working_directory].sort())
    expect(Object.keys(projectsOf(otherDir))).toEqual([other!.working_directory])
    const log = readStartupErrors()
    expect(log).toContain('[trust-bootstrap-config-parse]')
    expect(log).toContain(broken!.key)
  })
})

// ---------------------------------------------------------------------------
// Per-launch patch
// ---------------------------------------------------------------------------

describe('trustPatchPersona (per-launch patch)', () => {
  /** Call the per-launch patch; it must not throw and must never record a startup error. */
  function launchPatch(cfg: PersonaConfig, index = 0): void {
    expect(() => trustPatchPersona(cfg.personas[index]!)).not.toThrow()
    expect(readStartupErrors()).toBe('')
  }

  test('patches exactly that persona\'s working directory in its effective dir, and a second call is idempotent', () => {
    const topDir = newTempDir()
    const ownDir = newTempDir()
    writeClaudeJson(topDir, { projects: {} })
    writeClaudeJson(ownDir, { projects: {} })
    const cfg = personas(
      [{ name: 'Launching Bot', claude_config_dir: ownDir }, { name: 'Idle Bot' }],
      { claude_config_dir: topDir },
    )
    const topBefore = readFileSync(claudeJsonPath(topDir), 'utf-8')

    launchPatch(cfg, 0)

    expect(Object.keys(projectsOf(ownDir))).toEqual([cfg.personas[0]!.working_directory])
    expectPatched(ownDir, cfg.personas[0]!.working_directory)
    // The other persona's dir is untouched.
    expect(readFileSync(claudeJsonPath(topDir), 'utf-8')).toBe(topBefore)

    const mtimeAfterFirst = statSync(claudeJsonPath(ownDir)).mtimeMs
    launchPatch(cfg, 0)
    expect(statSync(claudeJsonPath(ownDir)).mtimeMs).toBe(mtimeAfterFirst)
  })

  test('two personas sharing one dir, patched one after the other, both end up patched in the shared file', () => {
    const sharedDir = newTempDir()
    writeClaudeJson(sharedDir, { projects: {} })
    const cfg = personas(
      [{ name: 'First Bot' }, { name: 'Second Bot' }],
      { claude_config_dir: sharedDir },
    )

    launchPatch(cfg, 0)
    launchPatch(cfg, 1)

    expectPatched(sharedDir, cfg.personas[0]!.working_directory)
    expectPatched(sharedDir, cfg.personas[1]!.working_directory)
  })

  test.each([
    ['missing', undefined, 'trust-bootstrap-config-missing'],
    ['malformed', '{ not valid json }', 'trust-bootstrap-config-parse'],
  ] as const)('%s .claude.json: no throw, no startup error recorded, failure logged with the persona key', (_label, content, errorClass) => {
    const dir = newTempDir()
    if (content !== undefined) writeFileSync(claudeJsonPath(dir), content, 'utf-8')
    const cfg = onePersona(dir, 'Failing Bot')
    const lines: string[] = []
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    try {
      launchPatch(cfg)
    } finally {
      spy.mockRestore()
    }

    expect(existsSync(logPath)).toBe(false)
    // The file is left as it was: not created when missing, not rewritten when malformed.
    if (content === undefined) expect(existsSync(claudeJsonPath(dir))).toBe(false)
    else expect(readFileSync(claudeJsonPath(dir), 'utf-8')).toBe(content)
    const failure = lines.find((l) => l.includes(errorClass))
    expect(failure).toBeDefined()
    expect(failure).toContain(cfg.personas[0]!.key)
  })
})

// ---------------------------------------------------------------------------
// No configured claude_config_dir — fake-HOME subprocess
// ---------------------------------------------------------------------------

const TRUST_BOOTSTRAP_SRC = fileURLToPath(new URL('../src/trust-bootstrap.ts', import.meta.url))

/** Call either entry point in the child, per `input.entry`. */
const TRUST_ENTRY_CALL = `
  if (input.entry === 'start') await mod.trustBootstrap(input.cfg);
  else mod.trustPatchPersona(input.cfg.personas[0]);
`

describe('persona with no configured claude_config_dir (fake HOME)', () => {
  test.each([['start', 'trustBootstrap'], ['launch', 'trustPatchPersona']] as const)(
    '%s entry (%s) skips it: nothing written under the fake home, no startup error, skip line names the persona',
    (entry) => {
      const fakeHome = newTempDir()
      const stateDir = newTempDir()
      // Seed both default locations Claude could use, so a fallback to the
      // default dir would show up as a rewrite rather than a silent miss.
      const seeded = JSON.stringify({ projects: {} })
      mkdirSync(join(fakeHome, '.claude'))
      writeFileSync(join(fakeHome, '.claude', '.claude.json'), seeded, 'utf-8')
      writeFileSync(join(fakeHome, '.claude.json'), seeded, 'utf-8')
      // No persona-level and no top-level claude_config_dir.
      const cfg = personas([{ name: 'No Dir Bot' }])
      expect(cfg.personas[0]!.claude_config_dir).toBeUndefined()

      const res = runInFakeHome({
        modulePath: TRUST_BOOTSTRAP_SRC,
        call: TRUST_ENTRY_CALL,
        input: { entry, cfg },
        home: fakeHome,
        stateDir,
      })

      // Control: the child really ran under the fake HOME.
      expect(res.observedHomedir).toBe(fakeHome)
      expect(res.status).toBe(0)
      // `.bun` is the child Bun runtime's own cache dir, not the code under test.
      expect(readdirSync(fakeHome).filter((e) => e !== '.bun').sort()).toEqual(['.claude', '.claude.json'])
      expect(readdirSync(join(fakeHome, '.claude'))).toEqual(['.claude.json'])
      expect(readFileSync(join(fakeHome, '.claude', '.claude.json'), 'utf-8')).toBe(seeded)
      expect(readFileSync(join(fakeHome, '.claude.json'), 'utf-8')).toBe(seeded)
      expect(existsSync(join(stateDir, 'startup-errors.log'))).toBe(false)
      const ref = renderPersonaRef(cfg.personas[0]!.name, cfg.personas[0]!.key)
      expect(res.stderr).toContain(`${ref} has no claude_config_dir`)
    },
  )
})
