/**
 * hook-guard.test.ts — Tests for hook script env-var guard and deny-on-error behavior
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { join } from 'path'

const HOOKS_DIR = join(import.meta.dir, '..', 'hooks')
const DEFAULT_PAYLOAD = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' })

async function runHook(
  scriptName: string,
  env: Record<string, string> = {},
  payload: string = DEFAULT_PAYLOAD,
): Promise<{ exitCode: number; stdout: string }> {
  const scriptPath = join(HOOKS_DIR, scriptName)
  const proc = Bun.spawn(['bash', scriptPath], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp', ...env },
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return { exitCode: proc.exitCode ?? -1, stdout }
}

describe('hook guards — no env var', () => {
  test('permission-relay.sh exits 0 with empty stdout when CLAUDE_MANAGED_CHANNEL is unset', async () => {
    const { exitCode, stdout } = await runHook('permission-relay.sh')
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('')
  })

  test('ask-relay.sh exits 0 with empty stdout when CLAUDE_MANAGED_CHANNEL is unset', async () => {
    const { exitCode, stdout } = await runHook('ask-relay.sh')
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('')
  })
})

describe('hook guards — env var set, no server', () => {
  test('permission-relay.sh emits deny JSON when CLAUDE_MANAGED_CHANNEL is set and server unreachable', async () => {
    const { exitCode, stdout } = await runHook('permission-relay.sh', { CLAUDE_MANAGED_CHANNEL: 'C_TEST1' })
    expect(exitCode).toBe(0)
    expect(stdout.trim()).not.toBe('')
    const parsed = JSON.parse(stdout.trim())
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
    expect(parsed.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(typeof parsed.hookSpecificOutput.decision.message).toBe('string')
    expect(parsed.hookSpecificOutput.decision.message.length).toBeGreaterThan(0)
  })

  test('ask-relay.sh emits deny JSON when CLAUDE_MANAGED_CHANNEL is set and server unreachable', async () => {
    const askPayload = JSON.stringify({
      tool_name: 'AskUserQuestion',
      tool_input: { question: 'Q?', options: ['A', 'B'] },
    })
    const { exitCode, stdout } = await runHook('ask-relay.sh', { CLAUDE_MANAGED_CHANNEL: 'C_TEST1' }, askPayload)
    expect(exitCode).toBe(0)
    expect(stdout.trim()).not.toBe('')
    const parsed = JSON.parse(stdout.trim())
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
  })
})
