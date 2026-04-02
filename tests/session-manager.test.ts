/**
 * session-manager.test.ts — Tests for startupSessionManager and launchSession
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, existsSync, rmSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir, homedir } from 'os'
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
const claudeSessionFiles: string[] = []

afterEach(() => {
  if (spawnedTmpDir) {
    rmSync(spawnedTmpDir, { recursive: true, force: true })
    spawnedTmpDir = ''
  }
  for (const f of claudeSessionFiles) {
    try { unlinkSync(f) } catch { /* ignore */ }
  }
  claudeSessionFiles.length = 0
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

/**
 * Writes a fake ~/.claude/sessions/<pid>.json so PID-based discovery succeeds.
 * Registers the file for cleanup in afterEach.
 */
function writeClaudeSessionFile(pid: number, sessionId: string): string {
  const dir = join(homedir(), '.claude', 'sessions')
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${pid}.json`)
  writeFileSync(filePath, JSON.stringify({ sessionId }), 'utf-8')
  claudeSessionFiles.push(filePath)
  return filePath
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

  test('2. existing session: newSession called with correct args and sendKeys includes launch command', async () => {
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
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
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
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
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

  test('15. dead process + stored session ID: resume path — sendKeys includes --resume, action is resumed or failed', async () => {
    // With a real PID that resolves to a running process and a session file,
    // we can test the full resume path. With pollTimeout=600 and the prompt
    // text in capturePaneResult, PID discovery will run after earlyDetectAfterMs.
    const proc = await spawnClaudeProcess()
    try {
      writeClaudeSessionFile(proc.pid!, 'resume-session-abc')
      const stub = makeTmuxStub({
        hasSessionResult: false,
        getPanePidResult: String(proc.pid),
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

      const results = await startupSessionManager(config, stub, sessions.read, sessions.write, {
        pollTimeout: 2_000,
        earlyDetectAfterMs: 0,
      })

      expect(results).toHaveLength(1)
      expect(results[0].action).toBe('resumed')

      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const resumeCmd = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume resume-session-abc'),
      )
      expect(resumeCmd).toBeDefined()

      // sessions.json written with the discovered sessionId
      expect(sessions.writtenSessions).toHaveLength(1)
      expect(sessions.writtenSessions[0]['C_TEST1']?.sessionId).toBe('resume-session-abc')
    } finally {
      proc.kill()
    }
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
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('--resume')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// launchSession
// ---------------------------------------------------------------------------

describe('launchSession', () => {
  test('4. prompt found + PID session file present: returns SessionRecord with correct tmuxSession', async () => {
    const proc = await spawnClaudeProcess()
    try {
      writeClaudeSessionFile(proc.pid!, 'discovered-session-id')
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 2_000, earlyDetectAfterMs: 0 },
      )

      expect(result).not.toBeNull()
      expect(result!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
      expect(result!.sessionId).toBe('discovered-session-id')
      expect(typeof result!.lastLaunch).toBe('string')

      // Enter was sent to acknowledge the safety prompt
      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const enterCalls = sendKeysCalls.filter(c => c.args[1] === 'Enter')
      expect(enterCalls.length).toBeGreaterThanOrEqual(2) // one for launch + one for prompt ack
    } finally {
      proc.kill()
    }
  })

  test('5. prompt not found, Claude running, session file present: returns SessionRecord via PID discovery', async () => {
    const proc = await spawnClaudeProcess()
    try {
      writeClaudeSessionFile(proc.pid!, 'pid-discovered-session')
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'some unrelated output',
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 2_000, earlyDetectAfterMs: 0 },
      )

      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe('pid-discovered-session')
      expect(result!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
    } finally {
      proc.kill()
    }
  })

  test('6. prompt not found, Claude not running: returns null', async () => {
    const stub = makeTmuxStub({
      getPanePidResult: '99999999', // isClaudeRunning → false
    })
    const config = makeRoutingConfig()

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 0 },
    )

    expect(result).toBeNull()
  })

  test('10. resume success: --resume <id> included in sendKeys command, returns SessionRecord', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const resumeId = 'abc-session-123'
      writeClaudeSessionFile(proc.pid!, resumeId)
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 2_000, earlyDetectAfterMs: 0, sessionId: resumeId },
      )

      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe(resumeId)

      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const resumeCmd = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes(`--resume ${resumeId}`),
      )
      expect(resumeCmd).toBeDefined()
    } finally {
      proc.kill()
    }
  })

  test('11. resume fallback: resume fails then fresh command sent, kill and newSession called twice', async () => {
    // pollTimeout: 0 → poll loop never runs, isClaudeRunning returns false → both attempts fail structurally
    // This test verifies the fallback mechanism: kill + recreate + fresh launch command
    const stub = makeTmuxStub({
      getPanePidResult: '99999999', // isClaudeRunning → false
    })
    const config = makeRoutingConfig()
    const resumeId = 'stale-session-456'

    // Both attempts fail (no prompt, Claude not running), but fallback path is exercised
    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 0, sessionId: resumeId },
    )

    expect(result).toBeNull()

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')

    // First attempt: command includes --resume
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes(`--resume ${resumeId}`),
    )
    expect(resumeCmd).toBeDefined()

    // Fallback attempt: command does NOT include --resume
    const freshCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' &&
        (c.args[1] as string).includes('claude --mcp-config') &&
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
    const proc = await spawnClaudeProcess()
    try {
      writeClaudeSessionFile(proc.pid!, 'fresh-launch-session')
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig()

      // No sessionId in options
      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 2_000, earlyDetectAfterMs: 0 },
      )

      expect(result).not.toBeNull()

      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const launchCmd = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
      )
      expect(launchCmd).toBeDefined()
      expect((launchCmd!.args[1] as string).includes('--resume')).toBe(false)
    } finally {
      proc.kill()
    }
  })

  test('22. no safety prompt but Claude running inside loop: early detection accepts session, returns SessionRecord', async () => {
    const proc = await spawnClaudeProcess()
    try {
      writeClaudeSessionFile(proc.pid!, 'early-detect-session')
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'some unrelated output', // no safety prompt
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 5_000, earlyDetectAfterMs: 0 },
      )

      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe('early-detect-session')

      // Poll loop ran — capturePane was called at least once
      expect(stub.calls.filter(c => c.method === 'capturePane').length).toBeGreaterThanOrEqual(1)

      // Only two sendKeys for launch: command + Enter to run it — no Enter for safety prompt ack
      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      expect(sendKeysCalls).toHaveLength(2)
      expect(sendKeysCalls[1].args[1]).toBe('Enter')
    } finally {
      proc.kill()
    }
  })

  test('fast-fail: "No conversation found" in pane triggers kill, recreate, and fresh retry', async () => {
    // The fast-fail path: NO_CONVERSATION sentinel triggers kill+newSession+fresh attemptLaunch.
    // If that fresh attempt also fails (null), the "resume timed out or failed" fallback ALSO fires
    // (because resumeSessionId is still set), causing a second kill+newSession+fresh attempt.
    // Total: initial newSession + 2 kills + 2 newSessions = 3 newSessions total.
    const stub = makeTmuxStub({
      getPanePidResult: '99999999', // Claude not running — all attempts fail
      capturePaneResults: [
        'No conversation found',
        'some output',
        'some output',
      ],
    })
    const config = makeRoutingConfig()

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 600, sessionId: 'stale-id-xyz', earlyDetectAfterMs: 0 },
    )

    // All attempts fail
    expect(result).toBeNull()

    // The NO_CONVERSATION fast-fail fires first (kill #1 + newSession #2),
    // then the null resume fallback fires again (kill #2 + newSession #3)
    const killCalls = stub.calls.filter(c => c.method === 'killSession')
    expect(killCalls).toHaveLength(2)

    const newCalls = stub.calls.filter(c => c.method === 'newSession')
    expect(newCalls).toHaveLength(3)

    // First sendKeys launch includes --resume
    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume stale-id-xyz'),
    )
    expect(resumeCmd).toBeDefined()

    // At least one fresh launch command (no --resume)
    const freshCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' &&
        (c.args[1] as string).includes('claude --mcp-config') &&
        !(c.args[1] as string).includes('--resume'),
    )
    expect(freshCmd).toBeDefined()
  })

  test('fast-fail without resumeId: "No conversation found" without resumeId does not trigger kill/recreate', async () => {
    // When there is no resumeId, detecting NO_CONVERSATION still triggers the sentinel return,
    // but the outer logic only does kill/recreate when resumeSessionId is defined.
    // So the session fails but does NOT kill and recreate.
    const stub = makeTmuxStub({
      getPanePidResult: '99999999',
      capturePaneResult: 'No conversation found',
    })
    const config = makeRoutingConfig()

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 600, earlyDetectAfterMs: 0 },
    )

    // NO_CONVERSATION without resumeId is treated as null by the outer logic
    expect(result).toBeNull()

    // newSession called exactly once (initial), no kill triggered for non-resume case
    const newCalls = stub.calls.filter(c => c.method === 'newSession')
    expect(newCalls).toHaveLength(1)
  })

  test('timeout with Claude still running: returns null', async () => {
    const proc = await spawnClaudeProcess()
    try {
      // No session file — PID discovery will always fail, causing timeout
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'some unrelated output',
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 600, earlyDetectAfterMs: 0 },
      )

      // Timed out waiting for session file — returns null
      expect(result).toBeNull()
    } finally {
      proc.kill()
    }
  })

  test('launch command includes SLACK_CHANNEL_BOT_SESSION=1 env var', async () => {
    const stub = makeTmuxStub({
      getPanePidResult: '99999999',
    })
    const config = makeRoutingConfig()

    await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 0 },
    )

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('SLACK_CHANNEL_BOT_SESSION=1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// append_system_prompt_file
// ---------------------------------------------------------------------------

describe('append_system_prompt_file', () => {
  let tmpPromptDir = ''

  afterEach(() => {
    if (tmpPromptDir) {
      rmSync(tmpPromptDir, { recursive: true, force: true })
      tmpPromptDir = ''
    }
  })

  test('17. config field set + file exists: sendKeys command includes --append-system-prompt-file with path', async () => {
    tmpPromptDir = mkdtempSync(join(tmpdir(), 'append-prompt-test-'))
    const promptFile = join(tmpPromptDir, 'CLAUDE.md')
    writeFileSync(promptFile, 'You are a helpful assistant.')

    const proc = await spawnClaudeProcess()
    try {
      writeClaudeSessionFile(proc.pid!, 'append-prompt-session')
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig({ append_system_prompt_file: promptFile })

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 2_000, earlyDetectAfterMs: 0 },
      )

      expect(result).not.toBeNull()

      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const launchCmd = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
      )
      expect(launchCmd).toBeDefined()
      expect((launchCmd!.args[1] as string).includes('--append-system-prompt-file')).toBe(true)
      expect((launchCmd!.args[1] as string).includes(promptFile)).toBe(true)
    } finally {
      proc.kill()
    }
  })

  test('18. config field set + file missing: flag omitted, launch proceeds', async () => {
    const missingPath = '/tmp/nonexistent-prompt-file-that-does-not-exist.md'

    const stub = makeTmuxStub({
      getPanePidResult: '99999999',
    })
    const config = makeRoutingConfig({ append_system_prompt_file: missingPath })

    // pollTimeout:0 → launch will fail (Claude not running), but command was still sent
    await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 0 },
    )

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('--append-system-prompt-file')).toBe(false)
  })

  test('19. config field absent: flag omitted, launch command sent', async () => {
    const stub = makeTmuxStub({
      getPanePidResult: '99999999',
    })
    // No append_system_prompt_file in config
    const config = makeRoutingConfig()

    await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 0 },
    )

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('--append-system-prompt-file')).toBe(false)
  })

  test('20. path with single quotes: correctly shell-escaped in the command', async () => {
    // Create a temp dir whose path contains a single quote character
    const baseDir = mkdtempSync(join(tmpdir(), 'append-prompt-test-'))
    tmpPromptDir = baseDir
    // Create a subdirectory whose name contains a single quote
    const quotedDir = join(baseDir, "it's a test")
    mkdirSync(quotedDir, { recursive: true })
    const promptFile = join(quotedDir, 'CLAUDE.md')
    writeFileSync(promptFile, 'Prompt content.')

    const stub = makeTmuxStub({
      getPanePidResult: '99999999',
    })
    const config = makeRoutingConfig({ append_system_prompt_file: promptFile })

    await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 0 },
    )

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--append-system-prompt-file'),
    )
    expect(launchCmd).toBeDefined()

    const cmd = launchCmd!.args[1] as string
    // The raw single quote in the path must be shell-escaped (rendered as '\'' in single-quote context)
    expect(cmd.includes("'\\''")).toBe(true)
    // After shell-escaping "it's a test", it becomes 'it'\''s a test'
    const flagIndex = cmd.indexOf('--append-system-prompt-file')
    const afterFlag = cmd.slice(flagIndex)
    expect(afterFlag.includes("it'\\''s a test")).toBe(true)
  })

  test('21. resume launch with file present: --append-system-prompt-file appears alongside --resume', async () => {
    tmpPromptDir = mkdtempSync(join(tmpdir(), 'append-prompt-test-'))
    const promptFile = join(tmpPromptDir, 'CLAUDE.md')
    writeFileSync(promptFile, 'You are a helpful assistant.')

    const proc = await spawnClaudeProcess()
    try {
      const resumeId = 'resume-session-xyz'
      writeClaudeSessionFile(proc.pid!, resumeId)
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig({ append_system_prompt_file: promptFile })

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 2_000, earlyDetectAfterMs: 0, sessionId: resumeId },
      )

      expect(result).not.toBeNull()

      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const launchCmd = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' &&
          (c.args[1] as string).includes(`--resume ${resumeId}`),
      )
      expect(launchCmd).toBeDefined()
      expect((launchCmd!.args[1] as string).includes('--append-system-prompt-file')).toBe(true)
      expect((launchCmd!.args[1] as string).includes(promptFile)).toBe(true)
    } finally {
      proc.kill()
    }
  })
})
