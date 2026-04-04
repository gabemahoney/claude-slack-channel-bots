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
import { startupSessionManager, launchSession, jsonlExistsForSession } from '../src/session-manager.ts'
import { makeTmuxStub } from './test-helpers/tmux-stub.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'
import { MCP_SERVER_NAME } from '../src/config.ts'

// ---------------------------------------------------------------------------
// Helper: spawn a real process named "claude" so isClaudeRunning returns true
// (used only by reconnect-path tests that call startupSessionManager)
// ---------------------------------------------------------------------------

let spawnedTmpDir = ''
const jsonlCleanupFiles: string[] = []

afterEach(() => {
  if (spawnedTmpDir) {
    rmSync(spawnedTmpDir, { recursive: true, force: true })
    spawnedTmpDir = ''
  }
  for (const f of jsonlCleanupFiles) {
    try { unlinkSync(f) } catch { /* ignore */ }
  }
  jsonlCleanupFiles.length = 0
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
  test('1. existing session + no stored session: killSession called, then newSession and sendKeys with launch command', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: true,
      getPanePidResult: '99999999',
    })
    const config = makeRoutingConfig()

    await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

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

  test('2. existing session + no stored session: newSession called with correct args and sendKeys includes launch command', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: true,
      getPanePidResult: '99999999',
    })
    const config = makeRoutingConfig()

    await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

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
    const config = makeRoutingConfig()

    await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

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

  test('7. tmux unavailable: returns empty Map immediately, no sessions touched', async () => {
    const stub = makeTmuxStub({
      checkAvailabilityResult: new Error('tmux not found'),
    })
    const config = makeRoutingConfig()

    const result = await startupSessionManager(config, stub, {})

    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
    const nonCheckCalls = stub.calls.filter(c => c.method !== 'checkAvailability')
    expect(nonCheckCalls).toHaveLength(0)
  })

  test('9. no stored sessions: treated as empty, routes launched fresh', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999',
    })
    const config = makeRoutingConfig()

    await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

    // newSession called for the route even though storedSessions was empty
    expect(stub.calls.filter(c => c.method === 'newSession')).toHaveLength(1)
    expect(stub.calls.filter(c => c.method === 'newSession')[0].args[0]).toBe(sessionName('/tmp/test-cwd'))
  })

  test('14. live Claude process in tmux: reconnect path — sendKeys /mcp reconnect <server-name> and Enter as variadic args, no kill, no newSession', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const storedSessions: SessionsMap = {
        'C_TEST1': {
          tmuxSession: sessionName('/tmp/test-cwd'),
          lastLaunch: '2026-01-01T00:00:00.000Z',
          sessionId: 'reconnect-session-id',
        },
      }
      const config = makeRoutingConfig()

      const result = await startupSessionManager(config, stub, storedSessions, { pollTimeout: 0 })

      // Reconnect path succeeds and returns a SessionRecord in the Map
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(1)
      const record = result.get('C_TEST1')
      expect(record).toBeDefined()
      expect(record!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
      expect(record!.sessionId).toBe('reconnect-session-id')
      expect(typeof record!.lastLaunch).toBe('string')

      expect(stub.calls.filter(c => c.method === 'killSession')).toHaveLength(0)
      expect(stub.calls.filter(c => c.method === 'newSession')).toHaveLength(0)

      // sendKeys called with variadic args: (session, '/mcp reconnect slack-channel-router', 'Enter')
      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const reconnectCall = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes(`/mcp reconnect ${MCP_SERVER_NAME}`),
      )
      expect(reconnectCall).toBeDefined()
      // 'Enter' passed as variadic third arg (index 2)
      expect(reconnectCall!.args[2]).toBe('Enter')
    } finally {
      proc.kill()
    }
  })

  test('14b. live Claude process: reconnect with no stored sessionId — channel is in Map with sessionId "pending"', async () => {
    const proc = await spawnClaudeProcess()
    try {
      // No stored session for this channel — reconnect falls back to 'pending'
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const config = makeRoutingConfig()

      const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

      // Reconnect still puts the channel in the Map (session is live)
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(1)
      const record = result.get('C_TEST1')
      expect(record).toBeDefined()
      expect(record!.sessionId).toBe('pending')

      // /mcp reconnect was still sent
      const reconnectCall = stub.calls.filter(c => c.method === 'sendKeys').find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes(`/mcp reconnect ${MCP_SERVER_NAME}`),
      )
      expect(reconnectCall).toBeDefined()
    } finally {
      proc.kill()
    }
  })

  test('14c. live Claude process: sendKeys throws during reconnect — channel not in returned Map', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
        sendKeysResult: new Error('sendKeys failed'),
      })
      const config = makeRoutingConfig()

      const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

      // sendKeys threw → Promise.allSettled catches the rejection → channel not in Map
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(0)
    } finally {
      proc.kill()
    }
  })

  test('15. dead process + stored session ID: resume path — sendKeys includes --resume, SessionRecord in returned Map', async () => {
    // JSONL must exist for resume path to be taken
    const jsonlDir = join(homedir(), '.claude', 'projects', '-tmp-test-cwd')
    mkdirSync(jsonlDir, { recursive: true })
    const jsonlPath = join(jsonlDir, 'resume-session-abc.jsonl')
    writeFileSync(jsonlPath, '', 'utf-8')
    jsonlCleanupFiles.push(jsonlPath)

    const stub = makeTmuxStub({
      hasSessionResult: false,
      capturePaneResult: 'I am using this for local development',
    })
    const storedSessions: SessionsMap = {
      'C_TEST1': {
        tmuxSession: 'slack_bot_tmp_test_cwd_8497a1',
        lastLaunch: '2026-01-01T00:00:00.000Z',
        sessionId: 'resume-session-abc',
      },
    }
    const config = makeRoutingConfig()

    const result = await startupSessionManager(config, stub, storedSessions, {
      pollTimeout: 2_000,
    })

    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(1)
    const record = result.get('C_TEST1')
    expect(record).toBeDefined()
    expect(record!.sessionId).toBe('resume-session-abc')
    expect(record!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
    expect(typeof record!.lastLaunch).toBe('string')

    // sendKeys was called with --resume <stored-session-id>
    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume resume-session-abc'),
    )
    expect(resumeCmd).toBeDefined()
  })

  test('B. JSONL missing for stored session ID → skip to fresh path (no --resume)', async () => {
    // Key regression test: with the JSONL pre-check fix, a stored session ID
    // whose JSONL file does not exist must NOT attempt --resume.
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999', // Claude never running → launch fails
    })
    const storedSessions: SessionsMap = {
      'C_TEST1': {
        tmuxSession: sessionName('/tmp/test-cwd'),
        lastLaunch: '2026-01-01T00:00:00.000Z',
        sessionId: 'missing-jsonl-session-id',
      },
    }
    const config = makeRoutingConfig()

    // Do NOT create the JSONL file — jsonlExistsForSession must return false
    const result = await startupSessionManager(config, stub, storedSessions, {
      pollTimeout: 0,
    })

    // Launch fails (pollTimeout:0, Claude not running), but the important thing is
    // --resume was never sent.
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume'),
    )
    expect(resumeCmd).toBeUndefined()

    // A launch command was still sent (fresh path)
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
  })

  test('16. dead process + no stored session ID: fresh path — sendKeys does not include --resume, launch fails → empty Map', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999',
    })
    const config = makeRoutingConfig()

    const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

    // pollTimeout: 0 with Claude not running → fresh launch fails → channel not in Map
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('--resume')).toBe(false)
  })

  test('stored session with sessionId "pending" → fresh path, no --resume', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999',
    })
    const config = makeRoutingConfig()
    const storedSessions: SessionsMap = {
      'C_TEST1': {
        tmuxSession: sessionName('/tmp/test-cwd'),
        lastLaunch: '2026-01-01T00:00:00.000Z',
        sessionId: 'pending',
      },
    }

    await startupSessionManager(config, stub, storedSessions, { pollTimeout: 0 })

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('--resume')).toBe(false)
  })

  test('concurrent: all routes start concurrently — two routes both launch', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      capturePaneResult: 'I am using this for local development',
    })

    const config: typeof makeRoutingConfig extends () => infer R ? R : never = {
      ...makeRoutingConfig(),
      routes: {
        'C_CH1': { cwd: '/tmp/test-cwd-ch1' },
        'C_CH2': { cwd: '/tmp/test-cwd-ch2' },
      },
    }

    const start = Date.now()
    const result = await startupSessionManager(config, stub, {}, {
      pollTimeout: 3_000,
    })
    const elapsed = Date.now() - start

    expect(result).toBeInstanceOf(Map)
    // Concurrency check: total time should be well under 2x pollTimeout
    expect(elapsed).toBeLessThan(6_000)
    // newSession called twice (one per route)
    expect(stub.calls.filter(c => c.method === 'newSession')).toHaveLength(2)
  })

  test('mixed: reconnect + resume + fresh — correct records in returned Map', async () => {
    // Route CH1: session exists, Claude running → reconnect
    // Route CH2: session missing, stored session ID → resume (JSONL must exist for Fix 1)
    // Route CH3: session missing, no stored session → fresh (fails with pollTimeout: 0)
    const proc = await spawnClaudeProcess()
    try {
      // Create JSONL file for CH2 resume path
      const ch2JsonlDir = join(homedir(), '.claude', 'projects', '-tmp-cwd-ch2')
      mkdirSync(ch2JsonlDir, { recursive: true })
      const ch2JsonlPath = join(ch2JsonlDir, 'stored-id-ch2.jsonl')
      writeFileSync(ch2JsonlPath, '', 'utf-8')
      jsonlCleanupFiles.push(ch2JsonlPath)

      const stub = makeTmuxStub({
        capturePaneResult: 'I am using this for local development',
      })

      // hasSession: true for CH1, false for CH2 and CH3
      stub.hasSession = async (name: string) => {
        stub.calls.push({ method: 'hasSession', args: [name] })
        return name === sessionName('/tmp/cwd-ch1')
      }

      // getPanePid: proc.pid for CH1 (running), never-exists PID for others
      stub.getPanePid = async (session: string) => {
        stub.calls.push({ method: 'getPanePid', args: [session] })
        if (session === sessionName('/tmp/cwd-ch1')) return String(proc.pid)
        return '99999999'
      }

      const config = {
        ...makeRoutingConfig(),
        routes: {
          'C_CH1': { cwd: '/tmp/cwd-ch1' },
          'C_CH2': { cwd: '/tmp/cwd-ch2' },
          'C_CH3': { cwd: '/tmp/cwd-ch3' },
        },
      }
      const storedSessions: SessionsMap = {
        'C_CH1': {
          tmuxSession: sessionName('/tmp/cwd-ch1'),
          lastLaunch: '2026-01-01T00:00:00.000Z',
          sessionId: 'reconnect-id-ch1',
        },
        'C_CH2': {
          tmuxSession: sessionName('/tmp/cwd-ch2'),
          lastLaunch: '2026-01-01T00:00:00.000Z',
          sessionId: 'stored-id-ch2',
        },
      }

      const result = await startupSessionManager(config, stub, storedSessions, {
        pollTimeout: 0,
      })

      expect(result).toBeInstanceOf(Map)

      // CH1: reconnect path — uses stored session ID
      const ch1 = result.get('C_CH1')
      expect(ch1).toBeDefined()
      expect(ch1!.sessionId).toBe('reconnect-id-ch1')

      // CH2: resume path — verify sendKeys was called with --resume stored-id-ch2
      const resumeCmd = stub.calls.filter(c => c.method === 'sendKeys').find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume stored-id-ch2'),
      )
      expect(resumeCmd).toBeDefined()

      // CH3: fresh path — sendKeys command does NOT include --resume
      const freshCmd = stub.calls.filter(c => c.method === 'sendKeys').find(
        c => typeof c.args[1] === 'string' &&
          (c.args[1] as string).includes('claude --mcp-config') &&
          !(c.args[1] as string).includes('--resume'),
      )
      expect(freshCmd).toBeDefined()
    } finally {
      proc.kill()
    }
  })

  test('T18: atomic write — startupSessionManager returns complete Map after all routes settle', async () => {
    // T18: sessions.json must be written exactly once after all routes settle.
    // startupSessionManager does NOT call writeSessions itself — it returns a
    // complete Map after Promise.allSettled, so the caller writes exactly once.
    // Both fresh launches succeed (prompt found) and return sessionId "pending".
    const stub = makeTmuxStub({
      hasSessionResult: false,
      capturePaneResult: 'I am using this for local development',
    })

    const config = {
      ...makeRoutingConfig(),
      routes: {
        'C_T18A': { cwd: '/tmp/test-cwd-t18a' },
        'C_T18B': { cwd: '/tmp/test-cwd-t18b' },
      },
    }

    const result = await startupSessionManager(config, stub, {}, {
      pollTimeout: 3_000,
    })

    // Both routes must be present — write-once semantics: caller has complete data
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(2)
    expect(result.has('C_T18A')).toBe(true)
    expect(result.has('C_T18B')).toBe(true)
    // Fresh launches return "pending"; sessionId is updated later by the tool-call hook
    expect(result.get('C_T18A')!.sessionId).toBe('pending')
    expect(result.get('C_T18B')!.sessionId).toBe('pending')
  })

  test('all-fail: all routes fail → returns empty Map', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999', // Claude never running
    })
    const config = makeRoutingConfig()

    const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// launchSession
// ---------------------------------------------------------------------------

describe('launchSession', () => {
  test('4. safety prompt found — fresh launch returns SessionRecord with sessionId "pending"', async () => {
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const config = makeRoutingConfig()

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 2_000 },
    )

    expect(result).not.toBeNull()
    expect(result!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
    expect(result!.sessionId).toBe('pending')
    expect(typeof result!.lastLaunch).toBe('string')

    // Enter was sent to acknowledge the safety prompt
    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const enterCalls = sendKeysCalls.filter(c => c.args[1] === 'Enter')
    expect(enterCalls.length).toBeGreaterThanOrEqual(2) // one for launch + one for prompt ack
  })

  test('5. fresh launch with no resume ID returns sessionId "pending" when safety prompt is acknowledged', async () => {
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const config = makeRoutingConfig()

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 2_000 },
    )

    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('pending')
    expect(result!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
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

  test('10. resume success: --resume <id> included in sendKeys command, returns SessionRecord with stored ID', async () => {
    const resumeId = 'abc-session-123'
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const config = makeRoutingConfig()

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 2_000, sessionId: resumeId },
    )

    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe(resumeId)

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes(`--resume ${resumeId}`),
    )
    expect(resumeCmd).toBeDefined()
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

  test('12. fresh launch when no session ID: command does not include --resume, returns sessionId "pending"', async () => {
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const config = makeRoutingConfig()

    // No sessionId in options
    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 2_000 },
    )

    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('pending')

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('--resume')).toBe(false)
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
      { pollTimeout: 600, sessionId: 'stale-id-xyz' },
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
      { pollTimeout: 600 },
    )

    // NO_CONVERSATION without resumeId is treated as null by the outer logic
    expect(result).toBeNull()

    // newSession called exactly once (initial), no kill triggered for non-resume case
    const newCalls = stub.calls.filter(c => c.method === 'newSession')
    expect(newCalls).toHaveLength(1)
  })

  test('timeout: safety prompt never appears — returns null', async () => {
    // capturePane returns unrelated output throughout; poll times out
    const stub = makeTmuxStub({
      capturePaneResult: 'some unrelated output',
    })
    const config = makeRoutingConfig()

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 600 },
    )

    expect(result).toBeNull()
  })

  // T23: Bare bash prompt detected — NOT IMPLEMENTED in launchSession.
  // The SRD describes detecting a bare shell prompt (e.g. "$ ") in pane output
  // as a signal that Claude exited unexpectedly during a --resume launch, which
  // should trigger a fresh fallback. This detection path has not been added to
  // launchSession. If implemented, the test would: stub capturePane to return
  // a bare "$ " prompt after a --resume attempt, then verify killSession is
  // called and a fresh launch is retried.
  // test.todo('T23: bare bash prompt detection triggers kill and fresh retry')

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

    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const config = makeRoutingConfig({ append_system_prompt_file: promptFile })

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 2_000 },
    )

    expect(result).not.toBeNull()

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const launchCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('claude --mcp-config'),
    )
    expect(launchCmd).toBeDefined()
    expect((launchCmd!.args[1] as string).includes('--append-system-prompt-file')).toBe(true)
    expect((launchCmd!.args[1] as string).includes(promptFile)).toBe(true)
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

    const resumeId = 'resume-session-xyz'
    const stub = makeTmuxStub({
      capturePaneResult: 'I am using this for local development',
    })
    const config = makeRoutingConfig({ append_system_prompt_file: promptFile })

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 2_000, sessionId: resumeId },
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
  })
})

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

describe('crash recovery', () => {
  // T24: Server crash before sessions.json write.
  // sessions.json does NOT exist (crashed before it was persisted).
  // Claude process is still alive in tmux. startupSessionManager reconnects
  // and uses storedId (which is absent here), falling back to "pending".
  // The tool-call hook will update sessionId on the next tool call.
  test('T24: crash before sessions.json write — reconnect branch fires and returns record with sessionId "pending"', async () => {
    const proc = await spawnClaudeProcess()
    try {
      // tmux session exists and Claude is alive — reconnect branch
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const config = makeRoutingConfig()

      // storedSessions is empty — sessions.json was never written (crashed before phase 11)
      const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

      // Reconnect branch fires and returns a record; sessionId starts as "pending"
      // (the tool-call hook will update it on the next tool call)
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(1)

      const record = result.get('C_TEST1')
      expect(record).toBeDefined()
      expect(record!.sessionId).toBe('pending')
      expect(record!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
      expect(typeof record!.lastLaunch).toBe('string')

      // No kill or newSession — reconnect path only sends /mcp reconnect
      expect(stub.calls.filter(c => c.method === 'killSession')).toHaveLength(0)
      expect(stub.calls.filter(c => c.method === 'newSession')).toHaveLength(0)
    } finally {
      proc.kill()
    }
  })

  test('T24: crash before sessions.json write — reconnect sends /mcp reconnect to the live session', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const config = makeRoutingConfig()

      await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const reconnectCall = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes(`/mcp reconnect ${MCP_SERVER_NAME}`),
      )
      expect(reconnectCall).toBeDefined()
      // 'Enter' passed as variadic third arg
      expect(reconnectCall!.args[2]).toBe('Enter')
    } finally {
      proc.kill()
    }
  })

  // T9: Force-killed session — stale ID in .last
  // storedSessions has a stale session ID that causes "No conversation found".
  // launchSession must detect the fast-fail, kill/recreate, then launch fresh.
  // The returned record has sessionId "pending" (set by the fresh path).
  test('T9: stale session ID fast-fails, fresh fallback launches and returns sessionId "pending"', async () => {
    // capturePaneResults: first call returns "No conversation found" (fast-fail trigger),
    // subsequent calls return the safety prompt so the fresh attempt succeeds.
    const stub = makeTmuxStub({
      capturePaneResults: [
        'No conversation found',
        'I am using this for local development',
      ],
    })
    const config = makeRoutingConfig()

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 5_000, sessionId: 'stale-force-killed-id' },
    )

    // Fresh fallback must succeed and return a record
    expect(result).not.toBeNull()

    // The returned session ID is "pending" (fresh path); not the stale resume ID
    expect(result!.sessionId).toBe('pending')
    expect(result!.sessionId).not.toBe('stale-force-killed-id')

    // Fast-fail path: kill was called at least once (to tear down the stale session)
    const killCalls = stub.calls.filter(c => c.method === 'killSession')
    expect(killCalls.length).toBeGreaterThanOrEqual(1)

    // At least one fresh launch command (no --resume) was sent after the fast-fail
    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const freshCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' &&
        (c.args[1] as string).includes('claude --mcp-config') &&
        !(c.args[1] as string).includes('--resume'),
    )
    expect(freshCmd).toBeDefined()
  })

  test('T9: stale session ID — initial launch command includes --resume with the stale ID', async () => {
    // Verify the resume was actually attempted before the fast-fail
    const stub = makeTmuxStub({
      getPanePidResult: '99999999', // Claude never running — both attempts fail
      capturePaneResults: [
        'No conversation found',
        'some output',
      ],
    })
    const config = makeRoutingConfig()

    await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 600, sessionId: 'stale-force-killed-id' },
    )

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume stale-force-killed-id'),
    )
    expect(resumeCmd).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// jsonlExistsForSession
// ---------------------------------------------------------------------------

describe('jsonlExistsForSession', () => {
  const jsonlUnitCleanup: string[] = []

  afterEach(() => {
    for (const f of jsonlUnitCleanup) {
      try { unlinkSync(f) } catch { /* ignore */ }
    }
    jsonlUnitCleanup.length = 0
  })

  test('returns true when JSONL file exists', () => {
    const cwd = '/tmp/test-cwd'
    const sessionId = 'unit-test-session-exists'
    const slug = '-tmp-test-cwd'
    const dir = join(homedir(), '.claude', 'projects', slug)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${sessionId}.jsonl`)
    writeFileSync(filePath, '', 'utf-8')
    jsonlUnitCleanup.push(filePath)

    expect(jsonlExistsForSession(cwd, sessionId)).toBe(true)
  })

  test('returns false when JSONL file does not exist', () => {
    const cwd = '/tmp/test-cwd'
    const sessionId = 'unit-test-session-nonexistent-' + Date.now()

    // Deliberately do not create the file
    expect(jsonlExistsForSession(cwd, sessionId)).toBe(false)
  })

  test('slug computation: /tmp/test-cwd → -tmp-test-cwd', () => {
    const sessionId = 'slug-test-session-' + Date.now()
    const slug = '-tmp-test-cwd'
    const dir = join(homedir(), '.claude', 'projects', slug)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${sessionId}.jsonl`)
    writeFileSync(filePath, '', 'utf-8')
    jsonlUnitCleanup.push(filePath)

    expect(jsonlExistsForSession('/tmp/test-cwd', sessionId)).toBe(true)
  })

  test('slug computation: /home/user/my_project → -home-user-my-project', () => {
    const sessionId = 'slug-test-underscores-' + Date.now()
    const slug = '-home-user-my-project'
    const dir = join(homedir(), '.claude', 'projects', slug)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${sessionId}.jsonl`)
    writeFileSync(filePath, '', 'utf-8')
    jsonlUnitCleanup.push(filePath)

    expect(jsonlExistsForSession('/home/user/my_project', sessionId)).toBe(true)
    // Verify a different slug would NOT find the file
    expect(jsonlExistsForSession('/home/user/my_project_other', sessionId)).toBe(false)
  })
})
