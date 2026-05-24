/**
 * permission-click-handler.test.ts — SR-2.2 click → decide path.
 *
 * Covers:
 *   - Happy path: parse action_id → claim → get → decide → chat.update
 *     "Allowed/Denied by <user>" → drop entry.
 *   - Stale click (current request_id != action_id's): chat.update
 *     "already decided", no decide() call.
 *   - ErrAlreadyDecided treated as success.
 *   - Action ID that doesn't match the SR-2.2 shape → returns false.
 *   - No live entry → treated as stale-click no-op.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { handlePermissionClick } from '../src/permission-click-handler.ts'
import {
  _resetPollerState,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedPermissionRequest,
  errAlreadyDecided,
} from './test-helpers/agent-director-stub.ts'

interface ChatCall { kind: 'postMessage' | 'update'; channel: string; ts?: string; text?: string }
function makeChatStub(): { web: { chat: { postMessage: (...a: unknown[]) => Promise<{ ts: string }>; update: (...a: unknown[]) => Promise<unknown> } }; calls: ChatCall[] } {
  const calls: ChatCall[] = []
  return {
    web: {
      chat: {
        async postMessage(args: unknown): Promise<{ ts: string }> {
          const a = args as { channel: string; text: string }
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text })
          return { ts: 'POSTED.TS' }
        },
        async update(args: unknown): Promise<unknown> {
          const a = args as { channel: string; ts: string; text: string }
          calls.push({ kind: 'update', channel: a.channel, ts: a.ts, text: a.text })
          return {}
        },
      },
    },
    calls,
  }
}

interface ManualInterval { cb: () => void; ms: number; cleared: boolean }
function makeIntervalStubs(): { setInterval: typeof globalThis.setInterval; clearInterval: typeof globalThis.clearInterval; pending: ManualInterval[] } {
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

/** Seed a live entry in the poller's module map by running one tick. */
async function seedLiveEntry(opts: { instanceId: string; channelId: string; requestId: number }): Promise<{ web: ReturnType<typeof makeChatStub>; pending: ManualInterval[] }> {
  const ivl = makeIntervalStubs()
  const chat = makeChatStub()
  const getClient = () => ({
    list: async () => ({
      spawns: [cannedListRow({
        claude_instance_id: opts.instanceId,
        state: 'check_permission',
        labels: { service: 'cscb', channel: opts.channelId },
      })],
    }),
    get: async () => cannedGetResult({
      claude_instance_id: opts.instanceId,
      state: 'check_permission',
      permission_request: cannedPermissionRequest({ request_id: opts.requestId }),
    }),
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
  return { web: chat, pending: ivl.pending }
}

afterEach(() => {
  stopPermissionPoller()
  _resetPollerState()
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('handlePermissionClick — happy path', () => {
  test('allow → claim → get (matching request_id) → decide(allow) → chat.update', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 42 })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 42 }),
      }),
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })

    const handled = await handlePermissionClick(
      'perm_allow_cscb_C_42',
      'U_USER1',
      {
        getClient,
        web: seed.web.web as never,
        resolveUserName: async () => 'alice',
      },
    )
    expect(handled).toBe(true)
    expect(decideCalls).toHaveLength(1)
    expect(decideCalls[0]).toEqual({ claude_instance_id: 'cscb_C', decision: 'allow' })
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('Allowed by alice')
  })

  test('deny → decide(deny) → chat.update "Denied by"', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 7 })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 7 }),
      }),
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })
    await handlePermissionClick(
      'perm_deny_cscb_C_7',
      'U_USER1',
      { getClient, web: seed.web.web as never, resolveUserName: async () => 'bob' },
    )
    expect(decideCalls[0].decision).toBe('deny')
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates[0].text).toContain('Denied by bob')
  })
})

// ---------------------------------------------------------------------------
// Stale clicks
// ---------------------------------------------------------------------------

describe('handlePermissionClick — stale clicks', () => {
  test('mismatched request_id → chat.update "already decided", no decide()', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 5 })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        // Fresh request_id is now 99 — the action_id encoded 5 is stale.
        permission_request: cannedPermissionRequest({ request_id: 99 }),
      }),
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })
    await handlePermissionClick(
      'perm_allow_cscb_C_5',
      'U_USER1',
      { getClient, web: seed.web.web as never, resolveUserName: async () => 'alice' },
    )
    expect(decideCalls).toHaveLength(0)
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('already decided')
  })

  test('no live entry → no-op (true return, no chat call)', async () => {
    const decideCalls: import('agent-director').DecideParams[] = []
    const chat = makeChatStub()
    const handled = await handlePermissionClick(
      'perm_allow_cscb_NOTHERE_1',
      'U_USER1',
      {
        getClient: () => ({ get: async () => cannedGetResult({ claude_instance_id: 'x' }), decide: async () => { decideCalls.push({} as never); return {} } }),
        web: chat.web as never,
        resolveUserName: async () => 'alice',
      },
    )
    expect(handled).toBe(true)
    expect(decideCalls).toHaveLength(0)
    expect(chat.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Decide idempotency
// ---------------------------------------------------------------------------

describe('handlePermissionClick — decide error paths', () => {
  test('ErrAlreadyDecided → counted as success, chat.update lands', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 3 })
    let decideCalled = 0
    const getClient = () => ({
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 3 }),
      }),
      decide: async () => {
        decideCalled++
        throw errAlreadyDecided()
      },
    })
    const handled = await handlePermissionClick(
      'perm_allow_cscb_C_3',
      'U_USER1',
      { getClient, web: seed.web.web as never, resolveUserName: async () => 'eve' },
    )
    expect(handled).toBe(true)
    expect(decideCalled).toBe(1)
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates[0].text).toContain('Allowed by eve')
  })
})

// ---------------------------------------------------------------------------
// Non-permission action ids
// ---------------------------------------------------------------------------

describe('handlePermissionClick — non-matching action ids', () => {
  test('returns false on non-perm action id', async () => {
    const chat = makeChatStub()
    const handled = await handlePermissionClick(
      'some_other_action',
      'U_USER1',
      {
        getClient: () => ({ get: async () => cannedGetResult({ claude_instance_id: 'x' }), decide: async () => ({}) }),
        web: chat.web as never,
        resolveUserName: async () => 'alice',
      },
    )
    expect(handled).toBe(false)
  })

  test('returns false on malformed perm action id', async () => {
    const chat = makeChatStub()
    const handled = await handlePermissionClick(
      'perm_allow_NOT_CSCB_PREFIX_1',
      'U_USER1',
      {
        getClient: () => ({ get: async () => cannedGetResult({ claude_instance_id: 'x' }), decide: async () => ({}) }),
        web: chat.web as never,
        resolveUserName: async () => 'alice',
      },
    )
    expect(handled).toBe(false)
  })
})
