import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { homedir } from 'os'
import {
  applyDefaults,
  validateConfig,
  expandTilde,
  resolveConfig,
  loadConfig,
  loadPersonaConfig,
  prePersonaConversionMessage,
  resolvePersonaConfig,
  resolveRealPath,
  type RouteEntry,
  type RoutingConfigInput,
  type RoutingConfig,
  type PersonaConfigInput,
  type PersonaInput,
} from '../src/config.ts'
import { personaKey } from '../src/persona-identity.ts'
import {
  makePersona,
  makePersonaConfig,
  makePersonaConfigInput,
  writeConfigFile,
} from './test-helpers/persona-config.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  assertNoLeak,
  fakeToken,
  writeCredentialsFile,
} from './test-helpers/credentials.ts'

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

  test('passes through message_archive_db when present', () => {
    const result = applyDefaults(makeRoutingConfig({ message_archive_db: '~/archive.db' }))
    expect(result.message_archive_db).toBe('~/archive.db')
  })

  test('omits message_archive_db when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.message_archive_db).toBeUndefined()
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

  test('fills system_prompt_mode with "append" when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.system_prompt_mode).toBe('append')
  })

  test('preserves provided system_prompt_mode value "append"', () => {
    const result = applyDefaults(makeRoutingConfig({ system_prompt_mode: 'append' }))
    expect(result.system_prompt_mode).toBe('append')
  })

  test('preserves provided system_prompt_mode value "none"', () => {
    const result = applyDefaults(makeRoutingConfig({ system_prompt_mode: 'none' }))
    expect(result.system_prompt_mode).toBe('none')
  })

  test('leaves claude_config_dir undefined when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.claude_config_dir).toBeUndefined()
  })

  test('preserves provided claude_config_dir value', () => {
    const result = applyDefaults(makeRoutingConfig({
      claude_config_dir: '/foo',
    }))
    expect(result.claude_config_dir).toBe('/foo')
  })

  test('preserves per-route claude_config_dir verbatim', () => {
    const result = applyDefaults(makeRoutingConfig({
      routes: {
        C_GENERAL: makeRoute({
          cwd: '/tmp/general',
          claude_config_dir: '/route-dir',
        }),
      },
    }))
    expect(result.routes['C_GENERAL'].claude_config_dir).toBe('/route-dir')
  })

  test('fills resume_enabled with true when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.resume_enabled).toBe(true)
  })

  test('preserves resume_enabled: false when explicitly set', () => {
    const result = applyDefaults(makeRoutingConfig({ resume_enabled: false }))
    expect(result.resume_enabled).toBe(false)
  })

  test('preserves resume_enabled: true when explicitly set', () => {
    const result = applyDefaults(makeRoutingConfig({ resume_enabled: true }))
    expect(result.resume_enabled).toBe(true)
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
    cron_table_path: `${homedir()}/.claude/channels/slack/crontab`,
    cron_log_path: `${homedir()}/.claude/channels/slack/cron.log`,
    cozempic_prescription: 'standard',
    system_prompt_mode: 'append',
    resume_enabled: true,
    stop_hook_bootstrap: true,
    agent_director_poll_interval_ms: 1000,
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

  test('passes for system_prompt_mode "append"', () => {
    const config = makeValidConfig({ system_prompt_mode: 'append' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('passes for system_prompt_mode "none"', () => {
    const config = makeValidConfig({ system_prompt_mode: 'none' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('throws for invalid system_prompt_mode "replace"', () => {
    const config = makeValidConfig({ system_prompt_mode: 'replace' })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
    expect(() => validateConfig(config)).toThrow('"replace"')
  })

  test('throws for empty string system_prompt_mode', () => {
    const config = makeValidConfig({ system_prompt_mode: '' })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
  })

  test('throws for system_prompt_mode "APPEND" (case-sensitive)', () => {
    const config = makeValidConfig({ system_prompt_mode: 'APPEND' })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
  })

  test('passes when claude_config_dir is omitted', () => {
    const config = makeValidConfig()
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('passes for valid claude_config_dir', () => {
    const config = makeValidConfig({ claude_config_dir: '/foo' })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('throws for empty claude_config_dir', () => {
    const config = makeValidConfig({ claude_config_dir: '' })
    expect(() => validateConfig(config)).toThrow('claude_config_dir must be a non-empty string')
  })

  test('throws for whitespace-only claude_config_dir', () => {
    const config = makeValidConfig({ claude_config_dir: '   ' })
    expect(() => validateConfig(config)).toThrow('claude_config_dir must be a non-empty string')
  })

  test('passes for per-route claude_config_dir override', () => {
    const config = makeValidConfig({
      routes: {
        C_GENERAL: { cwd: '/tmp/general', claude_config_dir: '/x' },
      },
    })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('throws for empty per-route claude_config_dir', () => {
    const config = makeValidConfig({
      routes: {
        C_GENERAL: { cwd: '/tmp/general', claude_config_dir: '' },
      },
    })
    expect(() => validateConfig(config)).toThrow('routes["C_GENERAL"].claude_config_dir must be a non-empty string')
  })

  test('throws for whitespace-only per-route claude_config_dir', () => {
    const config = makeValidConfig({
      routes: {
        C_GENERAL: { cwd: '/tmp/general', claude_config_dir: '\t  ' },
      },
    })
    expect(() => validateConfig(config)).toThrow('routes["C_GENERAL"].claude_config_dir must be a non-empty string')
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

  test('expands tilde in message_archive_db', () => {
    const input = makeRoutingConfig({ message_archive_db: '~/archives/msg.db' })
    const result = resolveConfig(input)
    expect(result.message_archive_db).toStartWith(homedir())
    expect(result.message_archive_db).not.toContain('~')
  })

  test('leaves message_archive_db undefined when absent', () => {
    const input = makeRoutingConfig()
    const result = resolveConfig(input)
    expect(result.message_archive_db).toBeUndefined()
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

  test('defaults system_prompt_mode to "append" when absent', () => {
    const input = makeRoutingConfig()
    const result = resolveConfig(input)
    expect(result.system_prompt_mode).toBe('append')
  })

  test('passes through valid system_prompt_mode "none"', () => {
    const input = makeRoutingConfig({ system_prompt_mode: 'none' })
    const result = resolveConfig(input)
    expect(result.system_prompt_mode).toBe('none')
  })

  test('throws on invalid system_prompt_mode end-to-end', () => {
    expect(() => resolveConfig({ routes: { C: { cwd: '/tmp' } }, system_prompt_mode: 'replace' })).toThrow('"replace"')
  })

  test('leaves claude_config_dir undefined when absent', () => {
    const input = makeRoutingConfig()
    const result = resolveConfig(input)
    expect(result.claude_config_dir).toBeUndefined()
  })

  test('expands ~ on top-level claude_config_dir and resolves to absolute', () => {
    const input = makeRoutingConfig({ claude_config_dir: '~/.claude-maxauth' })
    const result = resolveConfig(input)
    expect(result.claude_config_dir).toBe(`${homedir()}/.claude-maxauth`)
  })

  test('preserves and expands per-route claude_config_dir through resolveConfig', () => {
    const input: RoutingConfigInput = {
      routes: {
        C_A: { cwd: '/tmp/a', claude_config_dir: '/x' },
        C_B: { cwd: '/tmp/b' },
        C_C: { cwd: '/tmp/c', claude_config_dir: '~/personal' },
      },
    }
    const result = resolveConfig(input)
    expect(result.routes['C_A'].claude_config_dir).toBe('/x')
    expect(result.routes['C_B'].claude_config_dir).toBeUndefined()
    expect(result.routes['C_C'].claude_config_dir).toBe(`${homedir()}/personal`)
  })

  test('throws on empty top-level claude_config_dir end-to-end', () => {
    expect(() => resolveConfig({
      routes: { C: { cwd: '/tmp' } },
      claude_config_dir: '',
    })).toThrow('claude_config_dir must be a non-empty string')
  })

  test('throws on empty per-route claude_config_dir end-to-end', () => {
    expect(() => resolveConfig({
      routes: { C_X: { cwd: '/tmp', claude_config_dir: '' } },
    })).toThrow('routes["C_X"].claude_config_dir must be a non-empty string')
  })

  test('preserves resume_enabled: false through resolveConfig', () => {
    const input = makeRoutingConfig({ resume_enabled: false })
    const result = resolveConfig(input)
    expect(result.resume_enabled).toBe(false)
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

  test('round-trips system_prompt_mode "none" correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
      system_prompt_mode: 'none',
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.system_prompt_mode).toBe('none')
  })

  test('applies default system_prompt_mode of "append" when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.system_prompt_mode).toBe('append')
  })

  test('round-trips top-level claude_config_dir through loadConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
      claude_config_dir: '/home/horde/.claude-maxauth',
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.claude_config_dir).toBe('/home/horde/.claude-maxauth')
  })

  test('round-trips per-route claude_config_dir through loadConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: {
        C_PERSONAL: { cwd: '/tmp/personal', claude_config_dir: '/p' },
        C_DEFAULT: { cwd: '/tmp/default' },
      },
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.routes['C_PERSONAL'].claude_config_dir).toBe('/p')
    expect(result.routes['C_DEFAULT'].claude_config_dir).toBeUndefined()
  })

  test('leaves claude_config_dir undefined when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.claude_config_dir).toBeUndefined()
  })

  test('resume_enabled: false survives JSON parse + resolve pipeline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
      resume_enabled: false,
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.resume_enabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SR-4.1: agent_director_poll_interval_ms
// ---------------------------------------------------------------------------

describe('agent_director_poll_interval_ms (SR-4.1)', () => {
  test('defaults to 1000 when absent', () => {
    const result = resolveConfig({ routes: { C: { cwd: '/tmp' } } })
    expect(result.agent_director_poll_interval_ms).toBe(1000)
  })

  test('accepts the lower bound (200)', () => {
    const result = resolveConfig({
      routes: { C: { cwd: '/tmp' } },
      agent_director_poll_interval_ms: 200,
    })
    expect(result.agent_director_poll_interval_ms).toBe(200)
  })

  test('accepts the upper bound (3_600_000)', () => {
    const result = resolveConfig({
      routes: { C: { cwd: '/tmp' } },
      agent_director_poll_interval_ms: 3_600_000,
    })
    expect(result.agent_director_poll_interval_ms).toBe(3_600_000)
  })

  test('rejects values below 200', () => {
    expect(() =>
      resolveConfig({ routes: { C: { cwd: '/tmp' } }, agent_director_poll_interval_ms: 199 }),
    ).toThrow(/agent_director_poll_interval_ms must be a positive integer/)
  })

  test('rejects values above 3_600_000', () => {
    expect(() =>
      resolveConfig({ routes: { C: { cwd: '/tmp' } }, agent_director_poll_interval_ms: 3_600_001 }),
    ).toThrow(/agent_director_poll_interval_ms must be a positive integer/)
  })

  test('rejects non-integer values', () => {
    expect(() =>
      resolveConfig({ routes: { C: { cwd: '/tmp' } }, agent_director_poll_interval_ms: 1.5 }),
    ).toThrow(/must be a positive integer/)
  })

  test('rejects non-number values', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveConfig({ routes: { C: { cwd: '/tmp' } }, agent_director_poll_interval_ms: '1000' as any }),
    ).toThrow(/must be a positive integer/)
  })
})

// ---------------------------------------------------------------------------
// SR-4.2: unknown-field rejection
// ---------------------------------------------------------------------------

describe('loadConfig — unknown-field rejection (SR-4.2)', () => {
  test('rejects unknown top-level fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ routes: { C: { cwd: '/tmp' } }, blorp: 1 }),
      'utf-8',
    )
    expect(() => loadConfig(configPath)).toThrow(/unknown top-level field/)
  })

  test('rejects the pre-rename claude_director_poll_interval_ms with a directed error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ routes: { C: { cwd: '/tmp' } }, claude_director_poll_interval_ms: 500 }),
      'utf-8',
    )
    expect(() => loadConfig(configPath)).toThrow(
      /claude_director_poll_interval_ms has been renamed to agent_director_poll_interval_ms/,
    )
  })

  test('rejects unknown per-route fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ routes: { C: { cwd: '/tmp', extra: 'no' } } }),
      'utf-8',
    )
    expect(() => loadConfig(configPath)).toThrow(/unknown field\(s\) in routes\["C"\]/)
  })

  test('accepts a config with only known fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        routes: { C: { cwd: '/tmp', claude_config_dir: '/x' } },
        agent_director_poll_interval_ms: 500,
        resume_enabled: false,
      }),
      'utf-8',
    )
    expect(() => loadConfig(configPath)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// SR-4.1–SR-4.5: stop_hook_bootstrap
// ---------------------------------------------------------------------------

describe('stop_hook_bootstrap (SR-4.1–SR-4.5)', () => {
  // applyDefaults --------------------------------------------------------

  test('applyDefaults fills top-level stop_hook_bootstrap with true when absent', () => {
    const result = applyDefaults(makeRoutingConfig())
    expect(result.stop_hook_bootstrap).toBe(true)
  })

  test('applyDefaults preserves stop_hook_bootstrap: true when explicitly set', () => {
    const result = applyDefaults(makeRoutingConfig({ stop_hook_bootstrap: true }))
    expect(result.stop_hook_bootstrap).toBe(true)
  })

  test('applyDefaults preserves stop_hook_bootstrap: false when explicitly set', () => {
    const result = applyDefaults(makeRoutingConfig({ stop_hook_bootstrap: false }))
    expect(result.stop_hook_bootstrap).toBe(false)
  })

  test('applyDefaults leaves per-route stop_hook_bootstrap undefined when absent (inherit)', () => {
    const result = applyDefaults(makeRoutingConfig({
      routes: {
        C_GENERAL: makeRoute({ cwd: '/tmp/general' }),
      },
    }))
    expect(result.routes['C_GENERAL'].stop_hook_bootstrap).toBeUndefined()
  })

  test('applyDefaults preserves per-route stop_hook_bootstrap: false verbatim', () => {
    const result = applyDefaults(makeRoutingConfig({
      routes: {
        C_GENERAL: makeRoute({ cwd: '/tmp/general', stop_hook_bootstrap: false }),
      },
    }))
    expect(result.routes['C_GENERAL'].stop_hook_bootstrap).toBe(false)
  })

  test('applyDefaults preserves per-route stop_hook_bootstrap: true verbatim', () => {
    const result = applyDefaults(makeRoutingConfig({
      routes: {
        C_GENERAL: makeRoute({ cwd: '/tmp/general', stop_hook_bootstrap: true }),
      },
    }))
    expect(result.routes['C_GENERAL'].stop_hook_bootstrap).toBe(true)
  })

  // validateConfig -------------------------------------------------------

  test('validateConfig passes when stop_hook_bootstrap is set at top level', () => {
    const config = makeValidConfig({ stop_hook_bootstrap: false })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('validateConfig passes when stop_hook_bootstrap is set per route', () => {
    const config = makeValidConfig({
      routes: {
        C_GENERAL: makeRoute({ cwd: '/tmp/general', stop_hook_bootstrap: false }),
      },
    })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('validateConfig throws for non-boolean top-level stop_hook_bootstrap', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = makeValidConfig({ stop_hook_bootstrap: 'yes' as any })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
    expect(() => validateConfig(config)).toThrow('stop_hook_bootstrap must be a boolean')
  })

  test('validateConfig throws for non-boolean per-route stop_hook_bootstrap and names the route', () => {
    const config = makeValidConfig({
      routes: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        C_GENERAL: { cwd: '/tmp/general', stop_hook_bootstrap: 1 as any },
      },
    })
    expect(() => validateConfig(config)).toThrow('Routing config validation error')
    expect(() => validateConfig(config)).toThrow('routes["C_GENERAL"].stop_hook_bootstrap must be a boolean')
  })

  // Per-route-wins effective value --------------------------------------

  test('per-route stop_hook_bootstrap: false wins over top-level default of true', () => {
    const result = resolveConfig({
      routes: {
        C_OFF: { cwd: '/tmp/off', stop_hook_bootstrap: false },
        C_INHERIT: { cwd: '/tmp/inherit' },
      },
    })
    expect(result.stop_hook_bootstrap).toBe(true)
    expect(result.routes['C_OFF'].stop_hook_bootstrap ?? result.stop_hook_bootstrap).toBe(false)
    expect(result.routes['C_INHERIT'].stop_hook_bootstrap ?? result.stop_hook_bootstrap).toBe(true)
  })

  test('per-route stop_hook_bootstrap: true wins over top-level false', () => {
    const result = resolveConfig({
      routes: {
        C_ON: { cwd: '/tmp/on', stop_hook_bootstrap: true },
        C_INHERIT: { cwd: '/tmp/inherit' },
      },
      stop_hook_bootstrap: false,
    })
    expect(result.stop_hook_bootstrap).toBe(false)
    expect(result.routes['C_ON'].stop_hook_bootstrap ?? result.stop_hook_bootstrap).toBe(true)
    expect(result.routes['C_INHERIT'].stop_hook_bootstrap ?? result.stop_hook_bootstrap).toBe(false)
  })

  // loadConfig round-trip -----------------------------------------------

  test('loadConfig round-trips stop_hook_bootstrap: false at top level and true/false per route', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: {
        C_ON: { cwd: '/tmp/on', stop_hook_bootstrap: true },
        C_OFF: { cwd: '/tmp/off', stop_hook_bootstrap: false },
        C_INHERIT: { cwd: '/tmp/inherit' },
      },
      stop_hook_bootstrap: false,
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.stop_hook_bootstrap).toBe(false)
    expect(result.routes['C_ON'].stop_hook_bootstrap).toBe(true)
    expect(result.routes['C_OFF'].stop_hook_bootstrap).toBe(false)
    expect(result.routes['C_INHERIT'].stop_hook_bootstrap).toBeUndefined()
  })

  test('loadConfig resolves top-level stop_hook_bootstrap to true when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    const config: RoutingConfigInput = {
      routes: { C_TEST: { cwd: '/tmp' } },
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const result = loadConfig(configPath)
    expect(result.stop_hook_bootstrap).toBe(true)
  })

  test('loadConfig does not fire unknown-field rejection for stop_hook_bootstrap at either level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        routes: { C: { cwd: '/tmp', stop_hook_bootstrap: false } },
        stop_hook_bootstrap: true,
      }),
      'utf-8',
    )
    expect(() => loadConfig(configPath)).not.toThrow()
  })
})

// ===========================================================================
// Persona configuration loader (b.av2 SR-1.1–1.3, 1.5, 1.6, 1.7) and its
// real-path helper
//
// Every case writes its file into its own mkdtempSync directory and loads it
// with an injected mkdtempSync home (b.av2 SR-13.2); both are removed after
// each case. Directories, placeholder credentials files and symlinks live in
// that temp directory too. The loader lives in src/config.ts, so no
// child-process import purity test is added here (b.av2 SR-13.1).
// ===========================================================================

/**
 * Non-token-shaped stand-in for a secret, a rejected value or the content of a
 * credentials file; must never reach an error. Unhyphenated so a JSON parser
 * quotes it whole (Bun stops an identifier at `-`), keeping the malformed-JSON
 * leak check meaningful.
 */
const PLACEHOLDER = 'placeholder_not_a_secret'

describe('resolveRealPath (b.av2 SR-1.5)', () => {
  let tmp: string
  /** The temp root's own real path: the temp root may itself sit behind a symlink. */
  let real: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'real-path-'))
    real = realpathSync(tmp)
    mkdirSync(join(tmp, 'dir'))
    mkdirSync(join(tmp, 'other'))
    writeFileSync(join(tmp, 'dir', 'file.json'), PLACEHOLDER)
    symlinkSync(join(tmp, 'dir'), join(tmp, 'dir-link'))
    symlinkSync(join(tmp, 'dir', 'file.json'), join(tmp, 'file-link.json'))
    symlinkSync(join(tmp, 'absent'), join(tmp, 'dangling'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** `rel` appended to the temp root as text, so `.`, `..` and trailing `/` survive. */
  const at = (rel: string) => `${tmp}/${rel}`
  const listing = () => readdirSync(tmp, { recursive: true }).sort()

  test.each([
    ['an existing directory', 'dir', 'real', 'dir'],
    ['an existing file', 'dir/file.json', 'real', 'dir/file.json'],
    ['a symlink to the directory', 'dir-link', 'real', 'dir'],
    ['a symlink to the file', 'file-link.json', 'real', 'dir/file.json'],
    ['a path through a symlinked parent directory', 'dir-link/file.json', 'real', 'dir/file.json'],
    ['a non-existent path', 'missing/x', 'lexical', 'missing/x'],
    ['a non-existent path with a trailing slash', 'missing/x/', 'lexical', 'missing/x'],
    ['a non-existent path with a . segment', 'missing/./x', 'lexical', 'missing/x'],
    ['a non-existent path with a .. segment', 'missing/y/../x', 'lexical', 'missing/x'],
    ['a dangling symlink, without throwing', 'dangling', 'lexical', 'dangling'],
  ] as const)('%s (%s) resolves to its %s form and writes nothing', (_label, input, form, expected) => {
    const before = listing()
    expect(resolveRealPath(at(input))).toBe(resolve(form === 'real' ? real : tmp, expected))
    expect(listing()).toEqual(before)
  })

  test.each([
    ['two different non-existent paths', 'missing/x', 'missing/y'],
    ['a symlink to one directory and an unrelated existing directory', 'dir-link', 'other'],
  ])('%s resolve to different values', (_label, a, b) => {
    expect(resolveRealPath(at(a))).not.toBe(resolveRealPath(at(b)))
  })

  test('an injected realpath that throws gives the lexical form, not the symlink target', () => {
    const fails = () => {
      throw new Error('simulated realpath failure')
    }
    expect(resolveRealPath(at('dir/../dir-link/'), fails)).toBe(join(tmp, 'dir-link'))
  })

  test('an injected realpath that returns a value is used as is', () => {
    const calls: string[] = []
    const injected = (path: string) => {
      calls.push(path)
      return join(tmp, 'injected')
    }
    expect(resolveRealPath(at('dir-link'), injected)).toBe(join(tmp, 'injected'))
    expect(calls).toEqual([at('dir-link')])
  })
})

describe('loadPersonaConfig (b.av2 SR-1)', () => {
  let dir: string
  let home: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'persona-config-'))
    home = mkdtempSync(join(tmpdir(), 'persona-home-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  const load = (input: unknown) => loadPersonaConfig(writeConfigFile(dir, input), home)

  /**
   * Load `input`, expecting rejection; returns the message after checking it
   * leaks no placeholder and that the whole error passes `assertNoLeak` (the
   * config leg of AC 20), so every rejection case built on it is leak-checked.
   */
  function loadError(input: unknown): string {
    let error: Error | undefined
    try {
      load(input)
    } catch (err) {
      error = err as Error
    }
    if (error === undefined) throw new Error('expected loadPersonaConfig to reject the configuration')
    assertNoLeak(error, 'rejection')
    expect(error.message).not.toContain(PLACEHOLDER)
    return error.message
  }

  /** The b.av2 SR-2.2 persona reference: JSON-quoted name with its key. */
  function expectNamesPersona(message: string, name: string): void {
    expect(message).toContain(`${JSON.stringify(name)} (key=${personaKey(name)})`)
  }

  const withPersonas = (...personas: PersonaInput[]) => makePersonaConfigInput({ personas })

  describe('valid load', () => {
    test('AC 3: two personas sharing a channel, one also in a second channel, resolve with keys and defaults — the two-channel persona loads as a single persona holding both channels', () => {
      const config = load(withPersonas(
        makePersona({
          name: 'Ops Bot',
          channels: [{ id: 'C0TEST001', delivery: 'all' }, { id: 'G0TEST002', delivery: 'all' }],
          dm: undefined,
        }),
        makePersona({ name: 'review_bot' }),
      ))
      expect(config.personas.map((p) => [p.index, p.name, p.key])).toEqual([
        [0, 'Ops Bot', personaKey('Ops Bot')],
        [1, 'review_bot', personaKey('review_bot')],
      ])
      expect(config.personas[0].channels.map((c) => c.id)).toEqual(['C0TEST001', 'G0TEST002'])
      expect(config.personas[1].channels.map((c) => c.id)).toEqual(['C0TEST001'])
      // AC 3: the persona in two channels is one persona, not one per channel.
      expect(config.personas.filter((p) => p.name === 'Ops Bot')).toHaveLength(1)
      for (const persona of config.personas) {
        expect(persona.dm).toEqual({ enabled: false })
        expect('contact' in persona.dm).toBe(false)
        expect('claude_config_dir' in persona).toBe(false)
        expect(persona.stop_hook_bootstrap).toBe(true)
      }
    })

    test('the default input resolves to the makePersonaConfig shape', () => {
      const config = load(makePersonaConfigInput({}, dir))
      expect(config).toEqual(makePersonaConfig({ mcp_config_path: join(home, '.claude', 'slack-mcp.json') }, dir))
    })

    test('a mentions channel loads', () => {
      const config = load(withPersonas(makePersona({ channels: [{ id: 'C0TEST001', delivery: 'mentions' }] })))
      expect(config.personas[0].channels).toEqual([{ id: 'C0TEST001', delivery: 'mentions' }])
    })

    test('a ~ config path is expanded under the injected home', () => {
      writeConfigFile(home, makePersonaConfigInput())
      expect(loadPersonaConfig('~/config.json', home).cron_table_path).toBe(join(home, 'crontab'))
    })
  })

  describe('empty and zero-channel shapes', () => {
    test('an empty personas array loads (AC 54 config leg)', () => {
      expect(load({ personas: [] }).personas).toEqual([])
    })

    test('a zero-channel DM-only persona loads, channels defaulting to empty (AC 40/41 config leg)', () => {
      const persona = makePersona({
        channels: undefined,
        dm: { enabled: true, contact: 'U0TEST001' },
        permission_prompts: 'dm',
      })
      const [resolved] = load(withPersonas(persona)).personas
      expect(resolved.channels).toEqual([])
      expect(resolved.dm).toEqual({ enabled: true, contact: 'U0TEST001' })
      expect(resolved.permission_prompts).toBe('dm')
    })

    test.each([
      ['missing', 'personas', {}],
      ['an object', 'personas', { personas: {} }],
      ['a string', 'personas', { personas: 'none' }],
      ['holding a null entry', 'personas[0]', { personas: [null] }],
    ])('personas %s is rejected, naming %s', (_label, named, input) => {
      expect(loadError(input)).toContain(named)
    })
  })

  describe('claude_config_dir and stop_hook_bootstrap inheritance (SR-1.2, SR-10.2; AC 48 config leg)', () => {
    test.each([
      ['neither set: absent and true', {}, {}, undefined, true],
      ['top-level only: inherited', { claude_config_dir: '~/cfg-top', stop_hook_bootstrap: false }, {}, 'cfg-top', false],
      [
        'per-persona wins over top-level',
        { claude_config_dir: '~/cfg-top', stop_hook_bootstrap: false },
        { claude_config_dir: '~/cfg-own', stop_hook_bootstrap: true },
        'cfg-own',
        true,
      ],
    ])('%s', (_label, top, own, expectedDir, expectedStopHook) => {
      const [persona] = load({ ...makePersonaConfigInput(top), personas: [makePersona(own)] }).personas
      expect(persona.claude_config_dir).toBe(expectedDir === undefined ? undefined : join(home, expectedDir))
      expect(persona.stop_hook_bootstrap).toBe(expectedStopHook)
    })
  })

  describe('persona path rules (SR-1.2)', () => {
    test.each([
      ['credentials_file', '~/creds/ops.json'],
      ['working_directory', '~'],
      ['claude_config_dir', '~/cfg'],
    ] as const)('%s accepts %s, expanded under the injected home', (setting, value) => {
      const [persona] = load(withPersonas(makePersona({ [setting]: value }))).personas
      expect(persona[setting]).toBe(value === '~' ? home : join(home, value.slice(2)))
    })

    test('absolute paths that do not exist load: existence is not a load-time check', () => {
      const paths = {
        credentials_file: join(dir, 'missing', 'credentials.json'),
        working_directory: join(dir, 'missing', 'work'),
        claude_config_dir: join(dir, 'missing', 'claude'),
      }
      const [persona] = load(withPersonas(makePersona(paths))).personas
      expect(persona).toMatchObject(paths)
      for (const path of Object.values(paths)) expect(existsSync(path)).toBe(false)
    })

    test.each([
      ['credentials_file', 'relative/credentials.json'],
      ['working_directory', '~other/work'],
      ['claude_config_dir', './claude'],
    ])('%s rejects %s, naming the persona and the key', (setting, value) => {
      const message = loadError(withPersonas(makePersona({ name: 'Ops Bot', [setting]: value }, dir)))
      expectNamesPersona(message, 'Ops Bot')
      expect(message).toContain(setting)
      expect(message).not.toContain(value)
    })
  })

  describe('unknown keys (SR-1.1, SR-1.2; AC 20 config leg)', () => {
    // Table inputs are built at registration, before `dir` exists, so these
    // personas keep the helper's default base dir; each case is rejected per
    // entry, before any path is resolved.
    const persona = (overrides: Record<string, unknown>) =>
      withPersonas(makePersona({ name: 'Ops Bot', ...overrides } as Partial<PersonaInput>))

    // The token-like keys hold sentinel-bearing fake tokens: loadError's
    // assertNoLeak proves the error names the key but never echoes the value.
    test.each([
      ['top-level', { ...makePersonaConfigInput(), extra_setting: 1 }, 'extra_setting', false],
      ['persona entry', persona({ nickname: 'ops' }), 'nickname', true],
      ['persona entry bot_token', persona({ bot_token: fakeToken(BOT_TOKEN_PREFIX, 'entry') }), 'bot_token', true],
      ['persona entry app_token', persona({ app_token: fakeToken(APP_TOKEN_PREFIX, 'entry') }), 'app_token', true],
      ['persona entry route-era cwd (SR-10.2)', persona({ cwd: '/tmp/somewhere' }), 'cwd', true],
      ['dm object', persona({ dm: { enabled: false, relay: true } }), 'relay', true],
      ['channel entry', persona({ channels: [{ id: 'C0TEST001', delivery: 'all', label: 'ops' }] }), 'label', true],
    ])('an unknown key in the %s is rejected, naming it', (_label, input, key, inPersona) => {
      const message = loadError(input)
      expect(message).toContain(JSON.stringify(key))
      if (inPersona) expectNamesPersona(message, 'Ops Bot')
    })
  })

  describe('dm and channel shapes, channel and contact formats (SR-1.2, SR-1.3, SR-1.5)', () => {
    test.each([
      ['a non-object dm', { dm: true }, 'dm'],
      ['a non-array channels', { channels: PLACEHOLDER }, 'channels'],
      ['a non-object channel entry', { channels: [null] }, 'channels[0]'],
      ['a channel ID not matching ^[CG][A-Z0-9]+$', { channels: [{ id: 'D0TEST001', delivery: 'all' }] }, 'channels[0].id'],
      ['a missing channel id', { channels: [{ delivery: 'all' }] }, 'channels[0].id'],
      ['a missing delivery', { channels: [{ id: 'C0TEST001' }] }, 'channels[0].delivery'],
      ['an unsupported delivery', { channels: [{ id: 'C0TEST001', delivery: PLACEHOLDER }] }, 'channels[0].delivery'],
      ['a dm.contact not matching ^[UW][A-Z0-9]+$', { dm: { enabled: true, contact: 'B0TEST001' } }, 'dm.contact'],
      [
        'the same channel listed twice',
        { channels: [{ id: 'C0TEST001', delivery: 'all' }, { id: 'C0TEST001', delivery: 'mentions' }] },
        'C0TEST001',
      ],
    ])('%s is rejected, naming the persona and the key or channel', (_label, overrides, named) => {
      const message = loadError(withPersonas(makePersona({ name: 'Ops Bot', ...overrides } as Partial<PersonaInput>, dir)))
      expectNamesPersona(message, 'Ops Bot')
      expect(message).toContain(named)
    })
  })

  describe('type and range errors (SR-1.5)', () => {
    test.each([
      ['an empty name', { name: '' }, 'name'],
      ['a whitespace-only name', { name: '   ' }, 'name'],
      ['a non-string name', { name: 42 }, 'name'],
    ])('%s is rejected, naming personas[i] and the setting', (_label, overrides, setting) => {
      const message = loadError(withPersonas(makePersona(overrides as Partial<PersonaInput>, dir)))
      expect(message).toContain(`personas[0]: ${setting}`)
    })

    test.each([
      ['a missing credentials_file', { credentials_file: undefined }, 'credentials_file'],
      ['a missing working_directory', { working_directory: undefined }, 'working_directory'],
      ['a non-boolean dm.enabled', { dm: { enabled: 'yes' } }, 'dm.enabled'],
      ['a non-boolean stop_hook_bootstrap', { stop_hook_bootstrap: 'false' }, 'stop_hook_bootstrap'],
      ['an empty claude_config_dir', { claude_config_dir: '' }, 'claude_config_dir'],
      ['a permission_prompts that is neither dm nor a channel ID', { permission_prompts: PLACEHOLDER }, 'permission_prompts'],
    ])('%s is rejected, naming the persona and the setting', (_label, overrides, setting) => {
      const message = loadError(withPersonas(makePersona({ name: 'Ops Bot', ...overrides } as Partial<PersonaInput>, dir)))
      expectNamesPersona(message, 'Ops Bot')
      expect(message).toContain(setting)
    })
  })

  describe('SR-14 rejection table and cross-persona rules (SR-1.5; AC 21, 30, 32, 33, 42, 43, 53)', () => {
    /** A name needing normalisation whose key is longer than 40 characters, so a persona named by that key has another key. */
    const LONG_NAME = 'Operations Review And Deployment Assistant Bot'
    const LONG_KEY = personaKey(LONG_NAME)
    /** An in-form name that is its own key and equals the derived key of 'Ops Bot'. */
    const OPS_KEY = personaKey('Ops Bot')
    /** Slack token prefixes; no error may contain one (loadError's `assertNoLeak` checks the whole error too). */
    const TOKEN_LIKE = /\bx(?:ox[a-z]|app)-/

    const inDir = (rel: string) => join(dir, rel)
    const makeDir = (rel: string) => {
      mkdirSync(inDir(rel), { recursive: true })
      return inDir(rel)
    }
    /** A real 0600 credentials file holding sentinel-bearing fake tokens, which no error may echo. */
    const makeCredentials = (rel: string) => writeCredentialsFile(dir, rel)
    const makeLink = (target: string, rel: string) => {
      symlinkSync(target, inDir(rel))
      return inDir(rel)
    }

    /**
     * Personas in array order, each with its own non-existent paths under the
     * temp dir (`p<i>/work`, `p<i>/credentials.json`) unless overridden, so a
     * case collides only where it says so.
     */
    const personasOf = (...entries: [string, Partial<PersonaInput>?][]) =>
      entries.map(([name, overrides], i) =>
        makePersona(
          { name, working_directory: inDir(`p${i}/work`), credentials_file: inDir(`p${i}/credentials.json`), ...overrides },
          dir,
        ))

    /** `personas[i]` plus the b.av2 SR-2.2 reference (JSON-quoted name with its key). */
    const indexedRef = (index: number, name: string) =>
      `personas[${index}] ${JSON.stringify(name)} (key=${personaKey(name)})`

    interface RejectionRow {
      ac: string
      label: string
      /** The offending personas by array position; the error names each and no other persona. */
      offenders: [number, string][]
      /** The offending settings or channel, shown in the title and named by the error. */
      settings: string[]
      /** Builds the personas (creating any files) and the further values the error must name. */
      build: () => { personas: PersonaInput[]; named?: string[] }
    }

    const rejectionRows: RejectionRow[] = [
      // Per-entry rows (Task 2)
      {
        ac: '33',
        label: 'missing permission_prompts',
        offenders: [[0, 'Ops Bot']],
        settings: ['permission_prompts'],
        build: () => ({ personas: [makePersona({ name: 'Ops Bot', permission_prompts: undefined }, dir)] }),
      },
      {
        ac: '30',
        label: 'permission_prompts dm without dm.contact',
        offenders: [[0, 'Say "hi" Bot']],
        settings: ['permission_prompts', 'dm.contact'],
        build: () => ({
          personas: [makePersona({ name: 'Say "hi" Bot', dm: { enabled: true }, permission_prompts: 'dm' }, dir)],
        }),
      },
      {
        ac: '32',
        label: 'destination channel not in the persona channels',
        offenders: [[0, 'Ops Bot']],
        settings: ['permission_prompts', 'C0TEST999'],
        build: () => ({ personas: [makePersona({ name: 'Ops Bot', permission_prompts: 'C0TEST999' }, dir)] }),
      },
      {
        ac: '42',
        label: 'zero channels with dm.enabled false',
        offenders: [[0, 'ops_bot']],
        settings: ['dm.enabled'],
        build: () => ({ personas: [makePersona({ name: 'ops_bot', channels: [], dm: { enabled: false } }, dir)] }),
      },
      {
        ac: '42',
        label: 'zero channels with dm absent',
        offenders: [[0, 'Ops Bot']],
        settings: ['dm.enabled'],
        build: () => ({ personas: [makePersona({ name: 'Ops Bot', channels: undefined, dm: undefined }, dir)] }),
      },
      {
        ac: '43',
        label: 'dm destination with dm.enabled false',
        offenders: [[0, 'Ops Bot']],
        settings: ['permission_prompts', 'dm.enabled'],
        build: () => ({
          personas: [makePersona({ name: 'Ops Bot', dm: { enabled: false, contact: 'U0TEST001' }, permission_prompts: 'dm' }, dir)],
        }),
      },
      {
        ac: '30 + 43',
        label: 'dm destination with neither dm.enabled nor dm.contact',
        offenders: [[0, 'Ops Bot']],
        settings: ['permission_prompts', 'dm.contact', 'dm.enabled'],
        build: () => ({ personas: [makePersona({ name: 'Ops Bot', permission_prompts: 'dm' }, dir)] }),
      },
      // Cross-persona rows: name and key
      {
        ac: '53',
        label: 'the same name twice',
        offenders: [[0, 'Ops Bot'], [1, 'Ops Bot']],
        settings: ['name'],
        build: () => ({ personas: personasOf(['Ops Bot'], ['Ops Bot']), named: [`name ${JSON.stringify('Ops Bot')}`] }),
      },
      {
        ac: '53',
        label: "an in-form name equal to another persona's derived key",
        offenders: [[0, 'Ops Bot'], [1, OPS_KEY]],
        settings: ['key'],
        build: () => ({ personas: personasOf(['Ops Bot'], [OPS_KEY]), named: [`key ${OPS_KEY}`] }),
      },
      {
        ac: '53',
        label: "a later name equal to an earlier persona's long key (names and keys differ)",
        offenders: [[0, LONG_NAME], [1, LONG_KEY]],
        settings: ['name'],
        build: () => ({ personas: personasOf([LONG_NAME], [LONG_KEY]), named: [`name ${JSON.stringify(LONG_KEY)}`] }),
      },
      {
        ac: '53',
        label: "a later persona's long key equal to an earlier name (names and keys differ)",
        offenders: [[0, LONG_KEY], [1, LONG_NAME]],
        settings: ['key'],
        build: () => ({ personas: personasOf([LONG_KEY], [LONG_NAME]), named: [`key ${LONG_KEY}`] }),
      },
      {
        ac: '53',
        label: 'the same name on the second and third of three personas (the first distinct)',
        offenders: [[1, 'review_bot'], [2, 'review_bot']],
        settings: ['name'],
        build: () => ({
          personas: personasOf(['Ops Bot'], ['review_bot'], ['review_bot']),
          named: [`name ${JSON.stringify('review_bot')}`],
        }),
      },
      {
        ac: '53',
        label: 'the same key on the second and third of three personas (the first distinct)',
        offenders: [[1, 'Ops Bot'], [2, OPS_KEY]],
        settings: ['key'],
        build: () => ({ personas: personasOf(['deploy_bot'], ['Ops Bot'], [OPS_KEY]), named: [`key ${OPS_KEY}`] }),
      },
      // Cross-persona rows: credentials_file
      {
        ac: '53',
        label: 'the same literal path',
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['credentials_file'],
        build: () => {
          const shared = inDir('shared/credentials.json')
          return {
            personas: personasOf(['Ops Bot', { credentials_file: shared }], ['review_bot', { credentials_file: shared }]),
            named: [JSON.stringify(shared)],
          }
        },
      },
      {
        ac: '53',
        label: 'a ~/ form against its expansion under the injected home',
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['credentials_file'],
        build: () => {
          const expanded = join(home, 'creds', 'ops.json')
          return {
            personas: personasOf(
              ['Ops Bot', { credentials_file: '~/creds/ops.json' }],
              ['review_bot', { credentials_file: expanded }],
            ),
            named: [JSON.stringify(expanded)],
          }
        },
      },
      {
        ac: '53',
        label: "a symlink to the other persona's existing file",
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['credentials_file'],
        build: () => {
          const target = makeCredentials('ops-credentials.json')
          const link = makeLink(target, 'review-credentials.json')
          return {
            personas: personasOf(['Ops Bot', { credentials_file: target }], ['review_bot', { credentials_file: link }]),
            named: [target, link, realpathSync(target)].map((path) => JSON.stringify(path)),
          }
        },
      },
      {
        ac: '53',
        label: 'the second and the third of three personas (the first distinct)',
        offenders: [[1, 'review_bot'], [2, 'deploy_bot']],
        settings: ['credentials_file'],
        build: () => {
          const shared = inDir('shared/credentials.json')
          return {
            personas: personasOf(
              ['Ops Bot'],
              ['review_bot', { credentials_file: shared }],
              ['deploy_bot', { credentials_file: shared }],
            ),
            named: [JSON.stringify(shared)],
          }
        },
      },
      // Cross-persona rows: working_directory
      {
        ac: '21',
        label: 'the same literal path',
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['working_directory'],
        build: () => {
          const shared = inDir('shared-work')
          return {
            personas: personasOf(['Ops Bot', { working_directory: shared }], ['review_bot', { working_directory: shared }]),
            named: [JSON.stringify(shared)],
          }
        },
      },
      {
        ac: '21',
        label: 'a trailing-slash spelling of the same non-existent path',
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['working_directory'],
        build: () => {
          const work = inDir('work')
          return {
            personas: personasOf(['Ops Bot', { working_directory: work }], ['review_bot', { working_directory: `${work}/` }]),
            named: [JSON.stringify(work)],
          }
        },
      },
      {
        ac: '21',
        label: "a symlink to the other persona's existing directory, reached through a symlinked parent",
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['working_directory'],
        build: () => {
          // Three distinct spellings: the configured path of each persona and the shared real path.
          const target = makeDir('real/ops-work')
          const viaParent = join(makeLink(inDir('real'), 'real-link'), 'ops-work')
          const link = makeLink(target, 'review-work')
          return {
            personas: personasOf(['Ops Bot', { working_directory: viaParent }], ['review_bot', { working_directory: link }]),
            named: [viaParent, link, realpathSync(target)].map((path) => JSON.stringify(path)),
          }
        },
      },
      {
        ac: '21',
        label: 'the first and the third of three personas',
        offenders: [[0, 'Ops Bot'], [2, 'deploy_bot']],
        settings: ['working_directory'],
        build: () => {
          const shared = inDir('shared-work')
          return {
            personas: personasOf(
              ['Ops Bot', { working_directory: shared }],
              ['review_bot'],
              ['deploy_bot', { working_directory: shared }],
            ),
            named: [JSON.stringify(shared)],
          }
        },
      },
      {
        ac: '21',
        label: 'the second and the third of three personas (the first distinct)',
        offenders: [[1, 'review_bot'], [2, 'deploy_bot']],
        settings: ['working_directory'],
        build: () => {
          const shared = inDir('shared-work')
          return {
            personas: personasOf(
              ['Ops Bot'],
              ['review_bot', { working_directory: shared }],
              ['deploy_bot', { working_directory: shared }],
            ),
            named: [JSON.stringify(shared)],
          }
        },
      },
    ]

    test.each(
      rejectionRows.map((row) => ({
        ...row,
        who: row.offenders.map(([, name]) => JSON.stringify(name)).join(' and '),
        setting: row.settings.join(', '),
      })),
    )('AC $ac: $who, $setting: $label', ({ offenders, settings, build }) => {
      const { personas, named = [] } = build()
      const message = loadError(withPersonas(...personas))
      for (const [index, name] of offenders) expect(message).toContain(indexedRef(index, name))
      personas.forEach((_, i) => {
        if (!offenders.some(([index]) => index === i)) expect(message).not.toContain(`personas[${i}]`)
      })
      for (const value of [...settings, ...named]) expect(message).toContain(value)
      expect(message).not.toMatch(TOKEN_LIKE)
    })

    test.each([
      [
        'different existing working directories and credentials files',
        () =>
          personasOf(
            ['Ops Bot', { working_directory: makeDir('ops-work'), credentials_file: makeCredentials('ops.json') }],
            ['review_bot', { working_directory: makeDir('review-work'), credentials_file: makeCredentials('review.json') }],
          ),
      ],
      [
        "a symlink to a directory other than the other persona's",
        () =>
          personasOf(
            ['Ops Bot', { working_directory: makeDir('ops-work') }],
            ['review_bot', { working_directory: makeLink(makeDir('elsewhere'), 'review-work') }],
          ),
      ],
      ['two distinct non-existent paths per setting', () => personasOf(['Ops Bot'], ['review_bot'])],
      ['names normalising to the same stem with different keys', () => personasOf(['Ops Bot'], ['OPS BOT'])],
      [
        "one persona's working_directory equal to another's credentials_file",
        () =>
          personasOf(
            ['Ops Bot', { working_directory: inDir('shared') }],
            ['review_bot', { credentials_file: inDir('shared') }],
          ),
      ],
    ])('non-collision control loads: %s', (_label, build) => {
      const personas = build()
      const config = load(withPersonas(...personas))
      assertNoLeak(config, 'config')
      expect(config.personas.map((p) => p.name)).toEqual(personas.map((p) => p.name))
    })

    test.each([
      {
        label: 'of two per-entry violations, the first persona',
        build: () => [
          makePersona({ name: 'first_bot', permission_prompts: undefined }, dir),
          makePersona({ name: 'second_bot', channels: [] }, dir),
        ],
        reported: [[0, 'first_bot']] as [number, string][],
        named: 'permission_prompts',
        absent: ['second_bot'],
      },
      {
        label: 'a later per-entry violation before an earlier duplicate name',
        build: () => personasOf(['Ops Bot'], ['Ops Bot'], ['third_bot', { permission_prompts: undefined }]),
        reported: [[2, 'third_bot']] as [number, string][],
        named: 'permission_prompts',
        absent: ['"Ops Bot"', 'duplicated'],
      },
      {
        label: 'a later duplicate name before an earlier duplicate working_directory',
        build: () =>
          personasOf(
            ['Ops Bot', { working_directory: inDir('shared-work') }],
            ['review_bot', { working_directory: inDir('shared-work') }],
            ['Ops Bot'],
          ),
        reported: [[0, 'Ops Bot'], [2, 'Ops Bot']] as [number, string][],
        named: `name ${JSON.stringify('Ops Bot')}`,
        absent: ['working_directory', 'personas[1]'],
      },
      {
        label: 'a later duplicate working_directory before an earlier duplicate credentials_file',
        build: () =>
          personasOf(
            ['Ops Bot', { credentials_file: inDir('shared.json') }],
            ['review_bot', { credentials_file: inDir('shared.json') }],
            ['deploy_bot', { working_directory: inDir('p0/work') }],
          ),
        reported: [[0, 'Ops Bot'], [2, 'deploy_bot']] as [number, string][],
        named: 'working_directory',
        absent: ['credentials_file', 'personas[1]'],
      },
    ])('only the first violation is reported: $label', ({ build, reported, named, absent }) => {
      const message = loadError(withPersonas(...build()))
      for (const [index, name] of reported) expect(message).toContain(indexedRef(index, name))
      expect(message).toContain(named)
      for (const fragment of absent) expect(message).not.toContain(fragment)
    })

    test('resolvePersonaConfig rejects a symlinked working_directory duplicate as the loader does', () => {
      const target = makeDir('ops-work')
      const input = withPersonas(...personasOf(
        ['Ops Bot', { working_directory: target }],
        ['review_bot', { working_directory: makeLink(target, 'review-work') }],
      ))
      let pure = ''
      try {
        resolvePersonaConfig(input, dir, home)
      } catch (err) {
        assertNoLeak(err, 'rejection')
        pure = (err as Error).message
      }
      expect(pure).toContain(`${indexedRef(1, 'review_bot')}: working_directory`)
      expect(pure).toContain(indexedRef(0, 'Ops Bot'))
      expect(loadError(input)).toContain(pure)
    })
  })

  describe('server-wide settings (SR-1.6)', () => {
    // Defaults when absent are pinned by 'the default input resolves to the
    // makePersonaConfig shape' above.
    test('every server-wide key accepts a valid non-default value, ~ paths expanded under the injected home', () => {
      const values = {
        bind: '0.0.0.0',
        port: 8080,
        session_restart_delay: 5,
        health_check_interval: 30,
        exit_timeout: 10,
        stop_timeout: 5,
        mcp_config_path: '~/mcp.json',
        append_system_prompt_file: '~/prompt.md',
        cozempic_prescription: 'aggressive',
        system_prompt_mode: 'none',
        message_archive_db: '~/archive.db',
        claude_config_dir: '~/cfg',
        resume_enabled: false,
        agent_director_poll_interval_ms: 250,
        stop_hook_bootstrap: false,
        cron_table_path: '~/cron/crontab',
        cron_log_path: '~/cron/cron.log',
        cron_log_max_bytes: 1024,
        ack_reaction: 'eyes',
        reply_chunk_limit: 12000,
        reply_chunk_mode: 'length',
      } satisfies Omit<Required<PersonaConfigInput>, 'personas'>
      const underHome = (path: string) => join(home, path.slice(2))
      expect(load(makePersonaConfigInput(values))).toMatchObject({
        ...values,
        mcp_config_path: underHome(values.mcp_config_path),
        append_system_prompt_file: underHome(values.append_system_prompt_file),
        message_archive_db: underHome(values.message_archive_db),
        claude_config_dir: underHome(values.claude_config_dir),
        cron_table_path: underHome(values.cron_table_path),
        cron_log_path: underHome(values.cron_log_path),
      })
    })

    test.each([
      ['cozempic_prescription', PLACEHOLDER, 'cozempic_prescription'],
      ['system_prompt_mode', PLACEHOLDER, 'system_prompt_mode'],
      ['stop_hook_bootstrap', PLACEHOLDER, 'stop_hook_bootstrap'],
      ['mcp_config_path', 42, 'mcp_config_path'],
      ['claude_config_dir', '   ', 'claude_config_dir'],
      ['session_restart_delay', -1, 'session_restart_delay'],
      ['agent_director_poll_interval_ms', 50, 'agent_director_poll_interval_ms'],
      ['cron_log_max_bytes', 0, 'cron_log_max_bytes'],
      ['claude_director_poll_interval_ms', 1000, 'agent_director_poll_interval_ms'],
      ['ack_reaction', '', 'ack_reaction'],
      ['reply_chunk_limit', 0, 'reply_chunk_limit'],
      ['reply_chunk_limit', -5, 'reply_chunk_limit'],
      ['reply_chunk_limit', 2.5, 'reply_chunk_limit'],
      ['reply_chunk_mode', PLACEHOLDER, 'reply_chunk_mode'],
    ])('%s = %p is rejected, naming %s', (key, value, named) => {
      expect(loadError({ ...makePersonaConfigInput({}, dir), [key]: value })).toContain(named)
    })
  })

  describe('pre-persona rejection (SR-1.7 loader part; AC 45)', () => {
    /**
     * Load `input`, returning the error message plus proof that the file and
     * directory are untouched and that the error passes `assertNoLeak`.
     */
    function rejectUntouched(input: unknown): string {
      const path = writeConfigFile(dir, input)
      const bytes = readFileSync(path)
      const listing = readdirSync(dir)
      let error: Error | undefined
      try {
        loadPersonaConfig(path, home)
      } catch (err) {
        error = err as Error
      }
      expect(readFileSync(path).equals(bytes)).toBe(true)
      expect(readdirSync(dir)).toEqual(listing)
      if (error === undefined) throw new Error('expected loadPersonaConfig to reject the configuration')
      assertNoLeak(error, 'rejection')
      return error.message
    }

    test.each([
      ['routes as a populated object', 'routes', { C0TEST001: { cwd: '/tmp/ops' } }],
      ['routes as an empty object', 'routes', {}],
      ['routes as an array', 'routes', []],
      ['routes as a non-object', 'routes', 'none'],
      ['routes as null', 'routes', null],
      ['default_route', 'default_route', '/tmp/ops'],
      ['default_dm_session', 'default_dm_session', '/tmp/ops'],
    ])('%s is rejected with the conversion message; the file is unchanged', (_label, key, value) => {
      const message = rejectUntouched({ ...makePersonaConfigInput({}, dir), [key]: value })
      expect(message).toContain(prePersonaConversionMessage(key))
      expect(message).toContain(JSON.stringify(key))
      expect(message).toContain('must be converted to personas')
    })

    test.each([
      ['a missing personas', { routes: {} }],
      ['an unknown top-level key', { ...makePersonaConfigInput(), default_route: '/tmp/ops', extra_setting: 1 }],
      ['an invalid persona', { personas: [makePersona({ permission_prompts: undefined })], default_dm_session: '/tmp/ops' }],
    ])('the conversion message wins over %s', (_label, input) => {
      const message = rejectUntouched(input)
      expect(message).toContain('must be converted to personas')
      expect(message).not.toContain('extra_setting')
      expect(message).not.toContain('permission_prompts')
    })
  })

  describe('loader I/O errors', () => {
    test.each([
      ['a missing file', (d: string) => join(d, 'absent.json'), 'cannot read'],
      [
        'malformed JSON',
        (d: string) => {
          const path = join(d, 'config.json')
          writeFileSync(path, `{ "personas": [ ${PLACEHOLDER}`, 'utf-8')
          return path
        },
        'malformed JSON',
      ],
      [
        'malformed JSON holding a pasted token',
        (d: string) => {
          const path = join(d, 'config.json')
          writeFileSync(path, `{ "personas": [], "bot_token": "${fakeToken(BOT_TOKEN_PREFIX)}" ${PLACEHOLDER}`, 'utf-8')
          return path
        },
        'malformed JSON',
      ],
      ['a JSON array', (d: string) => writeConfigFile(d, []), 'must be a JSON object'],
    ])('%s is rejected, naming the file path', (_label, setup, fragment) => {
      const path = setup(dir)
      let message = ''
      try {
        loadPersonaConfig(path, home)
      } catch (err) {
        assertNoLeak(err, 'rejection')
        message = (err as Error).message
      }
      expect(message).toContain(fragment)
      expect(message).toContain(path)
      expect(message).not.toContain(PLACEHOLDER)
      expect(message).not.toContain('JSON Parse error')
    })
  })
})
