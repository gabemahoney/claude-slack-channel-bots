/**
 * tmux.test.ts — Tests for TmuxClient stub factory, sessionName(), and isClaudeRunning()
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, chmodSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sessionName, isClaudeRunning, type TmuxClient } from './tmux.ts'

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[] }

type TmuxStubOpts = {
  checkAvailabilityResult?: string | Error
  hasSessionResult?: boolean | Error
  getPanePidResult?: string | Error
  newSessionResult?: Error
  sendKeysResult?: Error
  capturePaneResult?: string | Error
  killSessionResult?: Error
}

/**
 * Returns a TmuxClient stub with configurable responses and a `calls` array
 * that records every invocation for assertion in tests.
 */
function makeTmuxStub(opts: TmuxStubOpts = {}): TmuxClient & { calls: Call[] } {
  const calls: Call[] = []

  return {
    calls,

    async checkAvailability() {
      calls.push({ method: 'checkAvailability', args: [] })
      const r = opts.checkAvailabilityResult ?? 'tmux 3.3a'
      if (r instanceof Error) throw r
      return r
    },

    async hasSession(name) {
      calls.push({ method: 'hasSession', args: [name] })
      const r = opts.hasSessionResult ?? true
      if (r instanceof Error) throw r
      return r
    },

    async getPanePid(session) {
      calls.push({ method: 'getPanePid', args: [session] })
      const r = opts.getPanePidResult ?? '12345'
      if (r instanceof Error) throw r
      return r
    },

    async newSession(name, cwd) {
      calls.push({ method: 'newSession', args: [name, cwd] })
      if (opts.newSessionResult instanceof Error) throw opts.newSessionResult
    },

    async sendKeys(session, keys) {
      calls.push({ method: 'sendKeys', args: [session, keys] })
      if (opts.sendKeysResult instanceof Error) throw opts.sendKeysResult
    },

    async capturePane(session) {
      calls.push({ method: 'capturePane', args: [session] })
      const r = opts.capturePaneResult ?? 'pane output'
      if (r instanceof Error) throw r
      return r
    },

    async killSession(session) {
      calls.push({ method: 'killSession', args: [session] })
      if (opts.killSessionResult instanceof Error) throw opts.killSessionResult
    },
  }
}

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
// TmuxClient stub — checkAvailability
// ---------------------------------------------------------------------------

describe('TmuxClient stub — checkAvailability', () => {
  test('returns configured version string', async () => {
    const s = makeTmuxStub({ checkAvailabilityResult: 'tmux 3.3a' })
    expect(await s.checkAvailability()).toBe('tmux 3.3a')
  })

  test('returns a different configured version string', async () => {
    const s = makeTmuxStub({ checkAvailabilityResult: 'tmux 2.9' })
    expect(await s.checkAvailability()).toBe('tmux 2.9')
  })

  test('throws configured error', async () => {
    const s = makeTmuxStub({ checkAvailabilityResult: new Error('tmux not found') })
    await expect(s.checkAvailability()).rejects.toThrow('tmux not found')
  })

  test('records call with no arguments', async () => {
    await stub.checkAvailability()
    expect(stub.calls).toEqual([{ method: 'checkAvailability', args: [] }])
  })
})

// ---------------------------------------------------------------------------
// TmuxClient stub — hasSession
// ---------------------------------------------------------------------------

describe('TmuxClient stub — hasSession', () => {
  test('returns true when configured', async () => {
    const s = makeTmuxStub({ hasSessionResult: true })
    expect(await s.hasSession('my-session')).toBe(true)
  })

  test('returns false when configured', async () => {
    const s = makeTmuxStub({ hasSessionResult: false })
    expect(await s.hasSession('my-session')).toBe(false)
  })

  test('throws configured error', async () => {
    const s = makeTmuxStub({ hasSessionResult: new Error('session check failed') })
    await expect(s.hasSession('my-session')).rejects.toThrow('session check failed')
  })

  test('records call with session name argument', async () => {
    await stub.hasSession('test-session')
    expect(stub.calls).toEqual([{ method: 'hasSession', args: ['test-session'] }])
  })
})

// ---------------------------------------------------------------------------
// TmuxClient stub — getPanePid
// ---------------------------------------------------------------------------

describe('TmuxClient stub — getPanePid', () => {
  test('returns configured PID string', async () => {
    const s = makeTmuxStub({ getPanePidResult: '42000' })
    expect(await s.getPanePid('my-session')).toBe('42000')
  })

  test('throws configured error', async () => {
    const s = makeTmuxStub({ getPanePidResult: new Error('no pane found') })
    await expect(s.getPanePid('my-session')).rejects.toThrow('no pane found')
  })

  test('records call with session argument', async () => {
    await stub.getPanePid('s1')
    expect(stub.calls).toEqual([{ method: 'getPanePid', args: ['s1'] }])
  })
})

// ---------------------------------------------------------------------------
// TmuxClient stub — newSession
// ---------------------------------------------------------------------------

describe('TmuxClient stub — newSession', () => {
  test('resolves without error by default', async () => {
    await expect(stub.newSession('s', '/tmp')).resolves.toBeUndefined()
  })

  test('throws configured error', async () => {
    const s = makeTmuxStub({ newSessionResult: new Error('session already exists') })
    await expect(s.newSession('s', '/tmp')).rejects.toThrow('session already exists')
  })

  test('records call with name and cwd arguments', async () => {
    await stub.newSession('my-bot', '/home/user/project')
    expect(stub.calls).toEqual([{ method: 'newSession', args: ['my-bot', '/home/user/project'] }])
  })
})

// ---------------------------------------------------------------------------
// TmuxClient stub — sendKeys
// ---------------------------------------------------------------------------

describe('TmuxClient stub — sendKeys', () => {
  test('resolves without error by default', async () => {
    await expect(stub.sendKeys('s', 'hello')).resolves.toBeUndefined()
  })

  test('throws configured error', async () => {
    const s = makeTmuxStub({ sendKeysResult: new Error('send failed') })
    await expect(s.sendKeys('s', 'hello')).rejects.toThrow('send failed')
  })

  test('records call with session and keys arguments', async () => {
    await stub.sendKeys('my-session', 'some text')
    expect(stub.calls).toEqual([{ method: 'sendKeys', args: ['my-session', 'some text'] }])
  })

  test('does not append Enter — keys are passed verbatim without trailing newline', async () => {
    await stub.sendKeys('s', 'hello world')
    // sendKeys does NOT append Enter; the caller controls what gets sent
    expect(stub.calls[0].args[1]).toBe('hello world')
  })
})

// ---------------------------------------------------------------------------
// TmuxClient stub — capturePane
// ---------------------------------------------------------------------------

describe('TmuxClient stub — capturePane', () => {
  test('returns configured pane content', async () => {
    const s = makeTmuxStub({ capturePaneResult: 'line1\nline2\n' })
    expect(await s.capturePane('s')).toBe('line1\nline2\n')
  })

  test('throws configured error', async () => {
    const s = makeTmuxStub({ capturePaneResult: new Error('capture failed') })
    await expect(s.capturePane('s')).rejects.toThrow('capture failed')
  })

  test('records call with session argument', async () => {
    await stub.capturePane('my-session')
    expect(stub.calls).toEqual([{ method: 'capturePane', args: ['my-session'] }])
  })
})

// ---------------------------------------------------------------------------
// TmuxClient stub — killSession
// ---------------------------------------------------------------------------

describe('TmuxClient stub — killSession', () => {
  test('resolves without error by default', async () => {
    await expect(stub.killSession('s')).resolves.toBeUndefined()
  })

  test('throws configured error', async () => {
    const s = makeTmuxStub({ killSessionResult: new Error('session not found') })
    await expect(s.killSession('s')).rejects.toThrow('session not found')
  })

  test('records call with session argument', async () => {
    await stub.killSession('my-session')
    expect(stub.calls).toEqual([{ method: 'killSession', args: ['my-session'] }])
  })
})

// ---------------------------------------------------------------------------
// Call capture — ordering and isolation
// ---------------------------------------------------------------------------

describe('call capture', () => {
  test('captures calls in order across multiple method invocations', async () => {
    await stub.hasSession('s')
    await stub.newSession('s', '/tmp')
    await stub.sendKeys('s', 'hi')
    expect(stub.calls).toEqual([
      { method: 'hasSession', args: ['s'] },
      { method: 'newSession', args: ['s', '/tmp'] },
      { method: 'sendKeys', args: ['s', 'hi'] },
    ])
  })

  test('calls array is empty at the start of each test (beforeEach reset)', () => {
    expect(stub.calls).toEqual([])
  })

  test('errors do not prevent the call from being recorded', async () => {
    const s = makeTmuxStub({ hasSessionResult: new Error('boom') })
    try { await s.hasSession('x') } catch {}
    expect(s.calls).toEqual([{ method: 'hasSession', args: ['x'] }])
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
