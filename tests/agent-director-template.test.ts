/**
 * agent-director-template.test.ts — SR-3.2 / SR-3.1 template install.
 *
 * Covers:
 *   - buildTemplateParams() produces the SR-3.1 shape (relay_mode='on',
 *     label=['service=cscb'], deny=['AskUserQuestion'], overwrite: true,
 *     claude_args with the four required CLI flags).
 *   - deriveMemoryReadAllowRules() emits one memory-subdir Read rule per
 *     distinct effective config dir across the personas (b.fae F5,
 *     b.av2 SR-6.2), never a config-dir root.
 *   - --append-system-prompt-file is appended when the file is readable,
 *     and omitted (with a stderr warning) when accessSync throws.
 *   - `--system-prompt-snapshot off` (b.b1j SR-2) is the last two arguments
 *     unless fresh_system_prompt is false, whatever the append-file decision;
 *     the refresh keeps the boot install's arguments in both directions.
 *   - installSlackChannelBotTemplate() calls client.makeTemplate(...) with
 *     exactly the buildTemplateParams shape, and propagates the result.
 *   - Rejections from client.makeTemplate(...) — typed AgentDirectorError
 *     and generic Error — both record a fatal startup error and exit.
 *   - refreshSlackChannelBotTemplate() (b.av2 SR-8.6 step 5): one
 *     makeTemplate call with the boot install's params except `allow`, which
 *     follows the applied personas' effective config dirs as written; the
 *     applied config's server-wide values are ignored and the append file is
 *     not probed again; a rejection logs one line and resolves `failed` with
 *     no exit and no startup error, and nothing retries it (E13 decision 3).
 *     The line names a typed error by name and description, and describes an
 *     untyped throw by its type (and stack frames) only, so a token in its
 *     message never reaches the log; the boot install keeps the message.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { AgentDirectorError, ErrTemplateMalformed, type MakeTemplateParams } from 'agent-director'

import {
  buildTemplateParams,
  deriveMemoryReadAllowRules,
  installSlackChannelBotTemplate,
  refreshSlackChannelBotTemplate,
} from '../src/agent-director-template.ts'
import type { PersonaConfig } from '../src/config.ts'
import {
  cannedMakeTemplate,
  errTemplateMalformed,
  errTemplateNameUnsafe,
  makeStubClient,
} from './test-helpers/agent-director-stub.ts'
import { BOT_TOKEN_PREFIX, REDACTED_SENTINEL_TAIL, assertNoLeak, fakeToken, sentinelInMessage } from './test-helpers/credentials.ts'
import { makeMultiPersonaConfig, makePersonaConfig, type PersonaSpec } from './test-helpers/persona-config.ts'

/**
 * Fixture base dir for persona paths, fresh per test. The code under test only
 * builds strings; the refresh cases write a few fixtures here themselves (an
 * append file, a symlinked config dir, the state dir). Paths stay unique to
 * the test and never point at the real home.
 */
let baseDir: string
beforeEach(() => { baseDir = mkdtempSync(join(os.tmpdir(), 'ad-template-test-')) })
afterEach(() => { rmSync(baseDir, { recursive: true, force: true }) })

/** The memory-subdir Read rule for an absolute config dir (`//` anchor). */
function memoryRule(dir: string): string {
  return `Read(/${dir}/projects/*/memory/**)`
}

// ---------------------------------------------------------------------------
// buildTemplateParams — SR-3.1 shape
// ---------------------------------------------------------------------------

describe('buildTemplateParams (SR-3.1)', () => {
  test('produces the canonical SR-3.1 shape with overwrite=true', () => {
    // fresh_system_prompt: false keeps the SR-3.1 array without the b.b1j pair, which its own block pins.
    const cfg = makePersonaConfig({
      mcp_config_path: '/abs/mcp.json',
      system_prompt_mode: 'none',
      fresh_system_prompt: false,
    }, baseDir)
    const params = buildTemplateParams(cfg)
    expect(params.name).toBe('slack-channel-bot')
    expect(params.relay_mode).toBe('on')
    expect(params.label).toEqual(['service=cscb'])
    expect(params.deny).toEqual(['AskUserQuestion'])
    expect(params.overwrite).toBe(true)
    expect(params.claude_args).toEqual([
      '--dangerously-load-development-channels',
      'server:slack-channel-router',
      '--mcp-config',
      '/abs/mcp.json',
    ])
    // CSCB_CRONTABLE_PATH is spawn-time-only env (buildSpawnParams' extra_env),
    // never template env — the template omits env entirely by design.
    expect(params.extra_env).toBeUndefined()
  })

  // b.fae F5 (code-review follow-up) — the allow array is DERIVED from the
  // distinct effective Claude config dirs across all personas (per-persona,
  // else top-level, else Claude's default `~/.claude`), one memory-scoped Read
  // rule per dir, sorted by dir + deduped. NEVER the config-dir root (holds
  // live creds). os.homedir() is read only to compute an expected string.
  test('allow: default — no config dirs set → exactly the ~/.claude rule from os.homedir() (b.fae F5)', () => {
    const cfg = makePersonaConfig({ mcp_config_path: '/abs/mcp.json', system_prompt_mode: 'none' }, baseDir)
    const params = buildTemplateParams(cfg)
    // Built from os.homedir(), NOT a hardcoded /home/horde.
    expect(params.allow).toEqual([memoryRule(join(os.homedir(), '.claude'))])
    // deny surface is unchanged by F5.
    expect(params.deny).toEqual(['AskUserQuestion'])
  })

  test('no allow rule covers a config-dir root (credentials guard, b.fae F5)', () => {
    const infhub = join(baseDir, '.claude-infhub')
    const cfg = makeMultiPersonaConfig(
      [{ name: 'Infhub Bot', claude_config_dir: infhub }, { name: 'Default Bot' }],
      baseDir,
      { mcp_config_path: '/abs/mcp.json', system_prompt_mode: 'none' },
    )
    const allow = buildTemplateParams(cfg).allow ?? []
    // The rejected-in-triage broad glob and any bare-root variant must be absent.
    expect(allow).not.toContain(`Read(/${infhub}/**)`)
    expect(allow).not.toContain(`Read(/${join(os.homedir(), '.claude')}/**)`)
    // Belt-and-suspenders: every rule must reach into projects/*/memory, so no
    // rule can resolve to the config-dir root, settings.json, or .claude.json.
    expect(allow.length).toBe(2)
    for (const rule of allow) {
      expect(rule.endsWith('/projects/*/memory/**)')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// deriveMemoryReadAllowRules — rule derivation over personas (b.fae F5, b.av2 SR-6.2)
// ---------------------------------------------------------------------------

describe('deriveMemoryReadAllowRules over personas', () => {
  // Every case passes an explicit home under the test's temp dir, so the
  // default dir (and the sort order against it) never depends on the real
  // HOME. Expected rules are listed in dir order, not re-sorted: as dirs,
  // `<home>/.claude` sorts before `<home>/.claude-infhub` (shorter prefix),
  // while as rule strings the order would flip ('-' < '/'), so these rows
  // also pin that the sort is over dirs.
  interface Dirs { home: string; defaultDir: string; infhub: string; shared: string; link: string }
  type Row = [label: string, config: (d: Dirs) => [PersonaSpec[], topLevel?: string], expectedDirs: (d: Dirs) => string[]]
  const rows: Row[] = [
    ['no config dir on any persona → exactly the default rule',
      () => [[{ name: 'A Bot' }, { name: 'B Bot' }]],
      (d) => [d.defaultDir]],
    ['a persona with its own dir + one with none (+ one sharing that dir) → both rules, sorted + deduped (b.fae F5)',
      (d) => [[{ name: 'Infhub Bot', claude_config_dir: d.infhub }, { name: 'Default Bot' }, { name: 'Infhub Two', claude_config_dir: d.infhub }]],
      (d) => [d.defaultDir, d.infhub]],
    ['several personas sharing one top-level dir → one rule',
      (d) => [[{ name: 'A Bot' }, { name: 'B Bot' }, { name: 'C Bot' }], d.shared],
      (d) => [d.shared]],
    ['a top-level dir applies to personas without their own override',
      (d) => [[{ name: 'Inherits Bot' }, { name: 'Override Bot', claude_config_dir: d.infhub }], d.shared],
      (d) => [d.infhub, d.shared]],
    ['zero personas → still the default rule',
      () => [[]],
      (d) => [d.defaultDir]],
    ['a directory spelled through a symlink → the rule for the written path, never its real path (lexical, E12 decision (c))',
      (d) => [[{ name: 'A Bot', claude_config_dir: d.link }]],
      (d) => [d.link]],
  ]

  test.each(rows)('%s', (_label, config, expectedDirs) => {
    const home = join(baseDir, 'home')
    const d: Dirs = {
      home,
      defaultDir: join(home, '.claude'),
      infhub: join(home, '.claude-infhub'),
      shared: join(baseDir, 'shared-config'),
      link: join(baseDir, 'link-cfg'),
    }
    mkdirSync(join(baseDir, 'real-cfg'))
    symlinkSync(join(baseDir, 'real-cfg'), d.link)
    const [specs, topLevel] = config(d)
    const cfg = makeMultiPersonaConfig(specs, baseDir, topLevel === undefined ? {} : { claude_config_dir: topLevel })
    expect(deriveMemoryReadAllowRules(cfg, home)).toEqual(expectedDirs(d).map(memoryRule))
  })
})

describe('buildTemplateParams: --append-system-prompt-file (SR-3.1)', () => {
  test('appends --append-system-prompt-file when readable', () => {
    const cfg = makePersonaConfig({
      append_system_prompt_file: '/etc/cscb/extra.md',
      system_prompt_mode: 'append',
    }, baseDir)
    const params = buildTemplateParams(cfg, {
      accessSync: (_p, _mode) => { /* readable: no throw */ },
      stderrWrite: () => { /* should not be called */ },
    })
    expect(params.claude_args).toContain('--append-system-prompt-file')
    expect(params.claude_args).toContain('/etc/cscb/extra.md')
  })

  test('omits --append-system-prompt-file when unreadable + emits one stderr warning', () => {
    const cfg = makePersonaConfig({
      append_system_prompt_file: '/etc/cscb/extra.md',
      system_prompt_mode: 'append',
    }, baseDir)
    const warnings: string[] = []
    const params = buildTemplateParams(cfg, {
      accessSync: () => { throw new Error('EACCES') },
      stderrWrite: (msg) => warnings.push(msg),
    })
    expect(params.claude_args).not.toContain('--append-system-prompt-file')
    expect(params.claude_args).not.toContain('/etc/cscb/extra.md')
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('not readable')
    expect(warnings[0]).toContain('/etc/cscb/extra.md')
  })

  test('does NOT append --append-system-prompt-file when system_prompt_mode=none', () => {
    const cfg = makePersonaConfig({
      append_system_prompt_file: '/etc/cscb/extra.md',
      system_prompt_mode: 'none',
    }, baseDir)
    let accessSyncCalled = false
    const params = buildTemplateParams(cfg, {
      accessSync: () => { accessSyncCalled = true },
      stderrWrite: () => { /* should not be called */ },
    })
    expect(params.claude_args).not.toContain('--append-system-prompt-file')
    // The mode-check short-circuits before accessSync is consulted.
    expect(accessSyncCalled).toBe(false)
  })

  test('does NOT append --append-system-prompt-file when path is absent', () => {
    const cfg = makePersonaConfig({ system_prompt_mode: 'append' }, baseDir)
    const params = buildTemplateParams(cfg, {
      accessSync: () => { /* not reached */ },
      stderrWrite: () => { /* not reached */ },
    })
    expect(params.claude_args).not.toContain('--append-system-prompt-file')
  })
})

// ---------------------------------------------------------------------------
// buildTemplateParams — the snapshot pair (b.b1j SR-2)
// ---------------------------------------------------------------------------

describe('buildTemplateParams: --system-prompt-snapshot off (b.b1j SR-2)', () => {
  const BASE = ['--dangerously-load-development-channels', 'server:slack-channel-router', '--mcp-config', '/abs/mcp.json']
  const PAIR = ['--system-prompt-snapshot', 'off']
  const FILE = '/etc/cscb/extra.md'

  // The four SR-2.1 append-flag cases. `args` is today's array for the case;
  // the pair is the only thing the setting adds to it.
  type Row = [
    label: string,
    overrides: Partial<PersonaConfig>,
    readable: boolean,
    args: string[],
    warnings: number,
    probed: boolean,
  ]
  const rows: Row[] = [
    ['"none"', { system_prompt_mode: 'none', append_system_prompt_file: FILE }, true, BASE, 0, false],
    ['"append" with a readable file', { system_prompt_mode: 'append', append_system_prompt_file: FILE }, true,
      [...BASE, '--append-system-prompt-file', FILE], 0, true],
    ['"append" with an unreadable file', { system_prompt_mode: 'append', append_system_prompt_file: FILE }, false, BASE, 1, true],
    ['"append" with no file', { system_prompt_mode: 'append' }, true, BASE, 0, false],
  ]

  // 'absent' is a configuration without the field, as an older caller builds one.
  const settings = [
    ['absent', undefined, true],
    ['true', true, true],
    ['false', false, false],
  ] as const

  test.each(rows.flatMap(([label, ...rest]) => settings.map(([setting, value, pair]) => [label, setting, value, pair, ...rest] as const)))(
    '%s, fresh_system_prompt %s: the SR-2.1 array, with the pair last only when the setting is not false',
    (_label, _setting, value, pair, overrides, readable, args, warnings, probed) => {
      const cfg = makePersonaConfig({ mcp_config_path: '/abs/mcp.json', ...overrides }, baseDir)
      if (value === undefined) delete (cfg as Partial<PersonaConfig>).fresh_system_prompt
      else cfg.fresh_system_prompt = value
      const logged: string[] = []
      let accessSyncCalls = 0
      const params = buildTemplateParams(cfg, {
        accessSync: () => { accessSyncCalls++; if (!readable) throw new Error('EACCES') },
        stderrWrite: (msg) => logged.push(msg),
      })
      expect(params.claude_args).toEqual(pair ? [...args, ...PAIR] : args)
      // The pair is the same single occurrence at the end, and the probe and its warning are the setting's no-ops.
      expect(params.claude_args!.filter((a) => a === '--system-prompt-snapshot')).toHaveLength(pair ? 1 : 0)
      expect(accessSyncCalls).toBe(probed ? 1 : 0)
      expect(logged).toHaveLength(warnings)
      if (warnings > 0) {
        expect(logged[0]).toContain('not readable')
        expect(logged[0]).toContain(FILE)
      }
    },
  )
})

// ---------------------------------------------------------------------------
// installSlackChannelBotTemplate — SR-3.2
// ---------------------------------------------------------------------------

describe('installSlackChannelBotTemplate (SR-3.2)', () => {
  test('calls client.makeTemplate with the SR-3.1 params and returns the result', async () => {
    const makeTemplateCalls: import('agent-director').MakeTemplateParams[] = []
    const stub = makeStubClient({
      makeTemplateResult: cannedMakeTemplate('/home/u/.agent-director/templates/slack-channel-bot.toml'),
      makeTemplateCalls,
    })
    const cfg = makePersonaConfig({
      mcp_config_path: '/abs/mcp.json',
      system_prompt_mode: 'none',
      fresh_system_prompt: false,
    }, baseDir)
    const result = await installSlackChannelBotTemplate(cfg, {
      getClient: () => stub,
      recordStartupError: () => { throw new Error('should not record on success') },
      exit: () => { throw new Error('should not exit on success') },
    })
    expect(result.path).toBe('/home/u/.agent-director/templates/slack-channel-bot.toml')
    expect(makeTemplateCalls.length).toBe(1)
    const params = makeTemplateCalls[0]
    expect(params.name).toBe('slack-channel-bot')
    expect(params.relay_mode).toBe('on')
    expect(params.label).toEqual(['service=cscb'])
    expect(params.deny).toEqual(['AskUserQuestion'])
    expect(params.overwrite).toBe(true)
    expect(params.claude_args).toEqual([
      '--dangerously-load-development-channels',
      'server:slack-channel-router',
      '--mcp-config',
      '/abs/mcp.json',
    ])
  })

  test('resolves with the exact params it passed to makeTemplate, the append flag as the boot probe decided', async () => {
    const makeTemplateCalls: MakeTemplateParams[] = []
    const cfg = makePersonaConfig({
      mcp_config_path: '/abs/mcp.json',
      system_prompt_mode: 'append',
      append_system_prompt_file: '/etc/cscb/extra.md',
    }, baseDir)
    const result = await installSlackChannelBotTemplate(cfg, {
      getClient: () => makeStubClient({ makeTemplateCalls }),
      accessSync: () => { /* readable */ },
      recordStartupError: () => { throw new Error('should not record on success') },
      exit: () => { throw new Error('should not exit on success') },
    })
    expect(makeTemplateCalls.length).toBe(1)
    expect(result.params).toEqual(makeTemplateCalls[0])
    expect(result.params.claude_args).toContain('--append-system-prompt-file')
  })

  // b.b1j SR-2.3: the default configuration installs the pair, last, and the
  // params makeTemplate received are the ones the install resolves with.
  test('with fresh_system_prompt on, installs the pair last and resolves with the exact params passed to makeTemplate', async () => {
    const makeTemplateCalls: MakeTemplateParams[] = []
    const cfg = makePersonaConfig({
      mcp_config_path: '/abs/mcp.json',
      system_prompt_mode: 'append',
      append_system_prompt_file: '/etc/cscb/extra.md',
    }, baseDir)
    const result = await installSlackChannelBotTemplate(cfg, {
      getClient: () => makeStubClient({ makeTemplateCalls }),
      accessSync: () => { /* readable */ },
      recordStartupError: () => { throw new Error('should not record on success') },
      exit: () => { throw new Error('should not exit on success') },
    })
    expect(makeTemplateCalls.length).toBe(1)
    expect(result.params).toEqual(makeTemplateCalls[0])
    expect(makeTemplateCalls[0]!.claude_args).toEqual([
      '--dangerously-load-development-channels',
      'server:slack-channel-router',
      '--mcp-config',
      '/abs/mcp.json',
      '--append-system-prompt-file',
      '/etc/cscb/extra.md',
      '--system-prompt-snapshot',
      'off',
    ])
  })

  test('typed AgentDirectorError → records ad-template-install + exits', async () => {
    const stub = makeStubClient({ makeTemplateError: errTemplateMalformed() })
    const recorded: { classLabel: string; message: string }[] = []
    let exited = false
    const cfg = makePersonaConfig({ system_prompt_mode: 'none' }, baseDir)
    await expect(
      installSlackChannelBotTemplate(cfg, {
        getClient: () => stub,
        recordStartupError: (classLabel, message) => recorded.push({ classLabel, message: String(message) }),
        exit: (() => { exited = true; throw new Error('__exit__') }) as never,
      }),
    ).rejects.toThrow('__exit__')
    expect(exited).toBe(true)
    expect(recorded.length).toBe(1)
    expect(recorded[0].classLabel).toBe('ad-template-install')
    expect(recorded[0].message).toContain('ErrTemplateMalformed')
  })

  test('ErrTemplateNameUnsafe → records + exits', async () => {
    const stub = makeStubClient({ makeTemplateError: errTemplateNameUnsafe() })
    const recorded: { classLabel: string; message: string }[] = []
    const cfg = makePersonaConfig({ system_prompt_mode: 'none' }, baseDir)
    await expect(
      installSlackChannelBotTemplate(cfg, {
        getClient: () => stub,
        recordStartupError: (classLabel, message) => recorded.push({ classLabel, message: String(message) }),
        exit: (() => { throw new Error('__exit__') }) as never,
      }),
    ).rejects.toThrow('__exit__')
    expect(recorded[0].classLabel).toBe('ad-template-install')
    expect(recorded[0].message).toContain('ErrTemplateNameUnsafe')
  })

  test('non-typed Error → records + exits', async () => {
    const stub = makeStubClient({ makeTemplateError: new Error('FFI handle invalid') })
    const recorded: { classLabel: string; message: string }[] = []
    const cfg = makePersonaConfig({ system_prompt_mode: 'none' }, baseDir)
    await expect(
      installSlackChannelBotTemplate(cfg, {
        getClient: () => stub,
        recordStartupError: (classLabel, message) => recorded.push({ classLabel, message: String(message) }),
        exit: (() => { throw new Error('__exit__') }) as never,
      }),
    ).rejects.toThrow('__exit__')
    expect(recorded[0].classLabel).toBe('ad-template-install')
    expect(recorded[0].message).toContain('FFI handle invalid')
  })
})

// ---------------------------------------------------------------------------
// refreshSlackChannelBotTemplate — b.av2 SR-8.6 step 5 (apply-time refresh)
// ---------------------------------------------------------------------------

describe('refreshSlackChannelBotTemplate (b.av2 SR-8.6 step 5)', () => {
  const REFRESHED_PATH = '/stub/templates/slack-channel-bot.toml'
  const refreshedLine = (rules: number): string =>
    `[slack] template refresh: rewrote the agent-director template 'slack-channel-bot' with the memory-read rules ` +
    `of the applied config directories (${rules} rule(s)); its other arguments are the start's`
  const failedLine = (detail: string): string =>
    `[slack] template refresh: refreshing the agent-director template 'slack-channel-bot' failed (${detail}); ` +
    `its memory-read rules stay as last installed until the config directories change again or the server restarts`

  /** Home for the default config dir's rule, under the test's temp dir. */
  let home: string
  // Every refresh case runs with process.exit recorded, not real, and the
  // startup-error log redirected under the temp dir, so a refresh that exited
  // or recorded a startup error fails the case instead of the run.
  let stateDir: string
  let savedStateDir: string | undefined
  let savedExit: typeof process.exit
  let exits: unknown[]
  beforeEach(() => {
    home = join(baseDir, 'home')
    stateDir = join(baseDir, 'state')
    savedStateDir = process.env['SLACK_STATE_DIR']
    process.env['SLACK_STATE_DIR'] = stateDir
    exits = []
    savedExit = process.exit
    process.exit = ((code?: number) => { exits.push(code) }) as typeof process.exit
  })
  afterEach(() => {
    process.exit = savedExit
    if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
    else process.env['SLACK_STATE_DIR'] = savedStateDir
  })

  /** The boot install of `cfg` through a stub client; the params it resolved with. */
  async function bootInstall(cfg: PersonaConfig, appendReadable = true): Promise<MakeTemplateParams> {
    const installed = await installSlackChannelBotTemplate(cfg, {
      getClient: () => makeStubClient({}),
      accessSync: () => { if (!appendReadable) throw new Error('EACCES') },
      stderrWrite: () => { /* the unreadable-append warning is covered above */ },
      recordStartupError: () => { throw new Error('boot install recorded a startup error') },
      exit: () => { throw new Error('boot install exited') },
    })
    return installed.params
  }

  /** Refresh through a recording stub client; every makeTemplate call and log line captured. */
  async function refresh(
    applied: PersonaConfig,
    installed: MakeTemplateParams,
    opts: { makeTemplateError?: Error; getClient?: () => unknown } = {},
  ) {
    const calls: MakeTemplateParams[] = []
    const logs: string[] = []
    const stub = makeStubClient({
      makeTemplateCalls: calls,
      makeTemplateResult: cannedMakeTemplate(REFRESHED_PATH),
      makeTemplateError: opts.makeTemplateError,
    })
    const result = await refreshSlackChannelBotTemplate(applied, installed, {
      getClient: opts.getClient ?? (() => stub),
      log: (line) => logs.push(line),
      home,
    })
    return { result, calls, logs }
  }

  // The applied config's server-wide values differ from the start's in every
  // row; the refresh keeps the start's claude_args all the same. Row 2's
  // applied append file really exists, so a refresh that probed it again
  // would gain the flag.
  type ServerWideRow = [
    label: string,
    boot: (b: string) => [overrides: Partial<PersonaConfig>, appendReadable: boolean],
    applied: (b: string) => Partial<PersonaConfig>,
    expectedArgs: (b: string) => string[],
  ]
  const serverWideRows: ServerWideRow[] = [
    ['start installed the append flag; the applied config turns system prompts off and moves the MCP config',
      (b) => [{ mcp_config_path: join(b, 'boot-mcp.json'), system_prompt_mode: 'append', append_system_prompt_file: join(b, 'boot-append.md'), fresh_system_prompt: false }, true],
      (b) => ({ mcp_config_path: join(b, 'applied-mcp.json'), system_prompt_mode: 'none', append_system_prompt_file: join(b, 'applied-append.md') }),
      (b) => ['--dangerously-load-development-channels', 'server:slack-channel-router', '--mcp-config', join(b, 'boot-mcp.json'),
        '--append-system-prompt-file', join(b, 'boot-append.md')]],
    ['start omitted an unreadable append file; the applied config names a readable one (not probed again)',
      (b) => [{ mcp_config_path: join(b, 'boot-mcp.json'), system_prompt_mode: 'append', append_system_prompt_file: join(b, 'boot-append.md'), fresh_system_prompt: false }, false],
      (b) => ({ mcp_config_path: join(b, 'applied-mcp.json'), system_prompt_mode: 'append', append_system_prompt_file: join(b, 'applied-append.md') }),
      (b) => ['--dangerously-load-development-channels', 'server:slack-channel-router', '--mcp-config', join(b, 'boot-mcp.json')]],
  ]

  test.each(serverWideRows)('success: %s → one call, rules from the applied personas, every other field the start\'s', async (_label, boot, applied, expectedArgs) => {
    writeFileSync(join(baseDir, 'applied-append.md'), 'extra system prompt\n')
    const [bootOverrides, appendReadable] = boot(baseDir)
    const installed = await bootInstall(makePersonaConfig(bootOverrides, baseDir), appendReadable)
    const infhub = join(home, '.claude-infhub')
    const appliedCfg = makeMultiPersonaConfig(
      [{ name: 'Default Bot' }, { name: 'Infhub Bot', claude_config_dir: infhub }],
      baseDir,
      applied(baseDir),
    )

    const { result, calls, logs } = await refresh(appliedCfg, installed)

    const allow = [memoryRule(join(home, '.claude')), memoryRule(infhub)]
    expect(calls).toEqual([{ ...installed, allow, overwrite: true }])
    expect(calls[0]!.claude_args).toEqual(expectedArgs(baseDir))
    // Scope (b.av2 SR-11): every refreshed rule reaches into projects/*/memory, never a config-dir root.
    for (const rule of calls[0]!.allow ?? []) expect(rule).toMatch(/\/projects\/\*\/memory\/\*\*\)$/)
    expect(calls[0]!.allow).not.toContain(`Read(/${infhub}/**)`)
    expect(result).toEqual({ kind: 'refreshed', path: REFRESHED_PATH })
    expect(logs).toEqual([refreshedLine(2)])
    assertNoLeak({ logs, calls, result })
  })

  // b.b1j SR-2.3: a start-time-only setting. The refresh keeps the boot
  // install's claude_args exactly, whichever way the applied config moved it.
  test.each([
    ['start on, applied off: the pair is kept', true, false, true],
    ['start off, applied on: no pair is added', false, true, false],
  ])('%s', async (_label, bootValue, appliedValue, hasPair) => {
    const serverWide = { mcp_config_path: '/abs/mcp.json', system_prompt_mode: 'none' as const }
    const installed = await bootInstall(
      makeMultiPersonaConfig([{ name: 'A Bot' }], baseDir, { ...serverWide, fresh_system_prompt: bootValue }),
    )
    expect(installed.claude_args!.slice(-2)).toEqual(hasPair ? ['--system-prompt-snapshot', 'off'] : ['--mcp-config', '/abs/mcp.json'])

    const { result, calls } = await refresh(
      makeMultiPersonaConfig([{ name: 'A Bot' }], baseDir, { ...serverWide, fresh_system_prompt: appliedValue }),
      installed,
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.claude_args).toEqual(installed.claude_args)
    expect(calls[0]!.claude_args!.filter((a) => a === '--system-prompt-snapshot')).toHaveLength(hasPair ? 1 : 0)
    expect(result).toEqual({ kind: 'refreshed', path: REFRESHED_PATH })
  })

  // The comparison that decides whether to refresh is the change plan's
  // lexical `configDirsChanged` (src/reload-plan.ts, tested in its own file),
  // and the rules themselves are deriveMemoryReadAllowRules's (its table
  // above). This case pins only that the installed `allow` is replaced by the
  // applied set's rules, not merged with them: the start's two dirs are gone.
  test('the start\'s allow rules are replaced by the applied set\'s, not merged', async () => {
    const [a, b] = [join(baseDir, 'cfg-a'), join(baseDir, 'cfg-b')]
    const serverWide = { mcp_config_path: '/abs/mcp.json', system_prompt_mode: 'none' as const }
    const installed = await bootInstall(makeMultiPersonaConfig([{ name: 'A Bot' }, { name: 'B Bot', claude_config_dir: a }], baseDir, serverWide))
    expect(installed.allow).toHaveLength(2)

    const { result, calls, logs } = await refresh(makeMultiPersonaConfig([{ name: 'B Bot', claude_config_dir: b }], baseDir, serverWide), installed)

    expect(calls).toEqual([{ ...installed, allow: [memoryRule(b)], overwrite: true }])
    expect(result).toEqual({ kind: 'refreshed', path: REFRESHED_PATH })
    expect(logs).toEqual([refreshedLine(1)])
  })

  test('without a home, the default dir\'s rule is built from the OS home at call time', async () => {
    const cfg = makeMultiPersonaConfig([{ name: 'A Bot' }], baseDir, { mcp_config_path: '/abs/mcp.json', system_prompt_mode: 'none' })
    const installed = await bootInstall(cfg)
    const calls: MakeTemplateParams[] = []
    await refreshSlackChannelBotTemplate(cfg, installed, {
      getClient: () => makeStubClient({ makeTemplateCalls: calls }),
      log: () => { /* not asserted here */ },
    })
    // os.homedir() is read only to compute the expected string.
    expect(calls.map((p) => p.allow)).toEqual([[memoryRule(join(os.homedir(), '.claude'))]])
  })

  describe('a rejected refresh is logged, not fatal, and not retried (E13 decision 3)', () => {
    /**
     * The leak marker as a message carries it (`sentinelInMessage`): only
     * inside a fake token and a Socket Mode `ticket=` URL. The refresh's line
     * keeps a message after `redactSlackLogText`, which replaces both, so the
     * marker shows only if redaction is skipped.
     */
    const secret = `(${sentinelInMessage('refresh')})`
    /** `secret` as the line shows it. */
    const REDACTED_SECRET = `(${REDACTED_SENTINEL_TAIL})`
    /** A plain Error whose message carries `secret`. */
    const tokenBearing = (what: string): Error => new Error(`${what} ${secret}`)
    /**
     * An untyped throw is described only through `describeThrownValue`: its
     * type, its message redacted, then its stack frames if any (not pinned).
     */
    const untypedError = (what: string): RegExp => new RegExp(`Error ${RegExp.escape(`message="${what} ${REDACTED_SECRET}"`)}(?: at .*)?`)
    // Rows: a typed error's detail is its exact name and redacted description; an untyped one's matches untypedError.
    type RejectRow = [label: string, opts: () => { makeTemplateError?: Error; getClient?: () => unknown }, detail: string | RegExp, makeTemplateCalls: number]
    const rejectRows: RejectRow[] = [
      ['typed ErrTemplateMalformed', () => ({ makeTemplateError: errTemplateMalformed() }), 'ErrTemplateMalformed message="template malformed"', 1],
      ['typed ErrTemplateNameUnsafe', () => ({ makeTemplateError: errTemplateNameUnsafe() }), 'ErrTemplateNameUnsafe message="unsafe template name"', 1],
      [
        'typed ErrTemplateMalformed whose description holds a token and a URL',
        () => ({ makeTemplateError: new ErrTemplateMalformed('make-template', 'ErrTemplateMalformed', `bad template ${secret}`) }),
        `ErrTemplateMalformed message="bad template ${REDACTED_SECRET}"`,
        1,
      ],
      [
        'typed ErrTemplateMalformed with an empty description',
        () => ({ makeTemplateError: new ErrTemplateMalformed('make-template', 'ErrTemplateMalformed', '') }),
        'ErrTemplateMalformed',
        1,
      ],
      [
        'a base AgentDirectorError whose errName is token-shaped',
        () => ({ makeTemplateError: new AgentDirectorError('make-template', fakeToken(BOT_TOKEN_PREFIX, 'errname'), `bad ${secret}`) }),
        new RegExp(`AgentDirectorError ${RegExp.escape(`message="<redacted-token> bad ${REDACTED_SECRET}"`)}(?: at .*)?`),
        1,
      ],
      ['a generic Error whose message holds a token', () => ({ makeTemplateError: tokenBearing('FFI handle invalid') }), untypedError('FFI handle invalid'), 1],
      [
        'getClient() throwing a token-bearing Error (no client installed)',
        () => ({ getClient: () => { throw tokenBearing('no client installed') } }),
        untypedError('no client installed'),
        0,
      ],
    ]

    test.each(rejectRows)('%s → resolves failed, one token-safe line, no exit, no startup error', async (_label, opts, detail, makeTemplateCalls) => {
      const cfg = makeMultiPersonaConfig([{ name: 'A Bot' }], baseDir, { mcp_config_path: '/abs/mcp.json', system_prompt_mode: 'none' })
      const installed = await bootInstall(cfg)

      const { result, calls, logs } = await refresh(cfg, installed, opts())

      expect(result).toEqual({ kind: 'failed' })
      expect(calls.length).toBe(makeTemplateCalls)
      const [head, tail] = failedLine('\0').split('\0') as [string, string]
      const detailSource = typeof detail === 'string' ? RegExp.escape(detail) : detail.source
      expect(logs).toEqual([expect.stringMatching(new RegExp(`^${RegExp.escape(head)}${detailSource}${RegExp.escape(tail)}$`))])
      expect(exits).toEqual([])
      expect(existsSync(join(stateDir, 'startup-errors.log'))).toBe(false)
      assertNoLeak({ logs, result })
    })
  })

  test.each([
    ['success', undefined, 'refreshed'],
    ['rejection', errTemplateMalformed(), 'failed'],
  ] as const)('a throwing logger does not fail the refresh (%s)', async (_label, makeTemplateError, kind) => {
    const cfg = makeMultiPersonaConfig([{ name: 'A Bot' }], baseDir, { mcp_config_path: '/abs/mcp.json', system_prompt_mode: 'none' })
    const installed = await bootInstall(cfg)
    const calls: MakeTemplateParams[] = []
    const result = await refreshSlackChannelBotTemplate(cfg, installed, {
      getClient: () => makeStubClient({ makeTemplateCalls: calls, makeTemplateError }),
      log: () => { throw new Error('log sink down') },
      home,
    })
    expect(result.kind).toBe(kind)
    expect(calls.length).toBe(1)
    expect(exits).toEqual([])
  })
})
