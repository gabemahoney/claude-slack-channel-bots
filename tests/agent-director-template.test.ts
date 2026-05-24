/**
 * agent-director-template.test.ts — SR-3.2 / SR-3.1 template install.
 *
 * Covers:
 *   - buildTemplateParams() produces the SR-3.1 shape (relay_mode='on',
 *     label=['service=cscb'], deny=['AskUserQuestion'], overwrite: true,
 *     claude_args with the four required CLI flags).
 *   - --append-system-prompt-file is appended when the file is readable,
 *     and omitted (with a stderr warning) when accessSync throws.
 *   - installSlackChannelBotTemplate() calls client.makeTemplate(...) with
 *     exactly the buildTemplateParams shape, and propagates the result.
 *   - Rejections from client.makeTemplate(...) — typed AgentDirectorError
 *     and generic Error — both record a fatal startup error and exit.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'

import {
  buildTemplateParams,
  installSlackChannelBotTemplate,
} from '../src/agent-director-template.ts'
import {
  cannedMakeTemplate,
  errTemplateMalformed,
  errTemplateNameUnsafe,
  makeStubClient,
} from './test-helpers/agent-director-stub.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

// ---------------------------------------------------------------------------
// buildTemplateParams — SR-3.1 shape
// ---------------------------------------------------------------------------

describe('buildTemplateParams (SR-3.1)', () => {
  test('produces the canonical SR-3.1 shape with overwrite=true', () => {
    const cfg = makeRoutingConfig({
      mcp_config_path: '/abs/mcp.json',
      system_prompt_mode: 'none',
    })
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
    expect(params.extra_env).toBeUndefined()
  })

  test('appends --append-system-prompt-file when readable', () => {
    const cfg = makeRoutingConfig({
      append_system_prompt_file: '/etc/cscb/extra.md',
      system_prompt_mode: 'append',
    })
    const params = buildTemplateParams(cfg, {
      accessSync: (_p, _mode) => { /* readable: no throw */ },
      stderrWrite: () => { /* should not be called */ },
    })
    expect(params.claude_args).toContain('--append-system-prompt-file')
    expect(params.claude_args).toContain('/etc/cscb/extra.md')
  })

  test('omits --append-system-prompt-file when unreadable + emits one stderr warning', () => {
    const cfg = makeRoutingConfig({
      append_system_prompt_file: '/etc/cscb/extra.md',
      system_prompt_mode: 'append',
    })
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
    const cfg = makeRoutingConfig({
      append_system_prompt_file: '/etc/cscb/extra.md',
      system_prompt_mode: 'none',
    })
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
    const cfg = makeRoutingConfig({ system_prompt_mode: 'append' })
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
    const calls: Parameters<typeof buildTemplateParams>[0][] = []
    const makeTemplateCalls: import('agent-director').MakeTemplateParams[] = []
    const stub = makeStubClient({
      makeTemplateResult: cannedMakeTemplate('/home/u/.agent-director/templates/slack-channel-bot.toml'),
      makeTemplateCalls,
    })
    const cfg = makeRoutingConfig({
      mcp_config_path: '/abs/mcp.json',
      system_prompt_mode: 'none',
    })
    calls.push(cfg)
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
    const cfg = makeRoutingConfig({ system_prompt_mode: 'none' })
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
    const cfg = makeRoutingConfig({ system_prompt_mode: 'none' })
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
    const cfg = makeRoutingConfig({ system_prompt_mode: 'none' })
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
