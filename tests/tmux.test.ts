/**
 * tmux.test.ts — Tests for sessionName() and isClaudeRunning()
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, chmodSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sessionName, isClaudeRunning } from '../src/tmux.ts'
import { makeTmuxStub } from './test-helpers/tmux-stub.ts'

// ---------------------------------------------------------------------------
// Shared stub — reset before each test
// ---------------------------------------------------------------------------

let stub: ReturnType<typeof makeTmuxStub>

beforeEach(() => {
  stub = makeTmuxStub()
})

// ---------------------------------------------------------------------------
// Temp dir cleanup for isClaudeRunning test
// ---------------------------------------------------------------------------

let claudeTestTmpDir = ''

afterAll(() => {
  if (claudeTestTmpDir) rmSync(claudeTestTmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// sessionName()
// ---------------------------------------------------------------------------

describe('sessionName', () => {
  test('returns prefixed session name for a standard channel ID', () => {
    expect(sessionName('C123ABC')).toBe('slack_channel_bot_C123ABC')
  })

  test('uses the slack_channel_bot_ prefix', () => {
    expect(sessionName('CTEST')).toStartWith('slack_channel_bot_')
  })

  test('appends the channel ID verbatim', () => {
    const channelId = 'C_GENERAL_42'
    expect(sessionName(channelId)).toBe(`slack_channel_bot_${channelId}`)
  })

  test('handles short channel IDs', () => {
    expect(sessionName('C1')).toBe('slack_channel_bot_C1')
  })

  test('handles empty string', () => {
    expect(sessionName('')).toBe('slack_channel_bot_')
  })
})

// ---------------------------------------------------------------------------
// isClaudeRunning()
// ---------------------------------------------------------------------------

describe('isClaudeRunning', () => {
  test('returns false when getPanePid throws', async () => {
    const s = makeTmuxStub({ getPanePidResult: new Error('tmux gone') })
    expect(await isClaudeRunning('my-session', s)).toBe(false)
  })

  test('returns false when getPanePid returns a non-numeric string', async () => {
    const s = makeTmuxStub({ getPanePidResult: 'not-a-pid' })
    expect(await isClaudeRunning('my-session', s)).toBe(false)
  })

  test('returns false when getPanePid returns zero', async () => {
    const s = makeTmuxStub({ getPanePidResult: '0' })
    expect(await isClaudeRunning('my-session', s)).toBe(false)
  })

  test('returns false when getPanePid returns a negative PID', async () => {
    const s = makeTmuxStub({ getPanePidResult: '-1' })
    expect(await isClaudeRunning('my-session', s)).toBe(false)
  })

  test('returns false when no claude process exists under the pane PID', async () => {
    // PID 99999999 is above Linux max PID and will not appear in the process table
    const s = makeTmuxStub({ getPanePidResult: '99999999' })
    expect(await isClaudeRunning('my-session', s)).toBe(false)
  })

  test('passes the session name to getPanePid', async () => {
    // getPanePid throws so isClaudeRunning returns early — we just verify the call
    const s = makeTmuxStub({ getPanePidResult: new Error('bail') })
    await isClaudeRunning('target-session', s)
    expect(s.calls[0]).toEqual({ method: 'getPanePid', args: ['target-session'] })
  })

  test('returns true when a process named "claude" is found under the pane PID', async () => {
    // Copy a known binary to a temp file named "claude" so that ps reports comm="claude"
    const sleepBin = existsSync('/usr/bin/sleep') ? '/usr/bin/sleep' : '/bin/sleep'
    claudeTestTmpDir = mkdtempSync(join(tmpdir(), 'tmux-test-'))
    const claudePath = join(claudeTestTmpDir, 'claude')
    copyFileSync(sleepBin, claudePath)
    chmodSync(claudePath, 0o755)

    const proc = Bun.spawn([claudePath, '60'])
    // Brief pause for the process to appear in the OS process table
    await Bun.sleep(100)

    try {
      const s = makeTmuxStub({ getPanePidResult: String(proc.pid) })
      const result = await isClaudeRunning('test-session', s)
      expect(result).toBe(true)
    } finally {
      proc.kill()
    }
  })
})
