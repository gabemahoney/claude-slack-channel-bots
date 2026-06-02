/**
 * permission-poller.test.ts — SR-2.1 poller behavior.
 *
 * Drives the poller directly via injected setInterval/clearInterval stubs
 * + WebClient.chat stub + agent-director client stub. Coverage:
 *
 *   - New check_permission row → posts Block Kit message to spawn's
 *     `channel` label and records the live entry.
 *   - tool_input JSON-parses; un-parseable falls back to raw-string.
 *   - Disappearing entry → chat.update "expired" + drops live entry.
 *   - finalizedAt within 30 s window suppresses the "expired" update
 *     (click handler claim).
 *   - row.permission_request is null/absent → skip + warn.
 *   - Two sequential requests from the same instance each get their own
 *     Slack message (b.oaj root-cause fix).
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetPollerState,
  buildPermissionBlocks,
  claimPermission,
  dropPermission,
  getLivePermission,
  makePermKey,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import {
  cannedGetPermissionResult,
  cannedListRow,
  cannedPermissionRequest,
  errPermissionRequestNotFound,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Test plumbing: a manual interval stub + a chat-only WebClient fake
// ---------------------------------------------------------------------------

interface ManualInterval {
  cb: () => void
  ms: number
  cleared: boolean
}

function makeInterval(): { setInterval: typeof globalThis.setInterval; clearInterval: typeof globalThis.clearInterval; pending: ManualInterval[] } {
  const pending: ManualInterval[] = []
  return {
    setInterval: ((cb: () => void, ms: number) => {
      const entry: ManualInterval = { cb, ms, cleared: false }
      pending.push(entry)
      return entry as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: ((handle: unknown) => {
      const entry = handle as ManualInterval
      entry.cleared = true
    }) as unknown as typeof globalThis.clearInterval,
    pending,
  }
}

interface ChatCall {
  kind: 'postMessage' | 'update'
  channel: string
  ts?: string
  text?: string
}

function makeChatStub(opts?: { postMessageTs?: string; postMessageError?: Error; updateError?: Error }): { web: { chat: { postMessage: (...args: unknown[]) => Promise<{ ts: string }>; update: (...args: unknown[]) => Promise<unknown> } }; calls: ChatCall[] } {
  const calls: ChatCall[] = []
  return {
    web: {
      chat: {
        async postMessage(args: unknown): Promise<{ ts: string }> {
          const a = args as { channel: string; text: string }
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text })
          if (opts?.postMessageError) throw opts.postMessageError
          return { ts: opts?.postMessageTs ?? '1234.5678' }
        },
        async update(args: unknown): Promise<unknown> {
          const a = args as { channel: string; ts: string; text: string }
          calls.push({ kind: 'update', channel: a.channel, ts: a.ts, text: a.text })
          if (opts?.updateError) throw opts.updateError
          return {}
        },
      },
    },
    calls,
  }
}

afterEach(() => {
  _resetPollerState()
})

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

describe('buildPermissionBlocks (SR-2.2 action_id shape)', () => {
  test('emits perm_allow_<instance>_<request_token> and perm_deny_<instance>_<request_token>', () => {
    const token = '00000000-0000-0000-0000-000000000042'
    const blocks = buildPermissionBlocks('Bash', { command: 'rm -rf' }, 'cscb_C012345', token) as Array<Record<string, unknown>>
    const actions = blocks[1] as { elements: Array<{ action_id: string }> }
    expect(actions.elements[0].action_id).toBe(`perm_allow_cscb_C012345_${token}`)
    expect(actions.elements[1].action_id).toBe(`perm_deny_cscb_C012345_${token}`)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior
// ---------------------------------------------------------------------------

describe('poller tick — new check_permission row', () => {
  test('posts Block Kit message and records live entry', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: '99.88' })
    const TOKEN = '00000000-0000-0000-0000-000000000001'
    const getClient = () => ({
      list: async () => ({
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_C',
            state: 'check_permission',
            labels: { service: 'cscb', channel: 'CH123' },
            permission_request: cannedPermissionRequest({ request_token: TOKEN }),
          } as never),
        ],
      }),
      // Return open (decision: null) so the entry stays alive
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN, decision: null }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Fire one tick manually
    expect(ivl.pending).toHaveLength(1)
    ivl.pending[0].cb()
    // Wait for the microtasks to flush
    await new Promise((r) => setTimeout(r, 10))

    const key = makePermKey('cscb_C', TOKEN)
    const live = getLivePermission(key)
    expect(live).toBeDefined()
    expect(live?.channelId).toBe('CH123')
    expect(live?.messageTs).toBe('99.88')
    expect(live?.requestToken).toBe(TOKEN)

    const postCalls = chat.calls.filter((c) => c.kind === 'postMessage')
    expect(postCalls).toHaveLength(1)
    expect(postCalls[0].channel).toBe('CH123')

    stopPermissionPoller()
  })

  test('skips when channel label is missing', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const TOKEN = '00000000-0000-0000-0000-000000000001'
    const getClient = () => ({
      list: async () => ({
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_C',
            state: 'check_permission',
            labels: { service: 'cscb' }, // no channel
            permission_request: cannedPermissionRequest({ request_token: TOKEN }),
          } as never),
        ],
      }),
      // No live entry posted (channel missing), so getPermission won't be called
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN, decision: null }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(0)
    stopPermissionPoller()
  })

  test('falls back to raw-string on unparseable tool_input', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: '99.88' })
    const TOKEN = '00000000-0000-0000-0000-000000000001'
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({
          claude_instance_id: 'cscb_C',
          state: 'check_permission',
          labels: { service: 'cscb', channel: 'CH' },
          permission_request: cannedPermissionRequest({ request_token: TOKEN, tool_input: '{not json' }),
        } as never)],
      }),
      // Return open so the entry stays alive after posting
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN, decision: null }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: () => { /* swallow warning */ },
    })
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(makePermKey('cscb_C', TOKEN))).toBeDefined()
    stopPermissionPoller()
  })

  test('row.permission_request is null/absent → skip + warn', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const warnings: unknown[] = []
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({
          claude_instance_id: 'cscb_C',
          state: 'check_permission',
          labels: { service: 'cscb', channel: 'CH' },
          // No permission_request field — row has null inline payload
        } as never)],
      }),
      // No live entry posted (no permission_request), so getPermission won't be called
      getPermission: async () => { throw new Error('should not be called') },
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: (...args) => warnings.push(args),
    })
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls).toHaveLength(0)
    // Should have logged a warning about missing permission_request
    expect(warnings.length).toBeGreaterThan(0)
    stopPermissionPoller()
  })
})

// ---------------------------------------------------------------------------
// Expiry behavior
// ---------------------------------------------------------------------------

describe('poller tick — expiry', () => {
  test('disappearing entry triggers chat.update "expired" and drops the map entry', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'TS1' })
    const TOKEN = '00000000-0000-0000-0000-000000000001'
    let listReturn: import('agent-director').ListResult = {
      spawns: [cannedListRow({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        labels: { service: 'cscb', channel: 'CH' },
        permission_request: cannedPermissionRequest({ request_token: TOKEN }),
      } as never)],
    }
    const getClient = () => ({
      list: async () => listReturn,
      // On tick 1, instance is in list → return open so entry stays alive
      // On tick 2, instance is gone from list → getPermission not called (disappear path)
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN, decision: null }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: post the prompt
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(makePermKey('cscb_C', TOKEN))).toBeDefined()

    // Tick 2: spawn no longer in check_permission → expire
    listReturn = { spawns: [] }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('expired')
    expect(getLivePermission(makePermKey('cscb_C', TOKEN))).toBeUndefined()

    stopPermissionPoller()
  })

  test('finalizedAt within 30s window suppresses the expired update', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'TS1' })
    const TOKEN = '00000000-0000-0000-0000-000000000001'
    let listReturn: import('agent-director').ListResult = {
      spawns: [cannedListRow({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        labels: { service: 'cscb', channel: 'CH' },
        permission_request: cannedPermissionRequest({ request_token: TOKEN }),
      } as never)],
    }
    const getClient = () => ({
      list: async () => listReturn,
      // On tick 1, instance is in list → return open so entry stays alive
      // On tick 2, instance is gone from list → getPermission not called (disappear path)
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN, decision: null }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: post the prompt
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // Click handler claims the message (simulated) using composite key
    claimPermission(makePermKey('cscb_C', TOKEN))

    // Tick 2: spawn disappears, but the claim should suppress the update.
    listReturn = { spawns: [] }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(0)
    expect(getLivePermission(makePermKey('cscb_C', TOKEN))).toBeUndefined() // dropped regardless

    stopPermissionPoller()
  })

  test('getPermission returns decided → expire and drop', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'TS1' })
    const TOKEN = '00000000-0000-0000-0000-000000000001'
    const listReturn: import('agent-director').ListResult = {
      spawns: [cannedListRow({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        labels: { service: 'cscb', channel: 'CH' },
        permission_request: cannedPermissionRequest({ request_token: TOKEN }),
      } as never)],
    }
    // First call (Tick 1 expiry scan): return open so entry stays.
    // Second call (Tick 2 expiry scan): return decided → expire and drop.
    let getPermissionCallCount = 0
    const getClient = () => ({
      list: async () => listReturn,
      getPermission: async (_params: unknown) => {
        getPermissionCallCount++
        const decision = getPermissionCallCount === 1 ? null : 'allow'
        return cannedGetPermissionResult({ request_token: TOKEN, decision })
      },
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: post the prompt; getPermission returns open → entry stays alive
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(makePermKey('cscb_C', TOKEN))).toBeDefined()

    // Tick 2: same instance in list, getPermission says decided → expire
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(getPermissionCallCount).toBeGreaterThanOrEqual(2)
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('expired')
    expect(getLivePermission(makePermKey('cscb_C', TOKEN))).toBeUndefined()

    stopPermissionPoller()
  })

  test('getPermission throws ErrPermissionRequestNotFound → expire and drop', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'TS1' })
    const TOKEN = '00000000-0000-0000-0000-000000000001'
    const listReturn: import('agent-director').ListResult = {
      spawns: [cannedListRow({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        labels: { service: 'cscb', channel: 'CH' },
        permission_request: cannedPermissionRequest({ request_token: TOKEN }),
      } as never)],
    }
    // First call (Tick 1 expiry scan): return open so entry stays.
    // Second call (Tick 2 expiry scan): throw ErrPermissionRequestNotFound → expire and drop.
    let getPermissionCallCount = 0
    const getClient = () => ({
      list: async () => listReturn,
      getPermission: async (_params: unknown) => {
        getPermissionCallCount++
        if (getPermissionCallCount === 1) {
          return cannedGetPermissionResult({ request_token: TOKEN, decision: null })
        }
        throw errPermissionRequestNotFound()
      },
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: post the prompt; getPermission returns open → entry stays alive
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(makePermKey('cscb_C', TOKEN))).toBeDefined()

    // Tick 2: same instance in list, getPermission says not found → expire
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(getPermissionCallCount).toBeGreaterThanOrEqual(2)
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('expired')
    expect(getLivePermission(makePermKey('cscb_C', TOKEN))).toBeUndefined()

    stopPermissionPoller()
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('poller lifecycle', () => {
  test('startPermissionPoller is idempotent', () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const getClient = () => ({
      list: async () => ({ spawns: [] }),
      getPermission: async () => { throw new Error('should not be called') },
    })
    const deps = { getClient, web: chat.web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval }
    startPermissionPoller(deps)
    startPermissionPoller(deps)
    startPermissionPoller(deps)
    expect(ivl.pending).toHaveLength(1)
    stopPermissionPoller()
  })

  test('stopPermissionPoller is safe when not started', () => {
    expect(() => stopPermissionPoller()).not.toThrow()
  })

  test('dropPermission removes the live entry', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'X' })
    const TOKEN = '00000000-0000-0000-0000-000000000001'
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({
          claude_instance_id: 'cscb_C',
          state: 'check_permission',
          labels: { service: 'cscb', channel: 'CH' },
          permission_request: cannedPermissionRequest({ request_token: TOKEN }),
        } as never)],
      }),
      // Return open so entry stays alive after posting
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN, decision: null }),
    })
    startPermissionPoller({ getClient, web: chat.web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval })
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    const key = makePermKey('cscb_C', TOKEN)
    expect(getLivePermission(key)).toBeDefined()
    dropPermission(key)
    expect(getLivePermission(key)).toBeUndefined()
    stopPermissionPoller()
  })
})

// ---------------------------------------------------------------------------
// Multi-request concurrent (b.oaj root-cause fix)
// ---------------------------------------------------------------------------

describe('multi-request concurrent (b.oaj root-cause fix)', () => {
  test('two sequential requests from the same instance each get their own Slack message', async () => {
    const TOKEN_1 = '00000000-0000-0000-0000-000000000001'
    const TOKEN_2 = '00000000-0000-0000-0000-000000000002'

    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'TS_MULTI' })

    let listReturn: import('agent-director').ListResult = {
      spawns: [cannedListRow({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        labels: { service: 'cscb', channel: 'CH_MULTI' },
        permission_request: cannedPermissionRequest({ request_token: TOKEN_1 }),
      } as never)],
    }

    // getPermission: always return open (decision: null) — we test the stale-same-instance
    // code path (lines 234–240 in runTick) which expires TOKEN_1 without calling getPermission.
    const getClient = () => ({
      list: async () => listReturn,
      getPermission: async (params: { request_token: string }) => {
        // Both TOKEN_1 and TOKEN_2 are open from the server's perspective.
        // The poller expires TOKEN_1 via the stale-same-instance scan (different requestToken).
        return cannedGetPermissionResult({ request_token: params.request_token, decision: null })
      },
    })

    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: TOKEN_1 row arrives → post message
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const postCallsAfterTick1 = chat.calls.filter((c) => c.kind === 'postMessage')
    expect(postCallsAfterTick1).toHaveLength(1)
    expect(getLivePermission(makePermKey('cscb_C', TOKEN_1))).toBeDefined()
    expect(getLivePermission(makePermKey('cscb_C', TOKEN_2))).toBeUndefined()

    // Tick 2: new request TOKEN_2 for same instance — swap list
    listReturn = {
      spawns: [cannedListRow({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        labels: { service: 'cscb', channel: 'CH_MULTI' },
        permission_request: cannedPermissionRequest({ request_token: TOKEN_2 }),
      } as never)],
    }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const postCallsAfterTick2 = chat.calls.filter((c) => c.kind === 'postMessage')
    expect(postCallsAfterTick2).toHaveLength(2)

    // TOKEN_1 should be expired and dropped (stale same-instance entry)
    expect(getLivePermission(makePermKey('cscb_C', TOKEN_1))).toBeUndefined()
    // TOKEN_2 should be live
    expect(getLivePermission(makePermKey('cscb_C', TOKEN_2))).toBeDefined()

    // Exactly 1 chat.update for TOKEN_1 expiry
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('expired')

    stopPermissionPoller()
  })
})
