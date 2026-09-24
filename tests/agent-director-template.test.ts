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
 *   - installSlackChannelBotTemplate() calls client.makeTemplate(...) with
 *     exactly the buildTemplateParams shape, and propagates the result.
 *   - Rejections from client.makeTemplate(...) — typed AgentDirectorError
 *     and generic Error — both record a fatal startup error and exit.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

import {
  buildTemplateParams,
  deriveMemoryReadAllowRules,
  installSlackChannelBotTemplate,
} from '../src/agent-director-template.ts'
import {
  cannedMakeTemplate,
  errTemplateMalformed,
  errTemplateNameUnsafe,
  makeStubClient,
} from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig, makePersonaConfig, type PersonaSpec } from './test-helpers/persona-config.ts'

/**
 * Fixture base dir for persona paths, fresh per test. Nothing is written into
 * it (the code under test only builds strings), but paths stay unique to the
 * test and never point at the real home.
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
    const cfg = makePersonaConfig({
      mcp_config_path: '/abs/mcp.json',
      system_prompt_mode: 'none',
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
  interface Dirs { home: string; defaultDir: string; infhub: string; shared: string }
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
  ]

  test.each(rows)('%s', (_label, config, expectedDirs) => {
    const home = join(baseDir, 'home')
    const d: Dirs = {
      home,
      defaultDir: join(home, '.claude'),
      infhub: join(home, '.claude-infhub'),
      shared: join(baseDir, 'shared-config'),
    }
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
