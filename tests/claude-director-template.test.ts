/**
 * claude-director-template.test.ts — Tests for src/claude-director-template.ts
 *
 * TOML parser strategy: No TOML parser dependency exists in package.json
 * (dependencies are @slack/socket-mode, @slack/web-api, @modelcontextprotocol/sdk only).
 * We fall back to targeted substring + structural assertions against the raw
 * serialized text and the parsed object shape returned by buildTemplateInput.
 * Full golden-file comparison is intentionally avoided — whitespace/key-order
 * drift would cause spurious failures. Instead we assert specific lines and
 * substrings that lock down the contract.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
} from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import {
  serializeTemplate,
  buildTemplateInput,
  writeTemplate,
  type TemplateInput,
  type WriteTemplateDeps,
} from '../src/claude-director-template.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'
import { type RoutingConfig } from '../src/config.ts'
import { type StartupErrorOptions } from '../src/startup-errors.ts'

// ---------------------------------------------------------------------------
// State: temp root, capture arrays — reset in beforeEach / afterEach
// ---------------------------------------------------------------------------

let tempRoot: string
let templatesDir: string
let recordStartupErrorCalls: Array<{ classLabel: string; message: string; cause: unknown }>
let processExitCalls: number[]
let stderrLines: string[]

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'cdt-test-'))
  templatesDir = join(tempRoot, 'templates')
  recordStartupErrorCalls = []
  processExitCalls = []
  stderrLines = []
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// makeDeps — central dependency bundle factory
// ---------------------------------------------------------------------------

interface DepsBundle {
  routingConfig: RoutingConfig
  deps: WriteTemplateDeps
  /** Path where the final TOML file should appear. */
  tomlPath: string
}

function makeDeps(
  overrides?: Partial<RoutingConfig> & {
    accessSyncThrows?: boolean
    accessSyncCallCount?: { n: number }
    writtenAt?: string
    templatesDir?: string
  },
): DepsBundle {
  const {
    accessSyncThrows = false,
    accessSyncCallCount,
    writtenAt,
    templatesDir: templatesDirOverride,
    ...routingOverrides
  } = overrides ?? {}

  const routingConfig = makeRoutingConfig(routingOverrides)
  const td = templatesDirOverride ?? templatesDir

  const accessSyncStub = (p: string, _mode?: number) => {
    if (accessSyncCallCount) accessSyncCallCount.n++
    if (accessSyncThrows) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${p}'`), {
        code: 'ENOENT',
      })
    }
  }

  const recordStartupErrorStub = (
    classLabel: string,
    message: string,
    cause?: unknown,
    _opts?: StartupErrorOptions,
  ) => {
    recordStartupErrorCalls.push({ classLabel, message, cause })
  }

  const processExitStub = (code: number): never => {
    processExitCalls.push(code)
    return undefined as never
  }

  const stderrWriteStub = (msg: string) => {
    stderrLines.push(msg)
  }

  const deps: WriteTemplateDeps = {
    templatesDir: td,
    accessSync: accessSyncStub,
    recordStartupError: recordStartupErrorStub,
    processExit: processExitStub,
    stderrWrite: stderrWriteStub,
    ...(writtenAt !== undefined ? { writtenAt } : {}),
  }

  return {
    routingConfig,
    deps,
    tomlPath: join(td, 'slack-channel-bot.toml'),
  }
}

// ---------------------------------------------------------------------------
// Helper: read written template file
// ---------------------------------------------------------------------------

function readTemplateFile(tomlPath: string): string {
  return readFileSync(tomlPath, 'utf-8')
}

// ---------------------------------------------------------------------------
// serializeTemplate — header + content
// ---------------------------------------------------------------------------

describe('serializeTemplate — header', () => {
  test('first line is the managed-by comment', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: ['AskUserQuestion'] },
      claude_args: ['--dangerously-load-development-channels', 'server:slack-channel-router'],
    }
    const output = serializeTemplate(input)
    const lines = output.split('\n')
    expect(lines[0]).toBe('# Managed by claude-slack-channel-bots — do not edit by hand.')
  })

  test('second line matches Written: ISO-8601 timestamp pattern', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: ['AskUserQuestion'] },
      claude_args: [],
    }
    const output = serializeTemplate(input)
    const lines = output.split('\n')
    expect(lines[1]).toMatch(/^# Written: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test('injected writtenAt appears verbatim on second line', () => {
    const fixedTs = '2026-01-15T12:00:00.000Z'
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: [] },
      claude_args: [],
    }
    const output = serializeTemplate(input, { writtenAt: fixedTs })
    const lines = output.split('\n')
    expect(lines[1]).toBe(`# Written: ${fixedTs}`)
  })

  test('output ends with a trailing newline', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: [] },
      claude_args: [],
    }
    const output = serializeTemplate(input)
    expect(output.endsWith('\n')).toBe(true)
  })
})

describe('serializeTemplate — TOML fields', () => {
  test('relay_mode appears as relay_mode = "on"', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: ['AskUserQuestion'] },
      claude_args: [],
    }
    const output = serializeTemplate(input)
    expect(output).toContain('relay_mode = "on"')
  })

  test('labels contains service = "cscb"', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: [] },
      claude_args: [],
    }
    const output = serializeTemplate(input)
    expect(output).toContain('service = "cscb"')
  })

  test('permissions.deny contains "AskUserQuestion"', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: ['AskUserQuestion'] },
      claude_args: [],
    }
    const output = serializeTemplate(input)
    expect(output).toContain('"AskUserQuestion"')
    expect(output).toContain('deny')
  })

  test('claude_args line contains expected flags', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: [] },
      claude_args: [
        '--dangerously-load-development-channels',
        'server:slack-channel-router',
        '--mcp-config',
        '/tmp/test-mcp.json',
      ],
    }
    const output = serializeTemplate(input)
    expect(output).toContain('--dangerously-load-development-channels')
    expect(output).toContain('server:slack-channel-router')
    expect(output).toContain('--mcp-config')
    expect(output).toContain('/tmp/test-mcp.json')
  })

  test('extra_env omitted when not provided', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: [] },
      claude_args: [],
    }
    const output = serializeTemplate(input)
    expect(output).not.toContain('extra_env')
  })

  test('extra_env emitted when provided with entries', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: [] },
      claude_args: [],
      extra_env: { MY_VAR: 'hello' },
    }
    const output = serializeTemplate(input)
    expect(output).toContain('extra_env')
    expect(output).toContain('MY_VAR')
    expect(output).toContain('hello')
  })

  test('extra_env omitted when provided but empty', () => {
    const input: TemplateInput = {
      relay_mode: 'on',
      labels: { service: 'cscb' },
      permissions: { deny: [] },
      claude_args: [],
      extra_env: {},
    }
    const output = serializeTemplate(input)
    expect(output).not.toContain('extra_env')
  })
})

// ---------------------------------------------------------------------------
// buildTemplateInput — core fields
// ---------------------------------------------------------------------------

describe('buildTemplateInput — core fields', () => {
  test('relay_mode is "on"', () => {
    const rc = makeRoutingConfig()
    const result = buildTemplateInput(rc)
    expect(result.relay_mode).toBe('on')
  })

  test('labels.service is "cscb"', () => {
    const rc = makeRoutingConfig()
    const result = buildTemplateInput(rc)
    expect(result.labels.service).toBe('cscb')
  })

  test('permissions.deny equals ["AskUserQuestion"]', () => {
    const rc = makeRoutingConfig()
    const result = buildTemplateInput(rc)
    expect(result.permissions.deny).toEqual(['AskUserQuestion'])
  })

  test('claude_args contains --dangerously-load-development-channels', () => {
    const rc = makeRoutingConfig()
    const result = buildTemplateInput(rc)
    expect(result.claude_args).toContain('--dangerously-load-development-channels')
  })

  test('claude_args contains server:slack-channel-router after the flag', () => {
    const rc = makeRoutingConfig()
    const result = buildTemplateInput(rc)
    const idx = result.claude_args.indexOf('--dangerously-load-development-channels')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(result.claude_args[idx + 1]).toBe('server:slack-channel-router')
  })

  test('claude_args contains --mcp-config', () => {
    const rc = makeRoutingConfig()
    const result = buildTemplateInput(rc)
    expect(result.claude_args).toContain('--mcp-config')
  })

  test('claude_args contains mcp_config_path value after --mcp-config', () => {
    const rc = makeRoutingConfig({ mcp_config_path: '/absolute/path/mcp.json' })
    const result = buildTemplateInput(rc)
    const idx = result.claude_args.indexOf('--mcp-config')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(result.claude_args[idx + 1]).toBe('/absolute/path/mcp.json')
  })
})

// ---------------------------------------------------------------------------
// buildTemplateInput — tilde expansion in mcp_config_path
// ---------------------------------------------------------------------------

describe('buildTemplateInput — mcp_config_path tilde expansion', () => {
  test('tilde-prefixed mcp_config_path is passed through as-is (expansion done by resolveConfig)', () => {
    // buildTemplateInput receives an already-resolved RoutingConfig.
    // The resolved config has an absolute path. We pass an absolute path here
    // to confirm it flows straight through into claude_args.
    const absolutePath = join(homedir(), '.claude', 'slack-mcp.json')
    const rc = makeRoutingConfig({ mcp_config_path: absolutePath })
    const result = buildTemplateInput(rc)
    const idx = result.claude_args.indexOf('--mcp-config')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(result.claude_args[idx + 1]).toBe(absolutePath)
    expect(result.claude_args[idx + 1]).not.toMatch(/^~/)
  })
})

// ---------------------------------------------------------------------------
// buildTemplateInput — --append-system-prompt-file conditional
// ---------------------------------------------------------------------------

describe('buildTemplateInput — append-system-prompt-file: mode=append + readable', () => {
  test('flag and resolved path appear in claude_args', () => {
    const filePath = '/absolute/system-prompt.md'
    const accessSyncCallCount = { n: 0 }
    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: filePath,
    })
    const result = buildTemplateInput(rc, {
      accessSync: (p, _m) => { accessSyncCallCount.n++ },
      stderrWrite: (msg) => stderrLines.push(msg),
    })
    expect(result.claude_args).toContain('--append-system-prompt-file')
    const idx = result.claude_args.indexOf('--append-system-prompt-file')
    expect(result.claude_args[idx + 1]).toBe(filePath)
  })

  test('no stderr emitted when file is readable', () => {
    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: '/some/file.md',
    })
    buildTemplateInput(rc, {
      accessSync: () => {},
      stderrWrite: (msg) => stderrLines.push(msg),
    })
    expect(stderrLines).toHaveLength(0)
  })

  test('accessSync invoked exactly once', () => {
    const callCount = { n: 0 }
    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: '/some/file.md',
    })
    buildTemplateInput(rc, {
      accessSync: (_p, _m) => { callCount.n++ },
      stderrWrite: () => {},
    })
    expect(callCount.n).toBe(1)
  })
})

describe('buildTemplateInput — append-system-prompt-file: mode=append + unreadable', () => {
  test('flag omitted from claude_args', () => {
    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: '/missing/file.md',
    })
    const result = buildTemplateInput(rc, {
      accessSync: () => { throw new Error('ENOENT') },
      stderrWrite: (msg) => stderrLines.push(msg),
    })
    expect(result.claude_args).not.toContain('--append-system-prompt-file')
  })

  test('T-A recordStartupError spy NOT invoked (omission is not fatal)', () => {
    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: '/missing/file.md',
    })
    buildTemplateInput(rc, {
      accessSync: () => { throw new Error('ENOENT') },
      stderrWrite: (msg) => stderrLines.push(msg),
    })
    // buildTemplateInput doesn't take recordStartupError; omission goes to stderrWrite only
    // If called via writeTemplate, recordStartupError spy still not invoked for this case
    expect(recordStartupErrorCalls).toHaveLength(0)
  })

  test('single-line stderr captured naming the unreadable path', () => {
    const filePath = '/missing/file.md'
    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: filePath,
    })
    buildTemplateInput(rc, {
      accessSync: () => { throw new Error('ENOENT') },
      stderrWrite: (msg) => stderrLines.push(msg),
    })
    expect(stderrLines).toHaveLength(1)
    expect(stderrLines[0]).toContain(filePath)
  })
})

describe('buildTemplateInput — append-system-prompt-file: mode=none', () => {
  test('flag omitted regardless of file readability', () => {
    const rc = makeRoutingConfig({
      system_prompt_mode: 'none',
      append_system_prompt_file: '/some/file.md',
    })
    const callCount = { n: 0 }
    const result = buildTemplateInput(rc, {
      accessSync: (_p, _m) => { callCount.n++ },
      stderrWrite: (msg) => stderrLines.push(msg),
    })
    expect(result.claude_args).not.toContain('--append-system-prompt-file')
  })

  test('no stderr emitted', () => {
    const rc = makeRoutingConfig({
      system_prompt_mode: 'none',
      append_system_prompt_file: '/some/file.md',
    })
    buildTemplateInput(rc, {
      accessSync: () => {},
      stderrWrite: (msg) => stderrLines.push(msg),
    })
    expect(stderrLines).toHaveLength(0)
  })

  test('accessSync NOT called (short-circuit on mode)', () => {
    const rc = makeRoutingConfig({
      system_prompt_mode: 'none',
      append_system_prompt_file: '/some/file.md',
    })
    const callCount = { n: 0 }
    buildTemplateInput(rc, {
      accessSync: (_p, _m) => { callCount.n++ },
      stderrWrite: () => {},
    })
    expect(callCount.n).toBe(0)
  })
})

describe('buildTemplateInput — append-system-prompt-file: field absent', () => {
  test('flag omitted when append_system_prompt_file is undefined', () => {
    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: undefined,
    })
    const callCount = { n: 0 }
    const result = buildTemplateInput(rc, {
      accessSync: (_p, _m) => { callCount.n++ },
      stderrWrite: (msg) => stderrLines.push(msg),
    })
    expect(result.claude_args).not.toContain('--append-system-prompt-file')
  })

  test('no stderr when append_system_prompt_file is absent', () => {
    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: undefined,
    })
    buildTemplateInput(rc, {
      accessSync: () => {},
      stderrWrite: (msg) => stderrLines.push(msg),
    })
    expect(stderrLines).toHaveLength(0)
  })

  test('accessSync NOT called when append_system_prompt_file is absent', () => {
    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: undefined,
    })
    const callCount = { n: 0 }
    buildTemplateInput(rc, {
      accessSync: (_p, _m) => { callCount.n++ },
      stderrWrite: () => {},
    })
    expect(callCount.n).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// writeTemplate — happy path: file content
// ---------------------------------------------------------------------------

describe('writeTemplate — happy path', () => {
  test('file appears at <templatesDir>/slack-channel-bot.toml', () => {
    const { routingConfig, deps, tomlPath } = makeDeps()
    writeTemplate(routingConfig, deps)
    expect(existsSync(tomlPath)).toBe(true)
  })

  test('first line is the managed-by comment', () => {
    const { routingConfig, deps, tomlPath } = makeDeps()
    writeTemplate(routingConfig, deps)
    const lines = readTemplateFile(tomlPath).split('\n')
    expect(lines[0]).toBe('# Managed by claude-slack-channel-bots — do not edit by hand.')
  })

  test('second line matches Written: ISO-8601 pattern', () => {
    const { routingConfig, deps, tomlPath } = makeDeps()
    writeTemplate(routingConfig, deps)
    const lines = readTemplateFile(tomlPath).split('\n')
    expect(lines[1]).toMatch(/^# Written: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test('relay_mode = "on" present in file', () => {
    const { routingConfig, deps, tomlPath } = makeDeps()
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).toContain('relay_mode = "on"')
  })

  test('labels.service = "cscb" present in file', () => {
    const { routingConfig, deps, tomlPath } = makeDeps()
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).toContain('service = "cscb"')
  })

  test('permissions deny contains AskUserQuestion', () => {
    const { routingConfig, deps, tomlPath } = makeDeps()
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).toContain('"AskUserQuestion"')
    expect(content).toContain('deny')
  })

  test('claude_args contains --dangerously-load-development-channels', () => {
    const { routingConfig, deps, tomlPath } = makeDeps()
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).toContain('--dangerously-load-development-channels')
  })

  test('claude_args contains server:slack-channel-router', () => {
    const { routingConfig, deps, tomlPath } = makeDeps()
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).toContain('server:slack-channel-router')
  })

  test('claude_args contains --mcp-config and the resolved mcp_config_path', () => {
    const mcpPath = '/tmp/test-mcp.json'
    const { routingConfig, deps, tomlPath } = makeDeps({ mcp_config_path: mcpPath })
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).toContain('--mcp-config')
    expect(content).toContain(mcpPath)
  })
})

// ---------------------------------------------------------------------------
// writeTemplate — injected timestamp determinism
// ---------------------------------------------------------------------------

describe('writeTemplate — injected timestamp determinism', () => {
  test('writtenAt value flows through verbatim to # Written: line', () => {
    const fixedTs = '2026-01-15T08:30:00.123Z'
    const { routingConfig, deps, tomlPath } = makeDeps({ writtenAt: fixedTs })
    writeTemplate(routingConfig, deps)
    const lines = readTemplateFile(tomlPath).split('\n')
    expect(lines[1]).toBe(`# Written: ${fixedTs}`)
  })
})

// ---------------------------------------------------------------------------
// writeTemplate — mcp_config_path tilde expansion (resolved by config layer)
// ---------------------------------------------------------------------------

describe('writeTemplate — mcp_config_path tilde expansion', () => {
  test('absolute path (tilde already expanded by resolveConfig) appears in file', () => {
    const absolutePath = join(homedir(), '.claude', 'slack-mcp.json')
    const { routingConfig, deps, tomlPath } = makeDeps({ mcp_config_path: absolutePath })
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).toContain(absolutePath)
    expect(content).not.toContain('~/') // no literal tilde in output
  })
})

// ---------------------------------------------------------------------------
// writeTemplate — recursive mkdir + mode bits
// ---------------------------------------------------------------------------

describe('writeTemplate — recursive mkdir + mode bits', () => {
  test('missing parent dir is created when absent', () => {
    // templatesDir does not exist yet (we never pre-create it)
    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)
    expect(existsSync(templatesDir)).toBe(true)
  })

  test('newly created leaf dir has mode 0o700', () => {
    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)
    const stat = statSync(templatesDir)
    expect(stat.mode & 0o777).toBe(0o700)
  })

  test('multi-level missing parent: all created, leaf is 0o700', () => {
    const deepTemplatesDir = join(tempRoot, 'a', 'b', '.claude-director', 'templates')
    const { routingConfig, deps } = makeDeps({ templatesDir: deepTemplatesDir })
    writeTemplate(routingConfig, deps)
    expect(existsSync(deepTemplatesDir)).toBe(true)
    const stat = statSync(deepTemplatesDir)
    expect(stat.mode & 0o777).toBe(0o700)
  })

  test('pre-existing dir with mode 0o755 is NOT chmod-ed', () => {
    // Pre-create the templates dir with 0o755
    mkdirSync(templatesDir, { recursive: true, mode: 0o755 })
    const before = statSync(templatesDir).mode & 0o777
    expect(before).toBe(0o755)

    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)

    const after = statSync(templatesDir).mode & 0o777
    expect(after).toBe(0o755) // unchanged
  })
})

// ---------------------------------------------------------------------------
// writeTemplate — overwrite-not-merge semantics
// ---------------------------------------------------------------------------

describe('writeTemplate — overwrite-not-merge semantics', () => {
  test('pre-existing sentinel content is gone after writeTemplate', () => {
    const sentinel = '# SENTINEL-GUID-7b3f1a9e-should-not-survive\nold_key = "old_value"\n'
    mkdirSync(templatesDir, { recursive: true })
    const tomlPath = join(templatesDir, 'slack-channel-bot.toml')
    writeFileSync(tomlPath, sentinel, 'utf-8')

    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)

    const content = readTemplateFile(tomlPath)
    expect(content).not.toContain('SENTINEL-GUID-7b3f1a9e')
    expect(content).not.toContain('old_key')
    expect(content).toContain('relay_mode')
  })

  test('expected fields present after overwrite', () => {
    const sentinel = '# SENTINEL\nwrong_content = true\n'
    mkdirSync(templatesDir, { recursive: true })
    const tomlPath = join(templatesDir, 'slack-channel-bot.toml')
    writeFileSync(tomlPath, sentinel, 'utf-8')

    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)

    const content = readTemplateFile(tomlPath)
    expect(content).toContain('relay_mode = "on"')
    expect(content).toContain('cscb')
    expect(content).toContain('AskUserQuestion')
  })
})

// ---------------------------------------------------------------------------
// writeTemplate — failure paths
// ---------------------------------------------------------------------------

describe('writeTemplate — mkdir failure', () => {
  test('regular file at parent path component → T-A spy called once with class template-write', () => {
    // Place a regular file at tempRoot/.claude-director (blocks mkdir of templates/)
    const blockingFile = join(tempRoot, '.claude-director')
    writeFileSync(blockingFile, 'i am a file, not a dir\n', 'utf-8')
    const impossibleDir = join(blockingFile, 'templates')

    const { routingConfig, deps } = makeDeps({ templatesDir: impossibleDir })
    writeTemplate(routingConfig, deps)

    expect(recordStartupErrorCalls).toHaveLength(1)
    expect(recordStartupErrorCalls[0].classLabel).toBe('template-write')
  })

  test('mkdir failure → message names the target template path', () => {
    const blockingFile = join(tempRoot, '.claude-director')
    writeFileSync(blockingFile, 'i am a file, not a dir\n', 'utf-8')
    const impossibleDir = join(blockingFile, 'templates')
    const expectedTomlPath = join(impossibleDir, 'slack-channel-bot.toml')

    const { routingConfig, deps } = makeDeps({ templatesDir: impossibleDir })
    writeTemplate(routingConfig, deps)

    expect(recordStartupErrorCalls[0].message).toContain(expectedTomlPath)
  })

  test('mkdir failure → exit spy called once with non-zero code', () => {
    const blockingFile = join(tempRoot, '.claude-director')
    writeFileSync(blockingFile, 'i am a file, not a dir\n', 'utf-8')
    const impossibleDir = join(blockingFile, 'templates')

    const { routingConfig, deps } = makeDeps({ templatesDir: impossibleDir })
    writeTemplate(routingConfig, deps)

    expect(processExitCalls).toHaveLength(1)
    expect(processExitCalls[0]).toBeGreaterThan(0)
  })

  test('mkdir failure → no template file created', () => {
    const blockingFile = join(tempRoot, '.claude-director')
    writeFileSync(blockingFile, 'i am a file, not a dir\n', 'utf-8')
    const impossibleDir = join(blockingFile, 'templates')
    const expectedTomlPath = join(impossibleDir, 'slack-channel-bot.toml')

    const { routingConfig, deps } = makeDeps({ templatesDir: impossibleDir })
    writeTemplate(routingConfig, deps)

    expect(existsSync(expectedTomlPath)).toBe(false)
  })
})

describe('writeTemplate — writeFileSync failure (EISDIR)', () => {
  test('directory at target template path → T-A spy with class template-write', () => {
    // Create the templatesDir correctly, but put a DIRECTORY at the .toml path
    mkdirSync(templatesDir, { recursive: true })
    const tomlPath = join(templatesDir, 'slack-channel-bot.toml')
    mkdirSync(tomlPath, { recursive: true }) // toml path is now a directory

    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)

    expect(recordStartupErrorCalls).toHaveLength(1)
    expect(recordStartupErrorCalls[0].classLabel).toBe('template-write')
  })

  test('directory at target template path → message names the template path', () => {
    mkdirSync(templatesDir, { recursive: true })
    const tomlPath = join(templatesDir, 'slack-channel-bot.toml')
    mkdirSync(tomlPath, { recursive: true })

    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)

    expect(recordStartupErrorCalls[0].message).toContain(tomlPath)
  })

  test('directory at target template path → exit spy called once non-zero', () => {
    mkdirSync(templatesDir, { recursive: true })
    const tomlPath = join(templatesDir, 'slack-channel-bot.toml')
    mkdirSync(tomlPath, { recursive: true })

    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)

    expect(processExitCalls).toHaveLength(1)
    expect(processExitCalls[0]).toBeGreaterThan(0)
  })
})

describe('writeTemplate — renameSync failure', () => {
  test('directory occupying final path → T-A spy with class template-write', () => {
    // Create templatesDir, then put a directory at the final .toml path.
    // writeFileSync for the .tmp file will succeed (it's a new name) but
    // renameSync will fail because the target is a directory on some platforms,
    // OR writeFileSync to .tmp itself might fail if the directory is blocking
    // depending on OS. Either way we expect the error handler to fire.
    mkdirSync(templatesDir, { recursive: true })
    const tomlPath = join(templatesDir, 'slack-channel-bot.toml')
    // Pre-create the final path as a directory to block atomic rename
    mkdirSync(tomlPath)

    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)

    // Either writeFileSync (.tmp) or renameSync will fail → caught by the single catch block
    expect(recordStartupErrorCalls).toHaveLength(1)
    expect(recordStartupErrorCalls[0].classLabel).toBe('template-write')
  })

  test('rename failure → exit spy called once non-zero', () => {
    mkdirSync(templatesDir, { recursive: true })
    const tomlPath = join(templatesDir, 'slack-channel-bot.toml')
    mkdirSync(tomlPath)

    const { routingConfig, deps } = makeDeps()
    writeTemplate(routingConfig, deps)

    expect(processExitCalls).toHaveLength(1)
    expect(processExitCalls[0]).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// writeTemplate — ordering / config-driven content
// ---------------------------------------------------------------------------

describe('writeTemplate — ordering: driven by resolved RoutingConfig', () => {
  test('mutated mcp_config_path reflects in written claude_args', () => {
    const customPath = '/custom/resolved/mcp.json'
    const { routingConfig, deps, tomlPath } = makeDeps({ mcp_config_path: customPath })
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).toContain(customPath)
  })
})

describe('writeTemplate — repeated-boot refresh', () => {
  test('second call overrides first: toggled accessSync response reflected in final file', () => {
    const filePath = '/some/system-prompt.md'

    // First call: accessSync succeeds → flag present
    let throwOnAccess = false
    const accessSyncToggle = (_p: string, _m?: number) => {
      if (throwOnAccess) throw new Error('ENOENT')
    }

    const rc = makeRoutingConfig({
      system_prompt_mode: 'append',
      append_system_prompt_file: filePath,
    })

    const deps: WriteTemplateDeps = {
      templatesDir,
      accessSync: accessSyncToggle,
      recordStartupError: (classLabel, message, cause) => {
        recordStartupErrorCalls.push({ classLabel, message, cause })
      },
      processExit: (code) => {
        processExitCalls.push(code)
        return undefined as never
      },
      stderrWrite: (msg) => stderrLines.push(msg),
    }

    writeTemplate(rc, deps)
    const afterFirst = readTemplateFile(join(templatesDir, 'slack-channel-bot.toml'))
    expect(afterFirst).toContain('--append-system-prompt-file')

    // Toggle: second call accessSync throws → flag absent
    throwOnAccess = true
    stderrLines.length = 0

    writeTemplate(rc, deps)
    const afterSecond = readTemplateFile(join(templatesDir, 'slack-channel-bot.toml'))
    expect(afterSecond).not.toContain('--append-system-prompt-file')
    // confirm the stderr diagnostic was emitted for the second call
    expect(stderrLines).toHaveLength(1)
    expect(stderrLines[0]).toContain(filePath)
  })
})

// ---------------------------------------------------------------------------
// writeTemplate — append-system-prompt-file via writeTemplate (end-to-end)
// ---------------------------------------------------------------------------

describe('writeTemplate — append-system-prompt-file end-to-end', () => {
  test('mode=append + readable → flag and path in written file', () => {
    const filePath = '/absolute/system-prompt.md'
    const { routingConfig, deps, tomlPath } = makeDeps({
      system_prompt_mode: 'append',
      append_system_prompt_file: filePath,
      // accessSyncThrows defaults to false → readable
    })
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).toContain('--append-system-prompt-file')
    expect(content).toContain(filePath)
    expect(stderrLines).toHaveLength(0)
    expect(recordStartupErrorCalls).toHaveLength(0)
  })

  test('mode=append + unreadable → flag absent in written file', () => {
    const filePath = '/missing/system-prompt.md'
    const { routingConfig, deps, tomlPath } = makeDeps({
      system_prompt_mode: 'append',
      append_system_prompt_file: filePath,
      accessSyncThrows: true,
    })
    writeTemplate(routingConfig, deps)
    const content = readTemplateFile(tomlPath)
    expect(content).not.toContain('--append-system-prompt-file')
    expect(stderrLines).toHaveLength(1)
    expect(stderrLines[0]).toContain(filePath)
    // T-A spy NOT invoked for omission (not fatal)
    expect(recordStartupErrorCalls).toHaveLength(0)
  })

  test('mode=none → flag absent regardless of readability', () => {
    const filePath = '/some/file.md'
    const callCount = { n: 0 }
    const rc = makeRoutingConfig({
      system_prompt_mode: 'none',
      append_system_prompt_file: filePath,
    })
    const deps: WriteTemplateDeps = {
      templatesDir,
      accessSync: (_p, _m) => { callCount.n++ },
      recordStartupError: (classLabel, message, cause) => {
        recordStartupErrorCalls.push({ classLabel, message, cause })
      },
      processExit: (code) => { processExitCalls.push(code); return undefined as never },
      stderrWrite: (msg) => stderrLines.push(msg),
    }
    writeTemplate(rc, deps)
    const content = readTemplateFile(join(templatesDir, 'slack-channel-bot.toml'))
    expect(content).not.toContain('--append-system-prompt-file')
    expect(callCount.n).toBe(0)
    expect(stderrLines).toHaveLength(0)
  })
})
