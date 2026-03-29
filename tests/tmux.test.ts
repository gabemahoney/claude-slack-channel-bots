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
    expect(sessionName('/tmp/test-cwd')).toBe('slack_bot_tmp_test_cwd_8497a1')
  })

  test('normalizes dots in the path', () => {
    expect(sessionName('/path/with.dots')).toBe('slack_bot_path_with_dots_2b6cb8')
  })

  test('normalizes dashes in the path', () => {
    expect(sessionName('/path/with-dashes')).toBe('slack_bot_path_with_dashes_764618')
  })

  test('normalizes colons in the path', () => {
    expect(sessionName('/path:with:colons')).toBe('slack_bot_path_with_colons_4c438a')
  })

  test('strips leading underscores produced by leading slash normalization', () => {
    // /foo → _foo → strip leading _ → foo → slack_bot_foo_<hash>
    expect(sessionName('/foo')).toBe('slack_bot_foo_1effb2')
  })

  test('expands ~ to home directory', () => {
    const home = homedir()
    // e.g. ~/projects/foo → /home/user/projects/foo → normalized
    const expected = sessionName(home + '/projects/foo')
    expect(sessionName('~/projects/foo')).toBe(expected)
  })

  test('handles empty string', () => {
    expect(sessionName('')).toBe('slack_bot__d41d8c')
  })

  test('handles root path /', () => {
    // / → _ → strip leading _ → '' → slack_bot__<hash>
    expect(sessionName('/')).toBe('slack_bot__6666cd')
  })

  // Regression: old implementation used channelId-based naming and a different prefix.
  // This test would FAIL with the old sessionName(channelId) → `slack_channel_bot_${channelId}`
  // and PASSES with the new CWD-based normalization.
  test('collision resistance: paths that normalize identically but differ produce different session names', () => {
    // Both paths normalize to tmp_my_project but have different hashes
    const a = sessionName('/tmp/my-project')
    const b = sessionName('/tmp/my_project')
    expect(a).toStartWith('slack_bot_tmp_my_project_')
    expect(b).toStartWith('slack_bot_tmp_my_project_')
    expect(a).not.toBe(b)
  })

  test('regression: CWD input produces slack_bot_ prefix, not slack_channel_bot_', () => {
    const result = sessionName('/tmp/project')
    // Old code: 'slack_channel_bot_/tmp/project'
    // New code: 'slack_bot_tmp_project_<hash>'
    expect(result).toBe('slack_bot_tmp_project_f6a64e')
    expect(result).not.toContain('slack_channel_bot_')
    expect(result).not.toContain('/')
  })

  // Truncation guard tests
  test('very long path produces a session name within the length bound', () => {
    // MAX_STRIPPED=239, overhead=17 → max possible result is 256 chars
    const longPath = '/tmp/' + 'a'.repeat(300)
    const result = sessionName(longPath)
    expect(result.length).toBeLessThanOrEqual(256)
  })

  test('truncation preserves the rightmost path segments', () => {
    // Build a path long enough to trigger truncation, with a known suffix
    // '/some/project/' (14) + 'x'*250 (250) + '/the_end' (8) = 272 chars → triggers truncation
    const longPath = '/some/project/' + 'x'.repeat(250) + '/the_end'
    const result = sessionName(longPath)
    // The rightmost segment is kept; the leftmost is discarded
    expect(result).toContain('the_end')
  })

  test('strips leading underscores from truncated content when boundary falls on a separator', () => {
    // '/' + 'a'*63 + '/' + 'b'*238 → normalized+stripped = 'a'*63 + '_' + 'b'*238 (302 chars)
    // Truncation keeps last 239 chars: '_' + 'b'*238 → leading _ stripped → 'b'*238
    // Without the strip, result would start with 'slack_bot__' (double underscore)
    const boundaryPath = '/' + 'a'.repeat(63) + '/' + 'b'.repeat(238)
    const result = sessionName(boundaryPath)
    expect(result).not.toMatch(/^slack_bot__/)
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
