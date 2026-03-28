/**
 * session-manager.test.ts — Tests for startupSessionManager and launchSession
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, copyFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { type TmuxClient, sessionName } from './tmux.ts'
import { type SessionsMap } from './sessions.ts'
import { type RoutingConfig } from './config.ts'
import { startupSessionManager, launchSession } from './session-manager.ts'

// ---------------------------------------------------------------------------
// TmuxClient stub factory
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
      const r = opts.hasSessionResult ?? false
      if (r instanceof Error) throw r
      return r
    },
    async getPanePid(session) {
      calls.push({ method: 'getPanePid', args: [session] })
      const r = opts.getPanePidResult ?? '99999999'
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
      const r = opts.capturePaneResult ?? ''
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
// In-memory sessions stubs
// ---------------------------------------------------------------------------

function makeSessionsStubs(initial: SessionsMap = {}) {
  let sessions: SessionsMap = { ...initial }
  const writtenSessions: SessionsMap[] = []

  return {
    get current() { return sessions },
    writtenSessions,
    read: (_path?: string): SessionsMap => ({ ...sessions }),
    write: (s: SessionsMap, _path?: string): void => {
      writtenSessions.push({ ...s })
      sessions = { ...s }
    },
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

function makeRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  return {
    routes: {
      'C_TEST1': { cwd: '/tmp/test-cwd' },
    },
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: 60,
    mcp_config_path: '/tmp/test-mcp.json',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: spawn a real process named "claude" so isClaudeRunning returns true
// ---------------------------------------------------------------------------

async function spawnClaudeProcess() {
  const sleepBin = existsSync('/usr/bin/sleep') ? '/usr/bin/sleep' : '/bin/sleep'
  const tmpDir = mkdtempSync(join(tmpdir(), 'session-mgr-test-'))
  const claudePath = join(tmpDir, 'claude')
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
  test('1. live session: sendKeys /mcp reconnect, no killSession or newSession', async () => {
    const proc = await spawnClaudeProcess()
    try {
      const stub = makeTmuxStub({
        hasSessionResult: true,
        getPanePidResult: String(proc.pid),
      })
      const sessions = makeSessionsStubs()
      const config = makeRoutingConfig()

      const results = await startupSessionManager(config, stub, sessions.read, sessions.write)

      expect(results).toHaveLength(1)
      expect(results[0].action).toBe('reconnected')
      expect(results[0].channelId).toBe('C_TEST1')
      expect(results[0].sessionName).toBe(sessionName('C_TEST1'))

      const sendKeysCalls = stub.calls.filter(c => c.method === 'sendKeys')
      expect(sendKeysCalls).toHaveLength(2)
      expect(sendKeysCalls[0].args[1]).toBe('/mcp reconnect slack-channel-router')
      expect(sendKeysCalls[1].args[1]).toBe('Enter')

      expect(stub.calls.filter(c => c.method === 'killSession')).toHaveLength(0)
      expect(stub.calls.filter(c => c.method === 'newSession')).toHaveLength(0)
    } finally {
      proc.kill()
    }
  })

  test('2. zombie session: killSession called, then newSession and sendKeys with launch command', async () => {
    const stub = makeTmuxStub({
      hasSessionResult: true,
      getPanePidResult: '99999999', // isClaudeRunning → false
    })
    const sessions = makeSessionsStubs()
    const config = makeRoutingConfig()

    await startupSessionManager(config, stub, sessions.read, sessions.write, { pollTimeout: 0 })

    const name = sessionName('C_TEST1')

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
    expect(newCalls[0].args[0]).toBe(sessionName('C_TEST1'))
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
    expect(stub.calls.filter(c => c.method === 'newSession')[0].args[0]).toBe(sessionName('C_TEST1'))
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
    expect(written['C_TEST1'].tmuxSession).toBe(sessionName('C_TEST1'))
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
        tmuxSession: 'slack_channel_bot_C_OTHER',
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
    expect(written['C_OTHER'].tmuxSession).toBe('slack_channel_bot_C_OTHER')
    // New entry keyed by channelId with correct session name
    expect(written['C_TEST1']).toBeDefined()
    expect(written['C_TEST1'].tmuxSession).toBe(sessionName('C_TEST1'))
  })
})
