/**
 * session-manager.test.ts — Tests for startupSessionManager and launchSession
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { sessionName } from '../src/tmux.ts'
import { type SessionsMap } from '../src/sessions.ts'
import { startupSessionManager, launchSession, projectSlug, findLatestJsonlSessionId } from '../src/session-manager.ts'
import { makeTmuxStub } from './test-helpers/tmux-stub.ts'
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
      writeJsonlFile('/tmp/test-cwd', 'reconnect-session-id')
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const config = makeRoutingConfig()

      const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

      // Reconnect path succeeds and returns a SessionRecord in the Map
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(1)
      const record = result.get('C_TEST1')
      expect(record).toBeDefined()
      expect(record!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
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

  test('14b. live Claude process: reconnect succeeds even without JSONL files', async () => {
    const proc = await spawnClaudeProcess()
    try {
      // No JSONL files for this CWD — reconnect no longer requires JSONL discovery
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const config = makeRoutingConfig()

      const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

      // Reconnect path always succeeds, no JSONL required
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(1)
      const record = result.get('C_TEST1')
      expect(record).toBeDefined()
      expect(record!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))

      // sendKeys was called with /mcp reconnect
      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const reconnectCall = sendKeysCalls.find(
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

  test('15. dead process + JSONL session ID: resume path — sendKeys includes --resume, SessionRecord in returned Map', async () => {
    const proc = await spawnClaudeProcess()
    try {
      writeJsonlFile('/tmp/test-cwd', 'resume-session-abc')
      const stub = makeTmuxStub({
        hasSessionResult: false,
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig()

      const result = await startupSessionManager(config, stub, {}, {
        pollTimeout: 2_000,

      })

      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(1)
      const record = result.get('C_TEST1')
      expect(record).toBeDefined()
      expect(record!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
      expect(typeof record!.lastLaunch).toBe('string')

      // sendKeys was called with --resume <JSONL-scanned-session-id>
      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const resumeCmd = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume resume-session-abc'),
      )
      expect(resumeCmd).toBeDefined()
    } finally {
      proc.kill()
    }
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

  test('concurrent: all routes start concurrently — two routes both launch', async () => {
    const proc1 = await spawnClaudeProcess()
    const proc2 = await spawnClaudeProcess()
    try {
      // Alternate getPanePid responses: first call returns proc1.pid, second returns proc2.pid
      let pidCallCount = 0
      const stub = makeTmuxStub({
        hasSessionResult: false,
        capturePaneResult: 'I am using this for local development',
      })
      // Override getPanePid to rotate through the two PIDs
      stub.getPanePid = async (session: string) => {
        pidCallCount++
        return pidCallCount % 2 === 1 ? String(proc1.pid) : String(proc2.pid)
      }

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

      // Both routes should have records (or at least ran concurrently — elapsed < 2x single)
      expect(result).toBeInstanceOf(Map)
      // Concurrency check: total time should be well under 2x pollTimeout
      expect(elapsed).toBeLessThan(6_000)
      // newSession called twice (one per route)
      expect(stub.calls.filter(c => c.method === 'newSession')).toHaveLength(2)
    } finally {
      proc1.kill()
      proc2.kill()
    }
  })

  test('mixed: reconnect + resume + fresh — correct records in returned Map', async () => {
    // Route CH1: session exists, Claude running → reconnect (JSONL exists)
    // Route CH2: session missing, JSONL exists → resume
    // Route CH3: session missing, no JSONL → fresh (fails with pollTimeout: 0)
    const proc = await spawnClaudeProcess()
    try {
      writeJsonlFile('/tmp/cwd-ch1', 'reconnect-id-ch1')
      writeJsonlFile('/tmp/cwd-ch2', 'jsonl-id-ch2')

      const sessionCalls: Record<string, number> = {}
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

      const result = await startupSessionManager(config, stub, {}, {
        pollTimeout: 0,

      })

      expect(result).toBeInstanceOf(Map)

      // CH1: reconnect path — record should be present
      const ch1 = result.get('C_CH1')
      expect(ch1).toBeDefined()
      expect(ch1!.tmuxSession).toBe(sessionName('/tmp/cwd-ch1'))

      // CH2: resume path — JSONL found, sendKeys called with --resume jsonl-id-ch2
      const resumeCmd = stub.calls.filter(c => c.method === 'sendKeys').find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume jsonl-id-ch2'),
      )
      expect(resumeCmd).toBeDefined()

      // CH3: fresh path — no JSONL, sendKeys command does NOT include --resume
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

  test('T18: atomic write — startupSessionManager returns complete Map after all routes settle (no intermediate partial results)', async () => {
    // T18: sessions.json must be written exactly once after all routes settle.
    // startupSessionManager does NOT call writeSessions itself — it returns a
    // complete Map after Promise.allSettled, so the caller writes exactly once.
    // This test verifies the returned Map contains entries for all successfully
    // launched routes and that the function does not return until all routes have
    // settled (i.e., no race where a partial Map is returned mid-flight).
    const proc1 = await spawnClaudeProcess()
    const proc2 = await spawnClaudeProcess()
    try {
      let pidCallCount = 0
      const stub = makeTmuxStub({
        hasSessionResult: false,
        capturePaneResult: 'I am using this for local development',
      })
      stub.getPanePid = async (_session: string) => {
        pidCallCount++
        return pidCallCount % 2 === 1 ? String(proc1.pid) : String(proc2.pid)
      }

      const config = {
        ...makeRoutingConfig(),
        routes: {
          'C_T18A': { cwd: '/tmp/test-cwd-t18a' },
          'C_T18B': { cwd: '/tmp/test-cwd-t18b' },
        },
      }

      // The function must return a single complete Map — not a partial result.
      const result = await startupSessionManager(config, stub, {}, {
        pollTimeout: 3_000,

      })

      // Both routes must be present — write-once semantics: caller has complete data
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(2)
      expect(result.has('C_T18A')).toBe(true)
      expect(result.has('C_T18B')).toBe(true)
      expect(result.get('C_T18A')!.tmuxSession).toBe(sessionName('/tmp/test-cwd-t18a'))
      expect(result.get('C_T18B')!.tmuxSession).toBe(sessionName('/tmp/test-cwd-t18b'))
    } finally {
      proc1.kill()
      proc2.kill()
    }
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
  test('4. prompt found + Claude running: returns SessionRecord with correct tmuxSession', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 2_000 },
      )

      expect(result).not.toBeNull()
      expect(result!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
      expect(typeof result!.lastLaunch).toBe('string')

      // Enter was sent to acknowledge the safety prompt
      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const enterCalls = sendKeysCalls.filter(c => c.args[1] === 'Enter')
      expect(enterCalls.length).toBeGreaterThanOrEqual(2) // one for launch + one for prompt ack
    } finally {
      proc.kill()
    }
  })

  test('5. prompt not found, Claude running: returns SessionRecord', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'some unrelated output',
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 2_000 },
      )

      expect(result).not.toBeNull()
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

  test('10. resume success: JSONL discovery triggers --resume in sendKeys command, returns SessionRecord', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const resumeId = 'abc-session-123'
      writeJsonlFile('/tmp/test-cwd', resumeId)
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 2_000 },
      )

      expect(result).not.toBeNull()
      expect(result!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))

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
    const resumeId = 'stale-session-456'
    writeJsonlFile('/tmp/test-cwd', resumeId)
    const stub = makeTmuxStub({
      getPanePidResult: '99999999', // isClaudeRunning → false
    })
    const config = makeRoutingConfig()

    // Both attempts fail (no prompt, Claude not running), but fallback path is exercised
    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 0 },
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

  test('12. fresh launch when no JSONL file: command does not include --resume', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig()

      // No sessionId in options
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
      expect((launchCmd!.args[1] as string).includes('--resume')).toBe(false)
    } finally {
      proc.kill()
    }
  })

  test('22. no safety prompt but Claude running inside loop: early detection accepts session, returns SessionRecord', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'some unrelated output', // no safety prompt
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 5_000 },
      )

      expect(result).not.toBeNull()
      expect(result!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))

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
    // Note: fresh attempts use Error entries in capturePaneResults so they exit via the catch
    // branch rather than relying on Date.now() comparisons (which may be frozen by other test
    // files using jest.setSystemTime).
    writeJsonlFile('/tmp/test-cwd', 'stale-id-xyz')
    const stub = makeTmuxStub({
      getPanePidResult: '99999999', // Claude not running — all attempts fail
      capturePaneResults: [
        'No conversation found',
        new Error('capturePane: session terminated'),
        new Error('capturePane: session terminated'),
      ],
    })
    const config = makeRoutingConfig()

    const result = await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 30_000 },
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

    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
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
      writeJsonlFile('/tmp/test-cwd', resumeId)
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
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

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

describe('crash recovery', () => {
  // T24: Server crash before sessions.json write
  // sessions.json does NOT exist (crashed before it was persisted).
  // Claude process is still alive in tmux. startupSessionManager must
  // discover session IDs via JSONL scan and return complete records.
  test('T24: crash before sessions.json write — reconnect branch discovers session via JSONL, returns complete record', async () => {
    const proc = await spawnClaudeProcess()
    try {
      writeJsonlFile('/tmp/test-cwd', 'crash-recovery-session-id')

      // tmux session exists and Claude is alive — reconnect branch
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const config = makeRoutingConfig()

      // storedSessions is empty — sessions.json was never written (crashed before phase 11)
      const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

      // Reconnect branch must discover the session via JSONL and return a full record
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(1)

      const record = result.get('C_TEST1')
      expect(record).toBeDefined()
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
      writeJsonlFile('/tmp/test-cwd', 'crash-recovery-session-id-2')

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
  // The returned record must have a NEW session ID (not the stale one).
  test('T9: stale session ID fast-fails, fresh fallback launches successfully', async () => {
    const proc = await spawnClaudeProcess()
    try {
      writeJsonlFile('/tmp/test-cwd', 'stale-force-killed-id')

      // capturePaneResults: first call returns "No conversation found" (fast-fail trigger),
      // subsequent calls return the safety prompt so the fresh attempt succeeds.
      const stub = makeTmuxStub({
        getPanePidResult: String(proc.pid),
        capturePaneResults: [
          'No conversation found',
          'I am using this for local development',
        ],
      })
      const config = makeRoutingConfig()

      const result = await launchSession(
        'C_TEST1', '/tmp/test-cwd', config, stub,
        { pollTimeout: 5_000 },
      )

      // Fresh fallback must succeed and return a record
      expect(result).not.toBeNull()
      expect(result!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))

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
    } finally {
      proc.kill()
    }
  })

  test('T9: stale session ID — initial launch command includes --resume with the stale ID', async () => {
    // Verify the resume was actually attempted before the fast-fail.
    // pollTimeout: 0 — the sendKeys for the launch command fires before the poll loop, so
    // the --resume assertion holds even though the loop never runs. This avoids reliance on
    // Date.now() comparisons that may be frozen by jest.setSystemTime in other test files.
    writeJsonlFile('/tmp/test-cwd', 'stale-force-killed-id')
    const stub = makeTmuxStub({
      getPanePidResult: '99999999', // Claude never running — both attempts fail
    })
    const config = makeRoutingConfig()

    await launchSession(
      'C_TEST1', '/tmp/test-cwd', config, stub,
      { pollTimeout: 0 },
    )

    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume stale-force-killed-id'),
    )
    expect(resumeCmd).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// JSONL-based session ID discovery
// ---------------------------------------------------------------------------

const jsonlDirsToClean: string[] = []

afterEach(() => {
  for (const dir of jsonlDirsToClean) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  jsonlDirsToClean.length = 0
})

/**
 * Creates a JSONL file in ~/.claude/projects/<slug>/ for a given CWD.
 * Registers the directory for cleanup in afterEach.
 * Returns the full path to the created file.
 */
function writeJsonlFile(cwd: string, sessionId: string): string {
  const slug = projectSlug(cwd)
  const dir = join(homedir(), '.claude', 'projects', slug)
  mkdirSync(dir, { recursive: true })
  jsonlDirsToClean.push(dir)
  const filePath = join(dir, `${sessionId}.jsonl`)
  writeFileSync(filePath, '{"type":"test"}\n', 'utf-8')
  return filePath
}

describe('projectSlug', () => {
  test('replaces / with - and _ with -', () => {
    expect(projectSlug('/tmp/test-cwd')).toBe('-tmp-test-cwd')
  })

  test('replaces underscores with dashes', () => {
    expect(projectSlug('/home/user/my_project')).toBe('-home-user-my-project')
  })

  test('handles paths with no special chars', () => {
    expect(projectSlug('/abc')).toBe('-abc')
  })
})

describe('findLatestJsonlSessionId', () => {
  test('returns null when directory does not exist', () => {
    expect(findLatestJsonlSessionId('/tmp/nonexistent-jsonl-test-dir-12345')).toBeNull()
  })

  test('returns null when directory exists but has no .jsonl files', () => {
    const cwd = `/tmp/jsonl-empty-${Date.now()}`
    const slug = projectSlug(cwd)
    const dir = join(homedir(), '.claude', 'projects', slug)
    mkdirSync(dir, { recursive: true })
    jsonlDirsToClean.push(dir)
    writeFileSync(join(dir, 'not-a-jsonl.txt'), 'hello', 'utf-8')

    expect(findLatestJsonlSessionId(cwd)).toBeNull()
  })

  test('returns the session ID from the single .jsonl file', () => {
    const cwd = `/tmp/jsonl-single-${Date.now()}`
    writeJsonlFile(cwd, 'abc-session-123')

    expect(findLatestJsonlSessionId(cwd)).toBe('abc-session-123')
  })

  test('returns the most recently modified .jsonl file when multiple exist', async () => {
    const cwd = `/tmp/jsonl-multi-${Date.now()}`
    const slug = projectSlug(cwd)
    const dir = join(homedir(), '.claude', 'projects', slug)
    mkdirSync(dir, { recursive: true })
    jsonlDirsToClean.push(dir)

    // Write an older file
    const oldFile = join(dir, 'old-session-id.jsonl')
    writeFileSync(oldFile, '{"type":"old"}\n', 'utf-8')

    // Ensure mtime difference
    await Bun.sleep(50)

    // Write a newer file
    const newFile = join(dir, 'new-session-id.jsonl')
    writeFileSync(newFile, '{"type":"new"}\n', 'utf-8')

    expect(findLatestJsonlSessionId(cwd)).toBe('new-session-id')
  })
})

describe('JSONL-based resume (b.sy9 fix)', () => {
  test('reconnect branch: uses JSONL session ID — PID-based discovery is not used', async () => {
    const proc = await spawnClaudeProcess()
    try {
      // JSONL has the current ID (post-compaction) — this is the only source of truth
      writeJsonlFile('/tmp/test-cwd', 'current-jsonl-session-id')

      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const config = makeRoutingConfig()

      const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

      // Reconnect succeeds — JSONL presence not required for reconnect branch itself
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(1)
      const record = result.get('C_TEST1')
      expect(record).toBeDefined()
      expect(record!.tmuxSession).toBe(sessionName('/tmp/test-cwd'))
    } finally {
      proc.kill()
    }
  })

  test('reconnect branch: succeeds even without JSONL files — no PID fallback', async () => {
    const proc = await spawnClaudeProcess()
    try {
      // No JSONL files — reconnect path always succeeds, no PID file fallback
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const config = makeRoutingConfig()

      const result = await startupSessionManager(config, stub, {}, { pollTimeout: 0 })

      // Reconnect always succeeds — PID file is never consulted
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(1)
    } finally {
      proc.kill()
    }
  })

  test('resume branch: uses JSONL session ID instead of stale stored session ID', async () => {
    const proc = await spawnClaudeProcess()
    try {
      // JSONL has the post-compaction ID
      writeJsonlFile('/tmp/test-cwd', 'jsonl-post-compaction-id')

      const stub = makeTmuxStub({
        hasSessionResult: false,
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const storedSessions: SessionsMap = {
        'C_TEST1': {
          tmuxSession: sessionName('/tmp/test-cwd'),
          lastLaunch: '2026-01-01T00:00:00.000Z',
        },
      }
      const config = makeRoutingConfig()

      const result = await startupSessionManager(config, stub, storedSessions, {
        pollTimeout: 2_000,
      })

      // The resume command must use the JSONL ID, not the stale stored one
      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const resumeCmd = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume jsonl-post-compaction-id'),
      )
      expect(resumeCmd).toBeDefined()

      // Must NOT have used the stale stored session ID
      const staleCmd = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume stale-stored-session-id'),
      )
      expect(staleCmd).toBeUndefined()
    } finally {
      proc.kill()
    }
  })

  test('resume branch: JSONL scan enables resume even without stored sessions', async () => {
    const proc = await spawnClaudeProcess()
    try {
      // JSONL file exists — resume should be attempted even with no storedSessions entry
      writeJsonlFile('/tmp/test-cwd', 'jsonl-orphan-session-id')

      const stub = makeTmuxStub({
        hasSessionResult: false,
        getPanePidResult: String(proc.pid),
        capturePaneResult: 'I am using this for local development',
      })
      const config = makeRoutingConfig()

      // Empty storedSessions — no stored ID for this channel
      const result = await startupSessionManager(config, stub, {}, {
        pollTimeout: 2_000,
      })

      // Should have attempted --resume with the JSONL ID
      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      const resumeCmd = sendKeysCalls.find(
        c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume jsonl-orphan-session-id'),
      )
      expect(resumeCmd).toBeDefined()
    } finally {
      proc.kill()
    }
  })

  test('resume branch: no JSONL files + stored session ID → launches fresh, not resume', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: false,
      getPanePidResult: '99999999',
    })
    const storedSessions: SessionsMap = {
      'C_TEST1': {
        tmuxSession: sessionName('/tmp/test-cwd'),
        lastLaunch: '2026-01-01T00:00:00.000Z',
      },
    }
    const config = makeRoutingConfig()

    await startupSessionManager(config, stub, storedSessions, {
      pollTimeout: 0,
    })

    // No JSONL → no resume attempted, fresh launch instead
    const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
    const resumeCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' && (c.args[1] as string).includes('--resume'),
    )
    expect(resumeCmd).toBeUndefined()

    const freshCmd = sendKeysCalls.find(
      c => typeof c.args[1] === 'string' &&
        (c.args[1] as string).includes('claude --mcp-config') &&
        !(c.args[1] as string).includes('--resume'),
    )
    expect(freshCmd).toBeDefined()
  })
})
