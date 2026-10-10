import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  loadPersonaConfig,
  parsePersonaConfigBytes,
  resolveDefaultCronTablePath,
  resolvePersonaConfig,
  resolveServerConfigPath,
  type PersonaConfigInput,
} from '../src/config.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { makePersonaConfigInput, writeConfigFile } from './test-helpers/persona-config.ts'

/** config.ts by absolute path, for the fake-home child. */
const CONFIG_MODULE = join(import.meta.dir, '..', 'src', 'config.ts')

// ---------------------------------------------------------------------------
// Helpers
//
// Every case works in its own mkdtempSync config directory and loads with an
// injected mkdtempSync home (b.av2 SR-13.2); both are removed after each case.
// ---------------------------------------------------------------------------

let dir: string
let home: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'config-cron-test-'))
  home = mkdtempSync(join(tmpdir(), 'config-cron-home-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

// Minimal valid input (one persona under the case's dir); add cron keys via
// overrides in individual tests.
function makeInput(overrides: Record<string, unknown> = {}): PersonaConfigInput {
  return { ...makePersonaConfigInput({}, dir), ...overrides }
}

// Writes the input as <dir>/config.json and loads it through the persona loader.
function load(input: unknown) {
  return loadPersonaConfig(writeConfigFile(dir, input), home)
}

// ---------------------------------------------------------------------------
// Acceptance of valid values
// ---------------------------------------------------------------------------

describe('cron config keys — acceptance', () => {
  test('the loader carries an absolute cron_table_path', () => {
    const result = load(makeInput({ cron_table_path: '/etc/cron/table' }))
    expect(result.cron_table_path).toBe('/etc/cron/table')
  })

  test('the loader carries an absolute cron_log_path', () => {
    const result = load(makeInput({ cron_log_path: '/var/log/cron.log' }))
    expect(result.cron_log_path).toBe('/var/log/cron.log')
  })

  test('the loader carries a valid cron_log_max_bytes', () => {
    const result = load(makeInput({ cron_log_max_bytes: 1_048_576 }))
    expect(result.cron_log_max_bytes).toBe(1_048_576)
  })

  test('cron_log_max_bytes of 1 (lower bound) is accepted', () => {
    const result = load(makeInput({ cron_log_max_bytes: 1 }))
    expect(result.cron_log_max_bytes).toBe(1)
  })

  test('loadPersonaConfig round-trips all three keys', () => {
    const result = load(
      makeInput({
        cron_table_path: '/etc/cron/table',
        cron_log_path: '/var/log/cron.log',
        cron_log_max_bytes: 4096,
      }),
    )
    expect(result.cron_table_path).toBe('/etc/cron/table')
    expect(result.cron_log_path).toBe('/var/log/cron.log')
    expect(result.cron_log_max_bytes).toBe(4096)
  })
})

// ---------------------------------------------------------------------------
// Rejection of invalid values (through loadPersonaConfig; match on substring)
// ---------------------------------------------------------------------------

describe('cron config keys — path rejection', () => {
  test.each([
    ['', 'empty string'],
    ['   ', 'whitespace-only'],
    [42, 'non-string'],
  ])('rejects cron_table_path %p (%s)', (value) => {
    expect(() => load(makeInput({ cron_table_path: value }))).toThrow(
      'cron_table_path must be a non-empty string.',
    )
  })

  test.each([
    ['', 'empty string'],
    ['   ', 'whitespace-only'],
    [42, 'non-string'],
  ])('rejects cron_log_path %p (%s)', (value) => {
    expect(() => load(makeInput({ cron_log_path: value }))).toThrow(
      'cron_log_path must be a non-empty string.',
    )
  })
})

describe('cron config keys — cron_log_max_bytes rejection', () => {
  test.each([
    [0, 'zero'],
    [-1, 'negative'],
    [1.5, 'non-integer'],
    ['1000', 'non-numeric'],
  ])('rejects cron_log_max_bytes %p (%s)', (value) => {
    expect(() => load(makeInput({ cron_log_max_bytes: value }))).toThrow(
      'cron_log_max_bytes must be a positive integer (>= 1) when set.',
    )
  })

  // The persona loader never echoes a rejected value (b.av2 SR-10.3); the
  // route loader's message ended "got <value>.".
  test('rejection message does not embed the offending JSON value', () => {
    let message = ''
    try {
      load(makeInput({ cron_log_max_bytes: 0 }))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('cron_log_max_bytes')
    expect(message).not.toContain('got 0')
  })
})

// ---------------------------------------------------------------------------
// Defaults track the actual loaded config dir (through loadPersonaConfig)
// ---------------------------------------------------------------------------

// E6 (cron dispatch / buildSpawnParams) relies on this resolved-path coverage:
// absent cron_table_path → the default (below: beside the config with
// SLACK_STATE_DIR set; outside ~/.claude without it, bug b.avm), and present
// with leading tilde → expanded absolute path (see 'tilde expansion' block).
// No E6 gap-fill needed — both halves are proven here.
describe('cron config keys — defaults track loaded config dir', () => {
  // The preload guard sets SLACK_STATE_DIR (tests/test-helpers/host-safety-preload.ts),
  // so the loader's own read of process.env takes the state-dir branch.
  test('with SLACK_STATE_DIR set, absent path keys default under the directory of the loaded config', () => {
    expect(process.env['SLACK_STATE_DIR'] ?? '').not.toBe('')
    const result = load(makeInput())
    expect(result.cron_table_path).toBe(join(dir, 'crontab'))
    expect(result.cron_log_path).toBe(join(dir, 'cron.log'))
  })

  test('resolvePersonaConfig honors an explicit configDir', () => {
    const result = resolvePersonaConfig(makeInput(), '/custom/cfg/dir', home, { env: { SLACK_STATE_DIR: '/custom/cfg/dir' } })
    expect(result.cron_table_path).toBe('/custom/cfg/dir/crontab')
    expect(result.cron_log_path).toBe('/custom/cfg/dir/cron.log')
  })
})

// ---------------------------------------------------------------------------
// Bug b.avm: the crontable's default sits outside ~/.claude
//
// Every case passes its environment as an explicit object (never a copy of
// process.env) and its home as the case's mkdtempSync home, so no default can
// resolve under the real ~/.config.
// ---------------------------------------------------------------------------

describe('crontable default outside ~/.claude (bug b.avm)', () => {
  /** A default install's config directory under the case's home. */
  const stateDirUnder = (h: string): string => join(h, '.claude', 'channels', 'slack')

  test.each<[string, NodeJS.ProcessEnv, (h: string) => string]>([
    ['SLACK_STATE_DIR and XDG_CONFIG_HOME unset → <home>/.config/cscb/crontab', {}, (h) => join(h, '.config', 'cscb', 'crontab')],
    ['SLACK_STATE_DIR empty counts as unset', { SLACK_STATE_DIR: '' }, (h) => join(h, '.config', 'cscb', 'crontab')],
    ['XDG_CONFIG_HOME absolute → $XDG_CONFIG_HOME/cscb/crontab', { XDG_CONFIG_HOME: '/xdg/conf/' }, () => '/xdg/conf/cscb/crontab'],
    ['XDG_CONFIG_HOME empty is ignored', { XDG_CONFIG_HOME: '' }, (h) => join(h, '.config', 'cscb', 'crontab')],
    ['XDG_CONFIG_HOME relative is ignored', { XDG_CONFIG_HOME: 'rel/conf' }, (h) => join(h, '.config', 'cscb', 'crontab')],
    ['SLACK_STATE_DIR set → <config dir>/crontab, beside the state directory\'s config.json, whatever XDG_CONFIG_HOME says',{ SLACK_STATE_DIR: '/srv/state', XDG_CONFIG_HOME: '/xdg/conf' }, (h) => join(stateDirUnder(h), 'crontab')],
  ])('resolveDefaultCronTablePath: %s', (_label, env, expected) => {
    expect(resolveDefaultCronTablePath(stateDirUnder(home), home, env)).toBe(expected(home))
  })

  test('over the server\'s own config path: SLACK_STATE_DIR set → <state dir>/crontab; unset → outside the default state dir under ~/.claude', () => {
    const stateEnv = { SLACK_STATE_DIR: join(home, 'state') }
    expect(resolveDefaultCronTablePath(dirname(resolveServerConfigPath(home, stateEnv)), home, stateEnv)).toBe(join(home, 'state', 'crontab'))
    const configDir = dirname(resolveServerConfigPath(home, {}))
    expect(configDir).toBe(stateDirUnder(home))
    expect(resolveDefaultCronTablePath(configDir, home, {})).toBe(join(home, '.config', 'cscb', 'crontab'))
  })

  test('the loader: no cron_table_path and SLACK_STATE_DIR unset → <home>/.config/cscb/crontab, outside ~/.claude, flagged as filled in; the cron log stays beside config.json', () => {
    const configDir = stateDirUnder(home)
    const result = resolvePersonaConfig(makeInput(), configDir, home, { env: {} })
    expect(result.cron_table_path).toBe(join(home, '.config', 'cscb', 'crontab'))
    expect(result.cron_table_path.startsWith(join(home, '.claude'))).toBe(false)
    expect(result.cron_table_path_defaulted).toBe(true)
    expect(result.cron_log_path).toBe(join(configDir, 'cron.log'))
  })

  // cron_table_path_defaulted is what the start's crontable preparation acts
  // on: only a default the loader filled in is prepared or moved, never a path
  // the operator wrote, even the default's own file (D-Q1).
  test.each<[string, (h: string) => Record<string, unknown>, NodeJS.ProcessEnv, (h: string) => string, boolean]>([
    ['null → the default, flagged as filled in', () => ({ cron_table_path: null }), {}, (h) => join(h, '.config', 'cscb', 'crontab'), true],
    ['absent with SLACK_STATE_DIR set → <config dir>/crontab, flagged as filled in', () => ({}), { SLACK_STATE_DIR: '/srv/state' }, (h) => join(stateDirUnder(h), 'crontab'), true],
    ["written as the default's own file (~ expanded) → that path, not flagged", () => ({ cron_table_path: '~/.config/cscb/crontab' }), {}, (h) => join(h, '.config', 'cscb', 'crontab'), false],
    ["written as the default's own file (absolute) → that path, not flagged", (h) => ({ cron_table_path: join(h, '.config', 'cscb', 'crontab') }), {}, (h) => join(h, '.config', 'cscb', 'crontab'), false],
    ['written as another path → used verbatim (~ expanded under the home), not flagged', () => ({ cron_table_path: '~/cron/table' }), {}, (h) => join(h, 'cron', 'table'), false],
    ['written as an absolute path → used verbatim whatever XDG_CONFIG_HOME says, not flagged', () => ({ cron_table_path: '/etc/cron/table' }), { XDG_CONFIG_HOME: '/xdg/conf' }, () => '/etc/cron/table', false],
  ])('the loader: cron_table_path %s', (_label, keys, env, expected, defaulted) => {
    const result = resolvePersonaConfig(makeInput(keys(home)), stateDirUnder(home), home, { env })
    expect([result.cron_table_path, result.cron_table_path_defaulted]).toEqual([expected(home), defaulted])
  })

  test('the loader: XDG_CONFIG_HOME is honoured from the environment it is given', () => {
    const result = parsePersonaConfigBytes(JSON.stringify(makeInput()), 'config.json', stateDirUnder(home), { home, env: { XDG_CONFIG_HOME: join(home, 'xdg') } })
    expect(result.cron_table_path).toBe(join(home, 'xdg', 'cscb', 'crontab'))
  })

  test('the default home is the OS home, read at call time: under a fake launch-time home it is <fake home>/.config/cscb/crontab', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'config-cron-fake-home-'))
    try {
      const run = runInFakeHome({
        modulePath: CONFIG_MODULE,
        call: 'process.stdout.write("PATH::" + mod.resolveDefaultCronTablePath(input.configDir, undefined, {}) + "\\n")',
        input: { configDir: join(fakeHome, '.claude', 'channels', 'slack') },
        home: fakeHome,
        stateDir: join(fakeHome, 'state'),
      })
      expect(run.observedHomedir).toBe(fakeHome)
      expect(run.status).toBe(0)
      expect(run.stdout).toContain(`PATH::${join(fakeHome, '.config', 'cscb', 'crontab')}\n`)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// No default for cron_log_max_bytes: absent → undefined
// ---------------------------------------------------------------------------

describe('cron_log_max_bytes — no default', () => {
  test('loadPersonaConfig leaves cron_log_max_bytes undefined when absent', () => {
    const result = load(makeInput())
    expect(result.cron_log_max_bytes).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tilde expansion for both path keys (under the injected home)
// ---------------------------------------------------------------------------

describe('cron config keys — tilde expansion', () => {
  test('expands ~ in cron_table_path and resolves to absolute', () => {
    const result = load(makeInput({ cron_table_path: '~/cron/table' }))
    expect(result.cron_table_path).toBe(`${home}/cron/table`)
    expect(result.cron_table_path).not.toContain('~')
  })

  test('expands ~ in cron_log_path and resolves to absolute', () => {
    const result = load(makeInput({ cron_log_path: '~/cron/cron.log' }))
    expect(result.cron_log_path).toBe(`${home}/cron/cron.log`)
    expect(result.cron_log_path).not.toContain('~')
  })

  test('does not mutate the input paths', () => {
    const input = makeInput({ cron_table_path: '~/cron/table', cron_log_path: '~/cron/cron.log' })
    resolvePersonaConfig(input, dir, home)
    expect(input.cron_table_path).toBe('~/cron/table')
    expect(input.cron_log_path).toBe('~/cron/cron.log')
  })
})

// ---------------------------------------------------------------------------
// Unknown-key rejection: the cron keys are accepted, a genuine unknown still rejects
// ---------------------------------------------------------------------------

describe('cron config keys — unknown-field rejection interaction', () => {
  test('a genuinely unknown key still rejects even alongside the cron keys', () => {
    expect(() => load(makeInput({ cron_table_path: '/etc/cron/table', blorp: 1 }))).toThrow(
      /unknown top-level field/,
    )
  })
})
