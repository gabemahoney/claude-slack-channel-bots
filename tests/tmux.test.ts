/**
 * tmux.test.ts — Tests for sessionName() and isClaudeRunning()
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, chmodSync, existsSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
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
  test('uses the slack_bot_ prefix', () => {
    expect(sessionName('/tmp/test-cwd')).toStartWith('slack_bot_')
  })

  test('returns correct session name for a standard absolute path', () => {
    expect(sessionName('/tmp/test-cwd')).toBe('slack_bot_tmp_test_cwd')
  })

  test('normalizes dots in the path', () => {
    expect(sessionName('/path/with.dots')).toBe('slack_bot_path_with_dots')
  })

  test('normalizes dashes in the path', () => {
    expect(sessionName('/path/with-dashes')).toBe('slack_bot_path_with_dashes')
  })

  test('normalizes colons in the path', () => {
    expect(sessionName('/path:with:colons')).toBe('slack_bot_path_with_colons')
  })

  test('strips leading underscores produced by leading slash normalization', () => {
    // /foo → _foo → strip leading _ → foo → slack_bot_foo
    expect(sessionName('/foo')).toBe('slack_bot_foo')
  })

  test('expands ~ to home directory', () => {
    const home = homedir()
    // e.g. ~/projects/foo → /home/user/projects/foo → normalized
    const expected = sessionName(home + '/projects/foo')
    expect(sessionName('~/projects/foo')).toBe(expected)
  })

  test('handles empty string', () => {
    expect(sessionName('')).toBe('slack_bot_')
  })

  test('handles root path /', () => {
    // / → _ → strip leading _ → '' → slack_bot_
    expect(sessionName('/')).toBe('slack_bot_')
  })

  // Regression: old implementation used channelId-based naming and a different prefix.
  // This test would FAIL with the old sessionName(channelId) → `slack_channel_bot_${channelId}`
  // and PASSES with the new CWD-based normalization.
  test('regression: CWD input produces slack_bot_ prefix, not slack_channel_bot_', () => {
    const result = sessionName('/tmp/project')
    // Old code: 'slack_channel_bot_/tmp/project'
    // New code: 'slack_bot_tmp_project'
    expect(result).toBe('slack_bot_tmp_project')
    expect(result).not.toContain('slack_channel_bot_')
    expect(result).not.toContain('/')
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
