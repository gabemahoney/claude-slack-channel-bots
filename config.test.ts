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
} from './config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(overrides: Partial<RouteEntry> = {}): RouteEntry {
  return {
    cwd: '/tmp/project',
    name: 'my-bot',
    ...overrides,
  }
}

function makeRoutingConfig(overrides: Partial<RoutingConfigInput> = {}): RoutingConfigInput {
  return {
    routes: {
      C_GENERAL: makeRoute({ name: 'general-bot', cwd: '/tmp/general' }),
    },
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

  test('fills use_waggle with false when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.use_waggle).toBe(false)
  })

  test('fills spawn_timeout with 60 when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.spawn_timeout).toBe(60)
  })

  test('preserves provided bind value', () => {
    const result = applyDefaults(makeRoutingConfig({ bind: '0.0.0.0' }))
    expect(result.bind).toBe('0.0.0.0')
  })

  test('preserves provided port value', () => {
    const result = applyDefaults(makeRoutingConfig({ port: 8080 }))
    expect(result.port).toBe(8080)
  })

  test('preserves provided use_waggle true value', () => {
    const result = applyDefaults(makeRoutingConfig({ use_waggle: true }))
    expect(result.use_waggle).toBe(true)
  })

  test('preserves provided spawn_timeout value', () => {
    const result = applyDefaults(makeRoutingConfig({ spawn_timeout: 120 }))
    expect(result.spawn_timeout).toBe(120)
  })

  test('passes through routes unchanged', () => {
    const input = makeRoutingConfig()
    const result = applyDefaults(input)
    expect(result.routes).toBe(input.routes)
  })

  test('passes through default_route when provided', () => {
    const result = applyDefaults(makeRoutingConfig({ default_route: 'general-bot' }))
    expect(result.default_route).toBe('general-bot')
  })

  test('passes through default_dm_session when provided', () => {
    const result = applyDefaults(makeRoutingConfig({ default_dm_session: 'general-bot' }))
    expect(result.default_dm_session).toBe('general-bot')
  })

  test('does not mutate the input object', () => {
    const input = makeRoutingConfig()
    const inputCopy = JSON.stringify(input)
    applyDefaults(input)
    expect(JSON.stringify(input)).toBe(inputCopy)
  })
})

// ---------------------------------------------------------------------------
// validateConfig()
// ---------------------------------------------------------------------------

function makeValidConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    routes: {
      C_GENERAL: makeRoute({ name: 'general-bot', cwd: '/tmp/general' }),
    },
    bind: '127.0.0.1',
    port: 3100,
    use_waggle: false,
    spawn_timeout: 60,
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
        C_GENERAL: makeRoute({ name: 'general-bot', cwd: '/tmp/general' }),
        C_DEV: makeRoute({ name: 'dev-bot', cwd: '/tmp/dev' }),
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

  test('throws on duplicate route names across different channels', () => {
    const config = makeValidConfig({
      routes: {
        C_GENERAL: makeRoute({ name: 'duplicate-name', cwd: '/tmp/a' }),
        C_DEV: makeRoute({ name: 'duplicate-name', cwd: '/tmp/b' }),
      },
    })
    expect(() => validateConfig(config)).toThrow(
      'duplicate route name "duplicate-name"',
    )
  })

  test('throws when default_route references a nonexistent name', () => {
    const config = makeValidConfig({ default_route: 'nonexistent' })
    expect(() => validateConfig(config)).toThrow(
      'default_route "nonexistent" does not match any defined route name',
    )
  })

  test('passes when default_route references a valid route name', () => {
    const config = makeValidConfig({ default_route: 'general-bot' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('throws when default_dm_session references a nonexistent name', () => {
    const config = makeValidConfig({ default_dm_session: 'ghost-session' })
    expect(() => validateConfig(config)).toThrow(
      'default_dm_session "ghost-session" does not match any defined route name',
    )
  })

  test('passes when default_dm_session references a valid route name', () => {
    const config = makeValidConfig({ default_dm_session: 'general-bot' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('error message mentions "Routing config validation error"', () => {
    const config = makeValidConfig({ routes: {} })
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
    expect(result.use_waggle).toBe(false)
    expect(result.spawn_timeout).toBe(60)
  })

  test('expands tilde in route cwd paths', () => {
    const input = makeRoutingConfig({
      routes: {
        C_GENERAL: makeRoute({ name: 'tilde-bot', cwd: '~/my-project' }),
      },
    })
    const result = resolveConfig(input)
    expect(result.routes['C_GENERAL'].cwd).toStartWith(homedir())
    expect(result.routes['C_GENERAL'].cwd).not.toContain('~')
  })

  test('resolves absolute cwd paths (path.resolve)', () => {
    const input = makeRoutingConfig({
      routes: {
        C_GENERAL: makeRoute({ name: 'abs-bot', cwd: '/tmp/project' }),
      },
    })
    const result = resolveConfig(input)
    expect(result.routes['C_GENERAL'].cwd).toBe('/tmp/project')
  })

  test('throws on invalid config (empty routes)', () => {
    expect(() => resolveConfig({ routes: {} })).toThrow()
  })

  test('throws on duplicate route names', () => {
    const input: RoutingConfigInput = {
      routes: {
        C_A: makeRoute({ name: 'same-name', cwd: '/tmp/a' }),
        C_B: makeRoute({ name: 'same-name', cwd: '/tmp/b' }),
      },
    }
    expect(() => resolveConfig(input)).toThrow('duplicate route name')
  })

  test('does not mutate the input', () => {
    const input = makeRoutingConfig({
      routes: {
        C_TILDE: makeRoute({ name: 'tilde-bot', cwd: '~/stuff' }),
      },
    })
    const originalCwd = input.routes['C_TILDE'].cwd
    resolveConfig(input)
    expect(input.routes['C_TILDE'].cwd).toBe(originalCwd)
  })

  test('preserves provided defaults over built-in defaults', () => {
    const input = makeRoutingConfig({ port: 9999, use_waggle: true })
    const result = resolveConfig(input)
    expect(result.port).toBe(9999)
    expect(result.use_waggle).toBe(true)
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
    const badPath = join(dir, 'routing.json')
    writeFileSync(badPath, '{ this is not valid json !!!', 'utf-8')
    expect(() => loadConfig(badPath)).toThrow('loadConfig: malformed JSON')
  })

  test('malformed JSON error includes the file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const badPath = join(dir, 'routing.json')
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
    const configPath = join(dir, 'routing.json')
    const validConfig: RoutingConfigInput = {
      routes: {
        C_TEST: { name: 'test-bot', cwd: '/tmp' },
      },
      port: 4242,
    }
    writeFileSync(configPath, JSON.stringify(validConfig), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.port).toBe(4242)
    expect(result.routes['C_TEST'].name).toBe('test-bot')
  })

  test('applies defaults when loading a minimal valid config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'routing.json')
    const minimalConfig: RoutingConfigInput = {
      routes: {
        C_MIN: { name: 'minimal-bot', cwd: '/tmp' },
      },
    }
    writeFileSync(configPath, JSON.stringify(minimalConfig), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.bind).toBe('127.0.0.1')
    expect(result.port).toBe(3100)
    expect(result.use_waggle).toBe(false)
    expect(result.spawn_timeout).toBe(60)
  })

  test('throws a clear error when routes field is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const badPath = join(dir, 'routing.json')
    writeFileSync(badPath, JSON.stringify({ bind: '0.0.0.0' }), 'utf-8')
    expect(() => loadConfig(badPath)).toThrow('missing a valid "routes" object')
  })

  test('throws when JSON is valid but not an object (array)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const badPath = join(dir, 'routing.json')
    writeFileSync(badPath, JSON.stringify([1, 2, 3]), 'utf-8')
    expect(() => loadConfig(badPath)).toThrow('must be a JSON object')
  })
})
