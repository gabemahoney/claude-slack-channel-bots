import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadPersonaConfig, resolvePersonaConfig, type PersonaConfigInput } from '../src/config.ts'
import { makePersonaConfigInput, writeConfigFile } from './test-helpers/persona-config.ts'

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
// absent cron_table_path → default <config dir>/crontab (below), and present with
// leading tilde → expanded absolute path (see 'tilde expansion' block). No E6 gap-fill
// needed — both halves are proven here.
describe('cron config keys — defaults track loaded config dir', () => {
  test('absent path keys default under the directory of the loaded config', () => {
    const result = load(makeInput())
    expect(result.cron_table_path).toBe(join(dir, 'crontab'))
    expect(result.cron_log_path).toBe(join(dir, 'cron.log'))
  })

  test('resolvePersonaConfig honors an explicit configDir', () => {
    const result = resolvePersonaConfig(makeInput(), '/custom/cfg/dir', home)
    expect(result.cron_table_path).toBe('/custom/cfg/dir/crontab')
    expect(result.cron_log_path).toBe('/custom/cfg/dir/cron.log')
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
