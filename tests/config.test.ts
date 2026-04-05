import { describe, test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { homedir } from 'os'
import {
  applyDefaults,
  validateConfig,
  expandTilde,
  resolveConfig,
  loadConfig,
  type RouteEntry,
  type RoutingConfigInput,
  type RoutingConfig,
} from '../src/config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(overrides: Partial<RouteEntry> = {}): RouteEntry {
  return {
    cwd: '/tmp/project',
    ...overrides,
  }
}

function makeRoutingConfig(overrides: Partial<RoutingConfigInput> = {}): RoutingConfigInput {
  return {
    routes: {
      C_GENERAL: makeRoute({ cwd: '/tmp/general' }),
    },
    session_restart_delay: 60,
    health_check_interval: 120,
    mcp_config_path: '~/.claude/slack-mcp.json',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// applyDefaults()
// ---------------------------------------------------------------------------

describe('applyDefaults', () => {
  test('fills bind with default when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.bind).toBe('127.0.0.1')
  })

  test('fills port with default when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.port).toBe(3100)
  })

  test('preserves provided bind value', () => {
    const result = applyDefaults(makeRoutingConfig({ bind: '0.0.0.0' }))
    expect(result.bind).toBe('0.0.0.0')
  })

  test('preserves provided port value', () => {
    const result = applyDefaults(makeRoutingConfig({ port: 8080 }))
    expect(result.port).toBe(8080)
  })

  test('passes through routes unchanged', () => {
    const input = makeRoutingConfig()
    const result = applyDefaults(input)
    expect(result.routes).toBe(input.routes)
  })

  test('passes through default_route when provided', () => {
    const result = applyDefaults(makeRoutingConfig({ default_route: '/tmp/general' }))
    expect(result.default_route).toBe('/tmp/general')
  })

  test('passes through default_dm_session when provided', () => {
    const result = applyDefaults(makeRoutingConfig({ default_dm_session: '/tmp/general' }))
    expect(result.default_dm_session).toBe('/tmp/general')
  })

  test('does not mutate the input object', () => {
    const input = makeRoutingConfig()
    const inputCopy = JSON.stringify(input)
    applyDefaults(input)
    expect(JSON.stringify(input)).toBe(inputCopy)
  })

  test('fills session_restart_delay with 60 when absent', () => {
    const result = applyDefaults(makeRoutingConfig({ session_restart_delay: undefined }))
    expect(result.session_restart_delay).toBe(60)
  })

  test('preserves provided session_restart_delay value', () => {
    const result = applyDefaults(makeRoutingConfig({ session_restart_delay: 120 }))
    expect(result.session_restart_delay).toBe(120)
  })

  test('preserves session_restart_delay of 0', () => {
    const result = applyDefaults(makeRoutingConfig({ session_restart_delay: 0 }))
    expect(result.session_restart_delay).toBe(0)
  })

  test('fills health_check_interval with 120 when absent', () => {
    const result = applyDefaults(makeRoutingConfig({ health_check_interval: undefined }))
    expect(result.health_check_interval).toBe(120)
  })

  test('preserves provided health_check_interval value', () => {
    const result = applyDefaults(makeRoutingConfig({ health_check_interval: 30 }))
    expect(result.health_check_interval).toBe(30)
  })

  test('preserves health_check_interval of 0', () => {
    const result = applyDefaults(makeRoutingConfig({ health_check_interval: 0 }))
    expect(result.health_check_interval).toBe(0)
  })

  test('fills mcp_config_path with default when absent', () => {
    const result = applyDefaults(makeRoutingConfig({ mcp_config_path: undefined }))
    expect(result.mcp_config_path).toBe('~/.claude/slack-mcp.json')
  })

  test('preserves provided mcp_config_path value', () => {
    const result = applyDefaults(makeRoutingConfig({ mcp_config_path: '/custom/mcp.json' }))
    expect(result.mcp_config_path).toBe('/custom/mcp.json')
  })

  test('passes through append_system_prompt_file when present', () => {
    const result = applyDefaults(makeRoutingConfig({ append_system_prompt_file: '~/my-prompts/extra.md' }))
    expect(result.append_system_prompt_file).toBe('~/my-prompts/extra.md')
  })

  test('omits append_system_prompt_file when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.append_system_prompt_file).toBeUndefined()
  })

  test('fills exit_timeout with 120 when absent', () => {
    const result = applyDefaults(makeRoutingConfig({ exit_timeout: undefined }))
    expect(result.exit_timeout).toBe(120)
  })

  test('preserves provided exit_timeout value', () => {
    const result = applyDefaults(makeRoutingConfig({ exit_timeout: 60 }))
    expect(result.exit_timeout).toBe(60)
  })

  test('preserves exit_timeout of 0', () => {
    const result = applyDefaults(makeRoutingConfig({ exit_timeout: 0 }))
    expect(result.exit_timeout).toBe(0)
  })

  test('fills stop_timeout with 30 when absent', () => {
    const result = applyDefaults(makeRoutingConfig({ stop_timeout: undefined }))
    expect(result.stop_timeout).toBe(30)
  })

  test('preserves provided stop_timeout value', () => {
    const result = applyDefaults(makeRoutingConfig({ stop_timeout: 10 }))
    expect(result.stop_timeout).toBe(10)
  })

  test('preserves stop_timeout of 0', () => {
    const result = applyDefaults(makeRoutingConfig({ stop_timeout: 0 }))
    expect(result.stop_timeout).toBe(0)
  })

  test('fills cozempic_prescription with "standard" when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.cozempic_prescription).toBe('standard')
  })

  test('preserves provided cozempic_prescription value "gentle"', () => {
    const result = applyDefaults(makeRoutingConfig({ cozempic_prescription: 'gentle' }))
    expect(result.cozempic_prescription).toBe('gentle')
  })

  test('preserves provided cozempic_prescription value "aggressive"', () => {
    const result = applyDefaults(makeRoutingConfig({ cozempic_prescription: 'aggressive' }))
    expect(result.cozempic_prescription).toBe('aggressive')
  })
})

// ---------------------------------------------------------------------------
// validateConfig()
// ---------------------------------------------------------------------------

function makeValidConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    routes: {
      C_GENERAL: makeRoute({ cwd: '/tmp/general' }),
    },
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: 60,
    health_check_interval: 120,
    exit_timeout: 120,
    stop_timeout: 30,
    mcp_config_path: `${homedir()}/.claude/slack-mcp.json`,
    cozempic_prescription: 'standard',
    system_prompt_mode: 'append',
    ...overrides,
  }
}

describe('validateConfig', () => {
  test('valid config with one route passes without throwing', () => {
    expect(() => validateConfig(makeValidConfig())).not.toThrow()
  })

  test('valid config with multiple routes passes without throwing', () => {
    const config = makeValidConfig({
      routes: {
        C_GENERAL: makeRoute({ cwd: '/tmp/general' }),
        C_DEV: makeRoute({ cwd: '/tmp/dev' }),
      },
    })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('throws when routes is empty', () => {
    const config = makeValidConfig({ routes: {} })
    expect(() => validateConfig(config)).toThrow(
      'routes must contain at least one entry',
    )
  })

  test('throws on duplicate CWDs across different channels', () => {
    const config = makeValidConfig({
      routes: {
        C_GENERAL: makeRoute({ cwd: '/tmp/same' }),
        C_DEV: makeRoute({ cwd: '/tmp/same' }),
      },
    })
    expect(() => validateConfig(config)).toThrow(
      'duplicate CWD "/tmp/same"',
    )
  })

  test('throws when default_route references a nonexistent CWD', () => {
    const config = makeValidConfig({ default_route: '/tmp/nonexistent' })
    expect(() => validateConfig(config)).toThrow(
      'default_route "/tmp/nonexistent" does not match any defined route CWD',
    )
  })

  test('passes when default_route references a valid route CWD', () => {
    const config = makeValidConfig({ default_route: '/tmp/general' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('throws when default_dm_session references a nonexistent CWD', () => {
    const config = makeValidConfig({ default_dm_session: '/tmp/ghost' })
    expect(() => validateConfig(config)).toThrow(
      'default_dm_session "/tmp/ghost" does not match any defined route CWD',
    )
  })

  test('passes when default_dm_session references a valid route CWD', () => {
    const config = makeValidConfig({ default_dm_session: '/tmp/general' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('error message mentions "Routing config validation error"', () => {
    const config = makeValidConfig({ routes: {} })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
  })

  test('throws when session_restart_delay is negative', () => {
    const config = makeValidConfig({ session_restart_delay: -1 })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
  })

  test('throws when health_check_interval is negative', () => {
    const config = makeValidConfig({ health_check_interval: -1 })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
  })

  test('passes when append_system_prompt_file is present', () => {
    const config = makeValidConfig({ append_system_prompt_file: '/tmp/extra.md' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('throws when exit_timeout is negative', () => {
    const config = makeValidConfig({ exit_timeout: -1 })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
  })

  test('throws when stop_timeout is negative', () => {
    const config = makeValidConfig({ stop_timeout: -1 })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
  })

  test('accepts zero for exit_timeout', () => {
    const config = makeValidConfig({ exit_timeout: 0 })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('accepts zero for stop_timeout', () => {
    const config = makeValidConfig({ stop_timeout: 0 })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('passes for cozempic_prescription "gentle"', () => {
    const config = makeValidConfig({ cozempic_prescription: 'gentle' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('passes for cozempic_prescription "standard"', () => {
    const config = makeValidConfig({ cozempic_prescription: 'standard' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('passes for cozempic_prescription "aggressive"', () => {
    const config = makeValidConfig({ cozempic_prescription: 'aggressive' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('throws for invalid cozempic_prescription "turbo"', () => {
    const config = makeValidConfig({ cozempic_prescription: 'turbo' })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
    expect(() => validateConfig(config)).toThrow('"turbo"')
  })

  test('throws for empty string cozempic_prescription', () => {
    const config = makeValidConfig({ cozempic_prescription: '' })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
  })

  test('throws for cozempic_prescription "STANDARD" (case-sensitive)', () => {
    const config = makeValidConfig({ cozempic_prescription: 'STANDARD' })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
  })
})

// ---------------------------------------------------------------------------
// expandTilde()
// ---------------------------------------------------------------------------

describe('expandTilde', () => {
  test('replaces ~ alone with home directory', () => {
    expect(expandTilde('~')).toBe(homedir())
  })

  test('replaces ~/ prefix with home directory', () => {
    const result = expandTilde('~/projects/foo')
    expect(result).toBe(homedir() + '/projects/foo')
  })

  test('leaves absolute paths unchanged', () => {
    expect(expandTilde('/absolute/path/to/file')).toBe('/absolute/path/to/file')
  })

  test('leaves relative paths unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path')
  })

  test('does not expand ~ in the middle of a string', () => {
    expect(expandTilde('/path/~/middle')).toBe('/path/~/middle')
  })

  test('expanded path starts with home dir', () => {
    const result = expandTilde('~/foo')
    expect(result.startsWith(homedir())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveConfig()
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  test('returns a fully resolved config with defaults applied', () => {
    const input = makeRoutingConfig()
    const result = resolveConfig(input)
    expect(result.bind).toBe('127.0.0.1')
    expect(result.port).toBe(3100)
  })

  test('expands tilde in route cwd paths', () => {
    const input = makeRoutingConfig({
      routes: {
        C_GENERAL: makeRoute({ cwd: '~/my-project' }),
      },
    })
    const result = resolveConfig(input)
    expect(result.routes['C_GENERAL'].cwd).toStartWith(homedir())
    expect(result.routes['C_GENERAL'].cwd).not.toContain('~')
  })

  test('resolves absolute cwd paths (path.resolve)', () => {
    const input = makeRoutingConfig({
      routes: {
        C_GENERAL: makeRoute({ cwd: '/tmp/project' }),
      },
    })
    const result = resolveConfig(input)
    expect(result.routes['C_GENERAL'].cwd).toBe('/tmp/project')
  })

  test('expands tilde in default_route CWD', () => {
    const input = makeRoutingConfig({
      routes: { C_A: { cwd: '~/my-project' } },
      default_route: '~/my-project',
    })
    const result = resolveConfig(input)
    expect(result.default_route).toStartWith(homedir())
    expect(result.default_route).not.toContain('~')
  })

  test('expands tilde in default_dm_session CWD', () => {
    const input = makeRoutingConfig({
      routes: { C_A: { cwd: '~/my-project' } },
      default_dm_session: '~/my-project',
    })
    const result = resolveConfig(input)
    expect(result.default_dm_session).toStartWith(homedir())
    expect(result.default_dm_session).not.toContain('~')
  })

  test('throws on invalid config (empty routes)', () => {
    expect(() => resolveConfig({ routes: {} })).toThrow()
  })

  test('throws on duplicate CWDs', () => {
    const input: RoutingConfigInput = {
      routes: {
        C_A: { cwd: '/tmp/same' },
        C_B: { cwd: '/tmp/same' },
      },
    }
    expect(() => resolveConfig(input)).toThrow('duplicate CWD')
  })

  test('does not mutate the input', () => {
    const input = makeRoutingConfig({
      routes: {
        C_TILDE: makeRoute({ cwd: '~/stuff' }),
      },
    })
    const originalCwd = input.routes['C_TILDE'].cwd
    resolveConfig(input)
    expect(input.routes['C_TILDE'].cwd).toBe(originalCwd)
  })

  test('preserves provided defaults over built-in defaults', () => {
    const input = makeRoutingConfig({ port: 9999 })
    const result = resolveConfig(input)
    expect(result.port).toBe(9999)
  })

  test('passes health_check_interval through unchanged', () => {
    const input = makeRoutingConfig({ health_check_interval: 45 })
    const result = resolveConfig(input)
    expect(result.health_check_interval).toBe(45)
  })

  test('expands tilde in mcp_config_path', () => {
    const input = makeRoutingConfig({ mcp_config_path: '~/.claude/slack-mcp.json' })
    const result = resolveConfig(input)
    expect(result.mcp_config_path).toStartWith(homedir())
  })

  test('resolved mcp_config_path does not contain tilde', () => {
    const input = makeRoutingConfig({ mcp_config_path: '~/.claude/slack-mcp.json' })
    const result = resolveConfig(input)
    expect(result.mcp_config_path).not.toContain('~')
  })

  test('does not mutate mcp_config_path in input', () => {
    const input = makeRoutingConfig({ mcp_config_path: '~/.claude/slack-mcp.json' })
    const originalPath = input.mcp_config_path
    resolveConfig(input)
    expect(input.mcp_config_path).toBe(originalPath)
  })

  test('expands tilde in append_system_prompt_file', () => {
    const input = makeRoutingConfig({ append_system_prompt_file: '~/my-prompts/extra.md' })
    const result = resolveConfig(input)
    expect(result.append_system_prompt_file).toStartWith(homedir())
    expect(result.append_system_prompt_file).not.toContain('~')
  })

  test('resolves absolute append_system_prompt_file path unchanged', () => {
    const input = makeRoutingConfig({ append_system_prompt_file: '/etc/prompts/extra.md' })
    const result = resolveConfig(input)
    expect(result.append_system_prompt_file).toBe('/etc/prompts/extra.md')
  })

  test('leaves append_system_prompt_file undefined when absent', () => {
    const input = makeRoutingConfig()
    const result = resolveConfig(input)
    expect(result.append_system_prompt_file).toBeUndefined()
  })

  test('defaults cozempic_prescription to "standard" when absent', () => {
    const input = makeRoutingConfig()
    const result = resolveConfig(input)
    expect(result.cozempic_prescription).toBe('standard')
  })

  test('passes through valid cozempic_prescription "gentle"', () => {
    const input = makeRoutingConfig({ cozempic_prescription: 'gentle' })
    const result = resolveConfig(input)
    expect(result.cozempic_prescription).toBe('gentle')
  })

  test('throws on invalid cozempic_prescription end-to-end', () => {
    expect(() => resolveConfig({ routes: { C: { cwd: '/tmp' } }, cozempic_prescription: 'turbo' })).toThrow('"turbo"')
  })
})

// ---------------------------------------------------------------------------
// loadConfig()
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  test('throws a clear error for a missing file', () => {
    const nonexistentPath = '/tmp/this-path-does-not-exist-config-test-12345.json'
    expect(() => loadConfig(nonexistentPath)).toThrow('loadConfig: cannot read routing config')
  })

  test('missing file error includes the file path', () => {
    const nonexistentPath = '/tmp/totally-missing-routing-config.json'
    let caught: Error | null = null
    try {
      loadConfig(nonexistentPath)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain(nonexistentPath)
  })

  test('throws a clear error for malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const badPath = join(dir, 'config.json')
    writeFileSync(badPath, '{ this is not valid json !!!', 'utf-8')
    expect(() => loadConfig(badPath)).toThrow('loadConfig: malformed JSON')
  })

  test('malformed JSON error includes the file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const badPath = join(dir, 'config.json')
    writeFileSync(badPath, '{ bad json }', 'utf-8')
    let caught: Error | null = null
    try {
      loadConfig(badPath)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain(badPath)
  })

  test('loads and returns a valid config from a temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const validConfig: RoutingConfigInput = {
      routes: {
        C_TEST: { cwd: '/tmp' },
      },
      port: 4242,
    }
    writeFileSync(configPath, JSON.stringify(validConfig), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.port).toBe(4242)
    expect(result.routes['C_TEST'].cwd).toBe('/tmp')
  })

  test('applies defaults when loading a minimal valid config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const minimalConfig: RoutingConfigInput = {
      routes: {
        C_MIN: { cwd: '/tmp' },
      },
    }
    writeFileSync(configPath, JSON.stringify(minimalConfig), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.bind).toBe('127.0.0.1')
    expect(result.port).toBe(3100)
  })

  test('throws a clear error when routes field is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const badPath = join(dir, 'config.json')
    writeFileSync(badPath, JSON.stringify({ bind: '0.0.0.0' }), 'utf-8')
    expect(() => loadConfig(badPath)).toThrow('missing a valid "routes" object')
  })

  test('throws when JSON is valid but not an object (array)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const badPath = join(dir, 'config.json')
    writeFileSync(badPath, JSON.stringify([1, 2, 3]), 'utf-8')
    expect(() => loadConfig(badPath)).toThrow('must be a JSON object')
  })

  test('round-trips exit_timeout correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
      exit_timeout: 45,
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.exit_timeout).toBe(45)
  })

  test('applies default exit_timeout of 120 when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.exit_timeout).toBe(120)
  })

  test('round-trips stop_timeout correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
      stop_timeout: 5,
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.stop_timeout).toBe(5)
  })

  test('applies default stop_timeout of 30 when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.stop_timeout).toBe(30)
  })

  test('round-trips cozempic_prescription "aggressive" correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
      cozempic_prescription: 'aggressive',
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.cozempic_prescription).toBe('aggressive')
  })

  test('applies default cozempic_prescription of "standard" when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.cozempic_prescription).toBe('standard')
  })
})
