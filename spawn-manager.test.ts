/**
 * spawn-manager.test.ts — Tests for SpawnManager spawn state machine.
 *
 * Implements test coverage for Task t2.c1r.k7.6b.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { SpawnManager, type QueuedMessage } from './spawn-manager.ts'
import type { AgentInfo, WaggleClient } from './waggle.ts'
import type { SessionEntry } from './registry.ts'
import type { RoutingConfig } from './config.ts'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(opts: { spawnTimeout?: number } = {}): RoutingConfig {
  return {
    routes: {
      C_ALPHA: { name: 'route-alpha', cwd: '/tmp/alpha' },
      C_BETA: { name: 'route-beta', cwd: '/tmp/beta' },
    },
    bind: '127.0.0.1',
    port: 3100,
    use_waggle: true,
    spawn_timeout: opts.spawnTimeout ?? 1, // 1 second for fast test timeouts
  }
}

function makeSession(routeName: string, channelId: string, connected = true): SessionEntry {
  const notifications: Array<{ method: string; params: unknown }> = []
  return {
    routeName,
    channelId,
    transport: {} as any,
    server: {
      notification: (n: any) => notifications.push(n),
    } as any,
    deliveredChannels: new Set([channelId]),
    connected,
    _notifications: notifications,
  } as any
}

function makeWaggle(opts: {
  agents?: AgentInfo[]
  spawnDelay?: number
  spawnError?: string
  listError?: string
} = {}): WaggleClient & { spawnCalls: Array<{ sessionName: string; cwd: string }> } {
  const spawnCalls: Array<{ sessionName: string; cwd: string }> = []
  return {
    spawnCalls,
    async listAgents(): Promise<AgentInfo[]> {
      if (opts.listError) throw new Error(opts.listError)
      return opts.agents ?? []
    },
    async spawnAgent(sessionName: string, cwd: string): Promise<void> {
      spawnCalls.push({ sessionName, cwd })
      if (opts.spawnDelay) {
        await new Promise<void>((resolve) => setTimeout(resolve, opts.spawnDelay))
      }
      if (opts.spawnError) throw new Error(opts.spawnError)
    },
    async disconnect(): Promise<void> {},
  }
}

function makeMessage(channelId = 'C_ALPHA', text = 'hello'): QueuedMessage {
  return {
    channelId,
    method: 'notifications/claude/channel',
    params: { content: text, meta: { chat_id: channelId, message_id: '123', user: 'user', ts: '123' } },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpawnManager.ensureSession', () => {
  test('returns existing connected session immediately without spawning', async () => {
    const session = makeSession('route-alpha', 'C_ALPHA')
    const waggle = makeWaggle()
    const onError = mock(() => {})

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: (_name: string) => session },
      config: makeConfig(),
      onError,
    })

    const result = await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())
    expect(result).toBe(session)
    expect(waggle.spawnCalls).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
  })

  test('returns null and queues message when no connected session (spawning starts)', async () => {
    const waggle = makeWaggle({ spawnDelay: 5000 }) // long delay — won't complete in test
    const onError = mock(() => {})
    let registryCallCount = 0

    const mgr = new SpawnManager({
      waggle,
      registry: {
        getSessionByRoute: (_name: string) => {
          registryCallCount++
          return undefined // no session ever appears
        }
      },
      config: makeConfig({ spawnTimeout: 1 }),
      onError,
    })

    const msg = makeMessage()
    const result = await mgr.ensureSession('route-alpha', 'C_ALPHA', msg)
    expect(result).toBeNull()
  })

  test('queues subsequent messages for same route while spawning', async () => {
    const waggle = makeWaggle({ spawnDelay: 5000 }) // long delay
    const onError = mock(() => {})

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 1 }),
      onError,
    })

    // First call — starts spawn
    const r1 = await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'msg1'))
    expect(r1).toBeNull()

    // Second call — already spawning, should just queue
    const r2 = await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'msg2'))
    expect(r2).toBeNull()
  })
})

describe('SpawnManager.notifyConnected', () => {
  test('flushes queued messages to the session', async () => {
    const waggle = makeWaggle({ spawnDelay: 5000 }) // long — won't complete during test
    const onError = mock(() => {})

    let resolveRegistry: ((s: SessionEntry | undefined) => void) | null = null

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 1 }),
      onError,
    })

    const msg1 = makeMessage('C_ALPHA', 'first')
    const msg2 = makeMessage('C_ALPHA', 'second')

    // Queue two messages
    await mgr.ensureSession('route-alpha', 'C_ALPHA', msg1)
    await mgr.ensureSession('route-alpha', 'C_ALPHA', msg2)

    // Now create a session and call notifyConnected
    const session = makeSession('route-alpha', 'C_ALPHA')
    mgr.notifyConnected('route-alpha', session)

    // The server.notification should have been called twice
    const notifications = (session as any)._notifications as Array<{ method: string; params: unknown }>
    expect(notifications).toHaveLength(2)
    expect((notifications[0].params as any).content).toBe('first')
    expect((notifications[1].params as any).content).toBe('second')
  })

  test('transitions route to idle after flushing', async () => {
    const waggle = makeWaggle({ spawnDelay: 5000 })
    const onError = mock(() => {})

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 1 }),
      onError,
    })

    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())

    const session = makeSession('route-alpha', 'C_ALPHA')
    mgr.notifyConnected('route-alpha', session)

    // After notifyConnected, the route should be idle — next ensureSession should
    // start a new spawn attempt rather than just queueing.
    // Verify by checking that waggle.spawnAgent is called again for a second ensureSession.
    const spawnCountAfterConnect = waggle.spawnCalls.length
    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())
    expect(waggle.spawnCalls.length).toBe(spawnCountAfterConnect + 1)
  })

  test('is a no-op for unknown routes', () => {
    const waggle = makeWaggle()
    const onError = mock(() => {})

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig(),
      onError,
    })

    const session = makeSession('route-alpha', 'C_ALPHA')
    // Should not throw
    expect(() => mgr.notifyConnected('no-such-route', session)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// State transition tests
// ---------------------------------------------------------------------------

describe('SpawnManager — state transitions', () => {
  test('idle → spawning → connected: queue flushed and route returns to idle', async () => {
    const waggle = makeWaggle({ agents: [] })
    const errors: string[] = []

    let callCount = 0
    const session = makeSession('route-alpha', 'C_ALPHA')
    const registry = {
      getSessionByRoute: (_name: string): SessionEntry | undefined => {
        callCount++
        return callCount > 3 ? session : undefined
      },
    }

    const mgr = new SpawnManager({
      waggle,
      registry,
      config: makeConfig({ spawnTimeout: 5 }),
      onError: (_ch, msg) => errors.push(msg),
    })

    // Start spawn; returns null because spawning
    const r1 = await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'a'))
    expect(r1).toBeNull()

    // Wait for the _spawnSequence to poll and call notifyConnected
    await new Promise<void>((resolve) => setTimeout(resolve, 1200))

    // No errors
    expect(errors).toHaveLength(0)
    // Session received the notification
    const notes = (session as any)._notifications as Array<{ method: string; params: unknown }>
    expect(notes.length).toBeGreaterThanOrEqual(1)
    expect((notes[0]!.params as any).content).toBe('a')
  }, 8000)

  test('idle → spawning → timed-out: onError called and queue discarded', async () => {
    const waggle = makeWaggle({ agents: [] })
    const errors: Array<[string, string]> = []

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined }, // never connects
      config: makeConfig({ spawnTimeout: 1 }),
      onError: (ch, msg) => errors.push([ch, msg]),
    })

    const msg1 = makeMessage('C_ALPHA', 'queued-1')
    const msg2 = makeMessage('C_ALPHA', 'queued-2')

    await mgr.ensureSession('route-alpha', 'C_ALPHA', msg1)
    await mgr.ensureSession('route-alpha', 'C_ALPHA', msg2)

    // Wait for timeout
    await new Promise<void>((resolve) => setTimeout(resolve, 1600))

    // onError called exactly once with timeout message
    expect(errors).toHaveLength(1)
    expect(errors[0]![1]).toContain('timed out after 1s')
    expect(errors[0]![1]).toContain('route-alpha')

    // Route is back to idle — a new ensureSession starts a fresh spawn (spawnCalls grows)
    const spawnCountBefore = waggle.spawnCalls.length
    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    // A new spawn was attempted (not just queued)
    expect(waggle.spawnCalls.length).toBeGreaterThan(spawnCountBefore)
  }, 8000)

  test('idle → spawning → error: onError called immediately and queue discarded', async () => {
    const waggle = makeWaggle({ spawnError: 'waggle unavailable' })
    const errors: Array<[string, string]> = []

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 5 }),
      onError: (ch, msg) => errors.push([ch, msg]),
    })

    const msg1 = makeMessage('C_ALPHA', 'will-be-discarded-1')
    const msg2 = makeMessage('C_ALPHA', 'will-be-discarded-2')

    await mgr.ensureSession('route-alpha', 'C_ALPHA', msg1)
    await mgr.ensureSession('route-alpha', 'C_ALPHA', msg2)

    // Wait for spawn error to propagate (much faster than timeout)
    await new Promise<void>((resolve) => setTimeout(resolve, 300))

    // Error reported
    expect(errors).toHaveLength(1)
    expect(errors[0]![1]).toContain('Failed to spawn')
    expect(errors[0]![1]).toContain('waggle unavailable')

    // Route back to idle — new ensureSession starts a new spawn
    const spawnCountBefore = waggle.spawnCalls.length
    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    expect(waggle.spawnCalls.length).toBeGreaterThan(spawnCountBefore)
  }, 5000)
})

// ---------------------------------------------------------------------------
// Dedup test
// ---------------------------------------------------------------------------

describe('SpawnManager — dedup', () => {
  test('second message during spawn queues without triggering a second spawnAgent call', async () => {
    const waggle = makeWaggle({ spawnDelay: 5000 }) // long delay — spawn never finishes during test
    const onError = mock(() => {})

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 10 }),
      onError,
    })

    // First message starts the spawn
    const r1 = await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'first'))
    expect(r1).toBeNull()

    // Give background spawn a moment to call spawnAgent
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // Second and third messages must NOT trigger additional spawnAgent calls
    const r2 = await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'second'))
    const r3 = await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'third'))
    expect(r2).toBeNull()
    expect(r3).toBeNull()

    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // Only one spawnAgent call regardless of how many messages arrived
    expect(waggle.spawnCalls).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
  }, 5000)
})

// ---------------------------------------------------------------------------
// Queue flush order test
// ---------------------------------------------------------------------------

describe('SpawnManager — queue flush order', () => {
  test('messages are flushed in arrival order (FIFO)', async () => {
    const waggle = makeWaggle({ spawnDelay: 5000 }) // long delay
    const onError = mock(() => {})

    const session = makeSession('route-alpha', 'C_ALPHA')
    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 10 }),
      onError,
    })

    const messages = ['alpha', 'beta', 'gamma', 'delta']
    for (const text of messages) {
      await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', text))
    }

    // Manually trigger connected notification
    mgr.notifyConnected('route-alpha', session)

    const notes = (session as any)._notifications as Array<{ method: string; params: unknown }>
    expect(notes).toHaveLength(messages.length)
    for (let i = 0; i < messages.length; i++) {
      expect((notes[i]!.params as any).content).toBe(messages[i])
    }
  })
})

// ---------------------------------------------------------------------------
// Queue discard on failure tests
// ---------------------------------------------------------------------------

describe('SpawnManager — queue discard on failure', () => {
  test('queue is discarded when spawn times out', async () => {
    const waggle = makeWaggle({ agents: [] })
    const errors: string[] = []

    const session = makeSession('route-alpha', 'C_ALPHA')
    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined }, // session never connects
      config: makeConfig({ spawnTimeout: 1 }),
      onError: (_ch, msg) => errors.push(msg),
    })

    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'msg1'))
    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'msg2'))

    // Wait for timeout
    await new Promise<void>((resolve) => setTimeout(resolve, 1600))

    // Now manually call notifyConnected — queue should already be empty, no notifications delivered
    mgr.notifyConnected('route-alpha', session)
    const notes = (session as any)._notifications as Array<unknown>
    expect(notes).toHaveLength(0)
  }, 8000)

  test('queue is discarded when spawnAgent errors', async () => {
    const waggle = makeWaggle({ spawnError: 'network error' })
    const errors: string[] = []

    const session = makeSession('route-alpha', 'C_ALPHA')
    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 5 }),
      onError: (_ch, msg) => errors.push(msg),
    })

    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'msg1'))
    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage('C_ALPHA', 'msg2'))

    // Wait for error to propagate
    await new Promise<void>((resolve) => setTimeout(resolve, 300))

    // Error was reported
    expect(errors).toHaveLength(1)
    expect(errors[0]!).toContain('network error')

    // Queue was discarded — notifyConnected delivers nothing
    mgr.notifyConnected('route-alpha', session)
    const notes = (session as any)._notifications as Array<unknown>
    expect(notes).toHaveLength(0)
  }, 5000)
})

// ---------------------------------------------------------------------------
// list_agents preventing unnecessary spawn
// ---------------------------------------------------------------------------

describe('SpawnManager — list_agents prevents unnecessary spawn', () => {
  test('existing session in tmux causes wait-for-connect instead of re-spawning', async () => {
    const agents: AgentInfo[] = [{ session_name: 'route-alpha', status: 'active' }]
    const waggle = makeWaggle({ agents })
    const errors: Array<[string, string]> = []

    let callCount = 0
    const session = makeSession('route-alpha', 'C_ALPHA')
    const registry = {
      getSessionByRoute: (_name: string): SessionEntry | undefined => {
        callCount++
        // Simulate session connecting after a couple of polls
        return callCount > 3 ? session : undefined
      },
    }

    const mgr = new SpawnManager({
      waggle,
      registry,
      config: makeConfig({ spawnTimeout: 5 }),
      onError: (ch, msg) => errors.push([ch, msg]),
    })

    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())
    await new Promise<void>((resolve) => setTimeout(resolve, 1200))

    // spawnAgent must NOT have been called — existing tmux session found
    expect(waggle.spawnCalls).toHaveLength(0)
    // No errors — it waited and connected
    expect(errors).toHaveLength(0)
    // Session got the queued message
    const notes = (session as any)._notifications as Array<unknown>
    expect(notes.length).toBeGreaterThanOrEqual(1)
  }, 8000)
})

// ---------------------------------------------------------------------------
// spawn_agent error triggers immediate failure
// ---------------------------------------------------------------------------

describe('SpawnManager — spawn_agent error triggers immediate failure', () => {
  test('spawnAgent throwing causes onError immediately without waiting for timeout', async () => {
    const waggle = makeWaggle({ spawnError: 'connection refused' })
    const errors: Array<{ ch: string; msg: string; at: number }> = []
    const startTime = Date.now()

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 30 }), // long timeout — error should fire well before it
      onError: (ch, msg) => errors.push({ ch, msg, at: Date.now() - startTime }),
    })

    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())

    // Error should arrive well before the 30-second timeout
    await new Promise<void>((resolve) => setTimeout(resolve, 500))

    expect(errors).toHaveLength(1)
    expect(errors[0]!.msg).toContain('connection refused')
    // Confirm it was fast (well under 30s timeout)
    expect(errors[0]!.at).toBeLessThan(5000)
  }, 8000)
})

describe('SpawnManager — spawn flow', () => {
  test('calls spawnAgent with correct args when no existing tmux session', async () => {
    const waggle = makeWaggle({ agents: [] }) // no existing agents
    const errors: Array<[string, string]> = []

    // We need a registry that returns a session after a brief delay to simulate connect
    let callCount = 0
    const session = makeSession('route-alpha', 'C_ALPHA')
    const registry = {
      getSessionByRoute: (_name: string): SessionEntry | undefined => {
        // Return session after 2 poll cycles
        callCount++
        return callCount > 2 ? session : undefined
      }
    }

    const mgr = new SpawnManager({
      waggle,
      registry,
      config: makeConfig({ spawnTimeout: 5 }),
      onError: (ch, msg) => errors.push([ch, msg]),
    })

    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())

    // Wait a moment for spawn sequence to start
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    expect(waggle.spawnCalls).toHaveLength(1)
    expect(waggle.spawnCalls[0]!.sessionName).toBe('route-alpha')
    expect(waggle.spawnCalls[0]!.cwd).toBe('/tmp/alpha')
  })

  test('does not call spawnAgent when existing agent session found', async () => {
    const agents: AgentInfo[] = [{ session_name: 'route-alpha', status: 'active' }]
    const waggle = makeWaggle({ agents })
    const errors: Array<[string, string]> = []

    let callCount = 0
    const session = makeSession('route-alpha', 'C_ALPHA')
    const registry = {
      getSessionByRoute: (_name: string): SessionEntry | undefined => {
        callCount++
        return callCount > 2 ? session : undefined
      }
    }

    const mgr = new SpawnManager({
      waggle,
      registry,
      config: makeConfig({ spawnTimeout: 5 }),
      onError: (ch, msg) => errors.push([ch, msg]),
    })

    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())

    // Wait a moment for spawn sequence to check
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    expect(waggle.spawnCalls).toHaveLength(0)
  })

  test('calls onError with timeout message when session never connects', async () => {
    const waggle = makeWaggle({ agents: [] })
    const errors: Array<[string, string]> = []

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 1 }),
      onError: (ch, msg) => errors.push([ch, msg]),
    })

    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())

    // Wait for timeout (1 second + buffer)
    await new Promise<void>((resolve) => setTimeout(resolve, 1500))

    expect(errors).toHaveLength(1)
    expect(errors[0]![1]).toContain('timed out after 1s')
    expect(errors[0]![1]).toContain('route-alpha')
  }, 5000)

  test('calls onError with reason when spawnAgent throws', async () => {
    const waggle = makeWaggle({ spawnError: 'waggle spawn failed' })
    const errors: Array<[string, string]> = []

    const mgr = new SpawnManager({
      waggle,
      registry: { getSessionByRoute: () => undefined },
      config: makeConfig({ spawnTimeout: 5 }),
      onError: (ch, msg) => errors.push([ch, msg]),
    })

    await mgr.ensureSession('route-alpha', 'C_ALPHA', makeMessage())

    // Wait for the spawn sequence to complete (error path)
    await new Promise<void>((resolve) => setTimeout(resolve, 200))

    expect(errors).toHaveLength(1)
    expect(errors[0]![1]).toContain('Failed to spawn')
    expect(errors[0]![1]).toContain('route-alpha')
    expect(errors[0]![1]).toContain('waggle spawn failed')
  })
})
