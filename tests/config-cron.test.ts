import { describe, test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, resolve, dirname } from 'path'
import {
  applyDefaults,
  resolveConfig,
  loadConfig,
  type RoutingConfigInput,
} from '../src/config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal valid input; add cron keys via overrides in individual tests.
function makeInput(overrides: Partial<RoutingConfigInput> = {}): RoutingConfigInput {
  return {
    routes: { C_TEST: { cwd: '/tmp/project' } },
    ...overrides,
  }
}

// Writes a config.json into a fresh temp dir and returns { dir, configPath }.
function writeConfig(config: RoutingConfigInput): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'config-cron-test-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify(config), 'utf-8')
  return { dir, configPath }
}

// The dir under which pure-function callers (no configDir) default cron paths.
const DEFAULT_CONFIG_DIR = dirname(resolve(homedir() + '/.claude/channels/slack/config.json'))

// ---------------------------------------------------------------------------
// Acceptance of valid values
// ---------------------------------------------------------------------------

describe('cron config keys — acceptance', () => {
  test('resolveConfig carries an absolute cron_table_path', () => {
    const result = resolveConfig(makeInput({ cron_table_path: '/etc/cron/table' }))
    expect(result.cron_table_path).toBe('/etc/cron/table')
  })

  test('resolveConfig carries an absolute cron_log_path', () => {
    const result = resolveConfig(makeInput({ cron_log_path: '/var/log/cron.log' }))
    expect(result.cron_log_path).toBe('/var/log/cron.log')
  })

  test('resolveConfig carries a valid cron_log_max_bytes', () => {
    const result = resolveConfig(makeInput({ cron_log_max_bytes: 1_048_576 }))
    expect(result.cron_log_max_bytes).toBe(1_048_576)
  })

  test('cron_log_max_bytes of 1 (lower bound) is accepted', () => {
    const result = resolveConfig(makeInput({ cron_log_max_bytes: 1 }))
    expect(result.cron_log_max_bytes).toBe(1)
  })

  test('loadConfig round-trips all three keys', () => {
    const { configPath } = writeConfig(
      makeInput({
        cron_table_path: '/etc/cron/table',
        cron_log_path: '/var/log/cron.log',
        cron_log_max_bytes: 4096,
      }),
    )
    const result = loadConfig(configPath)
    expect(result.cron_table_path).toBe('/etc/cron/table')
    expect(result.cron_log_path).toBe('/var/log/cron.log')
    expect(result.cron_log_max_bytes).toBe(4096)
  })
})

// ---------------------------------------------------------------------------
// Rejection of invalid values (through loadConfig; match on substring)
// ---------------------------------------------------------------------------

describe('cron config keys — path rejection', () => {
  test.each([
    ['', 'empty string'],
    ['   ', 'whitespace-only'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [42 as any, 'non-string'],
  ])('rejects cron_table_path %p (%s)', (value) => {
    const { configPath } = writeConfig(makeInput({ cron_table_path: value }))
    expect(() => loadConfig(configPath)).toThrow(
      'cron_table_path must be a non-empty string.',
    )
  })

  test.each([
    ['', 'empty string'],
    ['   ', 'whitespace-only'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [42 as any, 'non-string'],
  ])('rejects cron_log_path %p (%s)', (value) => {
    const { configPath } = writeConfig(makeInput({ cron_log_path: value }))
    expect(() => loadConfig(configPath)).toThrow(
      'cron_log_path must be a non-empty string.',
    )
  })
})

describe('cron config keys — cron_log_max_bytes rejection', () => {
  test.each([
    [0, 'zero'],
    [-1, 'negative'],
    [1.5, 'non-integer'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ['1000' as any, 'non-numeric'],
  ])('rejects cron_log_max_bytes %p (%s)', (value) => {
    const { configPath } = writeConfig(makeInput({ cron_log_max_bytes: value }))
    expect(() => loadConfig(configPath)).toThrow(
      'cron_log_max_bytes must be a positive integer (>= 1) when set;',
    )
  })

  test('rejection message embeds the offending JSON value', () => {
    const { configPath } = writeConfig(makeInput({ cron_log_max_bytes: 0 }))
    expect(() => loadConfig(configPath)).toThrow('got 0.')
  })
})

// ---------------------------------------------------------------------------
// Defaults track the actual loaded config dir (through loadConfig)
// ---------------------------------------------------------------------------

describe('cron config keys — defaults track loaded config dir', () => {
  test('absent path keys default under the directory of the loaded config', () => {
    const { dir, configPath } = writeConfig(makeInput())
    const result = loadConfig(configPath)
    expect(result.cron_table_path).toBe(join(dir, 'crontab'))
    expect(result.cron_log_path).toBe(join(dir, 'cron.log'))
  })
})

// ---------------------------------------------------------------------------
// Pure-function fallback (no configDir → dirname of DEFAULT_CONFIG_PATH)
// ---------------------------------------------------------------------------

describe('cron config keys — pure-function fallback defaults', () => {
  test('resolveConfig with no configDir defaults paths under expanded DEFAULT_CONFIG_PATH dir', () => {
    const result = resolveConfig(makeInput())
    expect(result.cron_table_path).toBe(join(DEFAULT_CONFIG_DIR, 'crontab'))
    expect(result.cron_log_path).toBe(join(DEFAULT_CONFIG_DIR, 'cron.log'))
  })

  test('applyDefaults honors an explicit configDir over the fallback', () => {
    const result = applyDefaults(makeInput(), '/custom/cfg/dir')
    expect(result.cron_table_path).toBe('/custom/cfg/dir/crontab')
    expect(result.cron_log_path).toBe('/custom/cfg/dir/cron.log')
  })
})

// ---------------------------------------------------------------------------
// No default for cron_log_max_bytes: absent → undefined
// ---------------------------------------------------------------------------

describe('cron_log_max_bytes — no default', () => {
  test('loadConfig leaves cron_log_max_bytes undefined when absent', () => {
    const { configPath } = writeConfig(makeInput())
    const result = loadConfig(configPath)
    expect(result.cron_log_max_bytes).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tilde expansion for both path keys
// ---------------------------------------------------------------------------

describe('cron config keys — tilde expansion', () => {
  test('expands ~ in cron_table_path and resolves to absolute', () => {
    const result = resolveConfig(makeInput({ cron_table_path: '~/cron/table' }))
    expect(result.cron_table_path).toBe(`${homedir()}/cron/table`)
    expect(result.cron_table_path).not.toContain('~')
  })

  test('expands ~ in cron_log_path and resolves to absolute', () => {
    const result = resolveConfig(makeInput({ cron_log_path: '~/cron/cron.log' }))
    expect(result.cron_log_path).toBe(`${homedir()}/cron/cron.log`)
    expect(result.cron_log_path).not.toContain('~')
  })

  test('does not mutate the input paths', () => {
    const input = makeInput({ cron_table_path: '~/cron/table', cron_log_path: '~/cron/cron.log' })
    resolveConfig(input)
    expect(input.cron_table_path).toBe('~/cron/table')
    expect(input.cron_log_path).toBe('~/cron/cron.log')
  })
})

// ---------------------------------------------------------------------------
// Unknown-key rejection: three new keys accepted, genuine unknown still rejects
// ---------------------------------------------------------------------------

describe('cron config keys — unknown-field rejection interaction', () => {
  test('a genuinely unknown key still rejects even alongside the cron keys', () => {
    const { configPath } = writeConfig({
      routes: { C_TEST: { cwd: '/tmp/project' } },
      cron_table_path: '/etc/cron/table',
      blorp: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(() => loadConfig(configPath)).toThrow(/unknown top-level field/)
  })
})
