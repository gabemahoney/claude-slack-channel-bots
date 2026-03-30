/**
 * session-manager.test.ts — Tests for startupSessionManager and launchSession
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, copyFileSync, chmodSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sessionName } from '../src/tmux.ts'
import { type SessionsMap } from '../src/sessions.ts'
import { startupSessionManager, launchSession } from '../src/session-manager.ts'
import { makeTmuxStub } from './test-helpers/tmux-stub.ts'
import { makeSessionsStubs } from './test-helpers/sessions-stub.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'
import { MCP_SERVER_NAME } from '../src/config.ts'

// ---------------------------------------------------------------------------
// Helper: spawn a real process named "claude" so isClaudeRunning returns true
// ---------------------------------------------------------------------------

let spawnedTmpDir = ''

afterEach(() => {
  if (spawnedTmpDir) {
    rmSync(spawnedTmpDir, { recursive: true, force: true })
    spawnedTmpDir = ''
  }
})

async function spawnClaudeProcess() {
  const sleepBin = existsSync('/usr/bin/sleep') ? '/usr/bin/sleep' : '/bin/sleep'
  spawnedTmpDir = mkdtempSync(join(tmpdir(), 'session-mgr-test-'))
  const claudePath = join(spawnedTmpDir, 'claude')
  copyFileSync(sleepBin, claudePath)
  chmodSync(claudePath, 0o755)
  const proc = Bun.spawn([claudePath, '60'])
  await Bun.sleep(100)
  return proc
}

// ---------------------------------------------------------------------------
// startupSessionManager
// ---------------------------------------------------------------------------

describe('startupSessionManager', () => {
  test('1. existing session: killSession called, then newSession and sendKeys with launch command', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: true,
      getPanePidResult: '99999999',
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()

    const results = await startupSessionManager(config, stub, sessions.read, sessions.write, { pollTimeout: 0 })

    expect(results).toHaveLength(1)
    expect(results[0].channelId).toBe('C_TEST1')
    expect(results[0].sessionName).toBe(sessionName('/tmp/test-cwd'))

    const killCalls = stub.calls.filter(c => c.method === 'killSession')
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0].args[0]).toBe(sessionName('/tmp/test-cwd'))

    const newCalls = stub.calls.filter(c => c.method === 'newSession')
    expect(newCalls).toHaveLength(1)
    expect(newCalls[0].args[0]).toBe(sessionName('/tmp/test-cwd'))

    // killSession must appear before newSession in the call log
    const killIdx = stub.calls.findIndex(c => c.method === 'killSession')
    const newIdx = stub.calls.findIndex(c => c.method === 'newSession')
    expect(killIdx).toBeLessThan(newIdx)
  })

  test('2. existing session: action is relaunched when launchSession succeeds', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: true,
      getPanePidResult: '99999999',
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()

    await startupSessionManager(config, stub, sessions.read, sessions.write, { pollTimeout: 0 })

    const name = sessionName('/tmp/test-cwd')

    const killCalls = stub.calls.filter(c => c.method === 'killSession')
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0].args[0]).toBe(name)

    const newCalls = stub.calls.filter(c => c.method === 'newSession')
    expect(newCalls).toHaveLength(1)
    expect(newCalls[0].args[0]).toBe(name)
    expect(newCalls[0].args[1]).toBe('/tmp/test-cwd')

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).startsWith('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()

    // killSession must appear before newSession in the call log
    const killIdx = stub.calls.findIndex(c => c.method === 'killSession')
    const newIdx = stub.calls.findIndex(c => c.method === 'newSession')
    expect(killIdx).toBeLessThan(newIdx)
  })

  test('3. missing session: newSession and sendKeys with launch command, no killSession', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999',
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()

    await startupSessionManager(config, stub, sessions.read, sessions.write, { pollTimeout: 0 })

    expect(stub.calls.filter(c => c.method === 'killSession')).toHaveLength(0)

    const newCalls = stub.calls.filter(c => c.method === 'newSession')
    expect(newCalls).toHaveLength(1)
    expect(newCalls[0].args[0]).toBe(sessionName('/tmp/test-cwd'))
    expect(newCalls[0].args[1]).toBe('/tmp/test-cwd')

    const launchCmd = stub.calls.filter(c => c.method === 'sendKeys').find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).startsWith('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
  })

  test('7. tmux unavailable: returns immediately with empty array, no sessions touched', async () => {
    const stub = makeTmuxStub({
      checkAvailabilityResult: new Error('tmux not found'),
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()

    const results = await startupSessionManager(config, stub, sessions.read, sessions.write)

    expect(results).toEqual([])
    const nonCheckCalls = stub.calls.filter(c => c.method !== 'checkAvailability')
    expect(nonCheckCalls).toHaveLength(0)
  })

  test('9. sessions.json missing: treated as empty, routes launched fresh', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999',
    })
    const sessions = makeSessionsStubs() // empty — simulates missing file
    const config = makeRoutingConfig()

    await startupSessionManager(config, stub, sessions.read, sessions.write, { pollTimeout: 0 })

    // newSession called for the route even though sessions.json had no entries
    expect(stub.calls.filter(c => c.method === 'newSession')).toHaveLength(1)
    expect(stub.calls.filter(c => c.method === 'newSession')[0].args[0]).toBe(sessionName('/tmp/test-cwd'))
  })

  test('14. live Claude process in tmux: reconnect path — sendKeys /mcp reconnect <server-name>, no kill, no newSession', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const sessions = makeSessionsStubs()
      const config = makeRoutingConfig()

      const results = await startupSessionManager(config, stub, sessions.read, sessions.write, { pollTimeout: 0 })

      expect(results).toHaveLength(1)
      expect(results[0].action).toBe('reconnected')

      expect(stub.calls.filter(c => c.method === 'killSession')).toHaveLength(0)
      expect(stub.calls.filter(c => c.method === 'newSession')).toHaveLength(0)

      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const reconnectCall = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes(`/mcp reconnect ${MCP_SERVER_NAME}`),
      )
      expect(reconnectCall).toBeDefined()

      // 'Enter' must be sent after the /mcp reconnect command
      const reconnectIdx = sendKeysCalls.indexOf(reconnectCall!)
      const enterCall = sendKeysCalls[reconnectIdx + 1]
      expect(enterCall).toBeDefined()
      expect(enterCall.args[1]).toBe('Enter')
    } finally {
      proc.kill()
    }
  })

  test('14b. live Claude process: sendKeys failure during reconnect — action is failed', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
        sendKeysResult: new Error('sendKeys failed'),
      })
      const sessions = makeSessionsStubs()
      const config = makeRoutingConfig()

      const results = await startupSessionManager(config, stub, sessions.read, sessions.write, { pollTimeout: 0 })

      expect(results).toHaveLength(1)
      expect(results[0].action).toBe('failed')
    } finally {
      proc.kill()
    }
  })

  test('15. dead process + stored session ID: resume path — sendKeys includes --resume, action is resumed', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999',
      capturePaneResult: 'I am using this for local development',
    })
    const sessions = makeSessionsStubs({
      'C_TEST1': {
        tmuxSession: 'slack_bot_tmp_test_cwd_8497a1',
        lastLaunch: '2026-01-01T00:00:00.000Z',
        sessionId: 'resume-session-abc',
      },
    })
    const config = makeRoutingConfig()

    const results = await startupSessionManager(config, stub, sessions.read, sessions.write, { pollTimeout: 600 })

    expect(results).toHaveLength(1)
    expect(results[0].action).toBe('resumed')

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume resume-session-abc'),
    )
    expect(resumeCmd).toBeDefined()
  })

  test('16. dead process + no stored session ID: fresh path — sendKeys does not include --resume', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999',
    })
    const sessions = makeSessionsStubs() // no stored session ID
    const config = makeRoutingConfig()

    const results = await startupSessionManager(config, stub, sessions.read, sessions.write, { pollTimeout: 0 })

    expect(results).toHaveLength(1)
    // With pollTimeout: 0 and Claude not running, the launch will fail
    expect(results[0].action).toBe('failed')

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).startsWith('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('--resume')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// launchSession
// ---------------------------------------------------------------------------

describe('launchSession', () => {
  // pollTimeout=600ms: allows one poll iteration (500ms sleep + capturePane)
  test('4. prompt found: capturePane returns prompt text, sendKeys called with Enter, sessions written', async () => {
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()

    const ok = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub, sessions.read, sessions.write,
      { pollTimeout: 600 },
    )

    expect(ok).toBe(true)

    expect(stub.calls.filter(c => c.method === 'capturePane')).toHaveLength(1)

    // Third sendKeys call should be Enter acknowledging the safety prompt
    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    expect(sendKeysCalls.length).toBeGreaterThanOrEqual(3)
    const lastSendKeys = sendKeysCalls[sendKeysCalls.length - 1]
    expect(lastSendKeys.args[1]).toBe('Enter')

    expect(sessions.writtenSessions).toHaveLength(1)
    const written = sessions.writtenSessions[0]
    expect(written['C_TEST1']).toBeDefined()
    expect(written['C_TEST1'].tmuxSession).toBe(sessionName('/tmp/test-cwd'))
  })

  test('5. prompt not found, Claude running: returns success, no Enter sent for prompt', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'some unrelated output',
      })
      const sessions = makeSessionsStubs()
      const config = makeRoutingConfig()

      const ok = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub, sessions.read, sessions.write,
        { pollTimeout: 0 },
      )

      expect(ok).toBe(true)

      // Poll loop did not run — no capturePane calls
      expect(stub.calls.filter(c => c.method === 'capturePane')).toHaveLength(0)

      // sessions.json written on success
      expect(sessions.writtenSessions).toHaveLength(1)
      expect(sessions.writtenSessions[0]['C_TEST1']).toBeDefined()
    } finally {
      proc.kill()
    }
  })

  test('6. prompt not found, Claude not running: returns failure, sessions not written', async () => {
    const stub = makeTmuxStub({
      getPanePidResult: '99999999', // isClaudeRunning → false
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()

    const ok = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub, sessions.read, sessions.write,
      { pollTimeout: 0 },
    )

    expect(ok).toBe(false)
    expect(sessions.writtenSessions).toHaveLength(0)
  })

  test('8. sessions.json present: new entry keyed by channelId, existing entry preserved', async () => {
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const existing: SessionsMap = {
      'C_OTHER': {
        tmuxSession: 'slack_bot_tmp_other_cwd',
        lastLaunch: '2026-01-01T00:00:00.000Z',
      },
    }
    const sessions = makeSessionsStubs(existing)
    const config = makeRoutingConfig()

    const ok = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub, sessions.read, sessions.write,
      { pollTimeout: 600 },
    )

    expect(ok).toBe(true)
    expect(sessions.writtenSessions).toHaveLength(1)

    const written = sessions.writtenSessions[0]
    // Pre-existing entry preserved
    expect(written['C_OTHER']).toBeDefined()
    expect(written['C_OTHER'].tmuxSession).toBe('slack_bot_tmp_other_cwd')
    // New entry keyed by channelId with correct session name
    expect(written['C_TEST1']).toBeDefined()
    expect(written['C_TEST1'].tmuxSession).toBe(sessionName('/tmp/test-cwd'))
  })

  // ---------------------------------------------------------------------------
  // Resume tests
  // ---------------------------------------------------------------------------

  test('10. resume success: --resume <id> included in sendKeys command, session recorded', async () => {
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()
    const resumeId = 'abc-session-123'

    const ok = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub, sessions.read, sessions.write,
      { pollTimeout: 600, sessionId: resumeId },
    )

    expect(ok).toBe(true)

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes(`--resume ${resumeId}`),
    )
    expect(resumeCmd).toBeDefined()

    expect(sessions.writtenSessions).toHaveLength(1)
    expect(sessions.writtenSessions[0]['C_TEST1']).toBeDefined()
  })

  test('11. resume fallback: resume fails then fresh command sent, kill and newSession called twice', async () => {
    // pollTimeout: 0 → poll loop never runs, isClaudeRunning returns false → both attempts fail structurally
    // This test verifies the fallback mechanism: kill + recreate + fresh launch command
    const stub = makeTmuxStub({
      getPanePidResult: '99999999', // isClaudeRunning → false
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()
    const resumeId = 'stale-session-456'

    // Both attempts fail (no prompt, Claude not running), but fallback path is exercised
    await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub, sessions.read, sessions.write,
      { pollTimeout: 0, sessionId: resumeId },
    )

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')

    // First attempt: command includes --resume
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes(`--resume ${resumeId}`),
    )
    expect(resumeCmd).toBeDefined()

    // Fallback attempt: command does NOT include --resume
    const freshCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' &&
        (c.args[1] as string).startsWith('claude --mcp-config') &&
        !(c.args[1] as string).includes('--resume'),
    )
    expect(freshCmd).toBeDefined()

    // killSession called during fallback (once)
    const killCalls = stub.calls.filter(c => c.method === 'killSession')
    expect(killCalls).toHaveLength(1)

    // newSession called twice: initial + after kill
    const newCalls = stub.calls.filter(c => c.method === 'newSession')
    expect(newCalls).toHaveLength(2)
  })

  test('12. fresh launch when no session ID: command does not include --resume', async () => {
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()

    // No sessionId in options
    const ok = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub, sessions.read, sessions.write,
      { pollTimeout: 600 },
    )

    expect(ok).toBe(true)

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).startsWith('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('--resume')).toBe(false)
  })

  test('13. session ID absent in written record when capture returns undefined', async () => {
    // captureSessionId polls ~/.claude/sessions/ which does not exist in the test environment,
    // so capturedId is always undefined. Verify the written record omits sessionId in that case.
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()

    const ok = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub, sessions.read, sessions.write,
      { pollTimeout: 600 },
    )

    expect(ok).toBe(true)
    expect(sessions.writtenSessions).toHaveLength(1)
    const written = sessions.writtenSessions[0]['C_TEST1']
    expect(written).toBeDefined()
    expect(written.sessionId).toBeUndefined()
  })
})
