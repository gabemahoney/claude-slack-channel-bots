/**
 * hook-guard.test.ts — Tests that hook scripts exit 0 early when the /is-managed endpoint is unreachable
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { join } from 'path'

const HOOKS_DIR = join(import.meta.dir, '..', 'hooks')
const FAKE_PAYLOAD = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' })

async function runHook(scriptName: string, env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string }> {
  const scriptPath = join(HOOKS_DIR, scriptName)
  const proc = Bun.spawn(['bash', scriptPath], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp', ...env },
    stdin: new TextEncoder().encode(FAKE_PAYLOAD),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return { exitCode: proc.exitCode ?? -1, stdout }
}

describe('hook guards — no server running', () => {
  test('permission-relay.sh exits 0 with no stdout when /is-managed is unreachable', async () => {
    const { exitCode, stdout } = await runHook('permission-relay.sh')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
  })

  test('ask-relay.sh exits 0 with no stdout when /is-managed is unreachable', async () => {
    const { exitCode, stdout } = await runHook('ask-relay.sh')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
  })
})
