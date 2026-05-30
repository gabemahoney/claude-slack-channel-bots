/**
 * permission-click-handler.test.ts — SR-2.2 click → decide path.
 *
 * Contract pins:
 *   - Happy path: parse action_id → get (matching request_id) → decide →
 *     chat.update "Allowed/Denied by <user>" → markHandled ONLY after update succeeds.
 *   - Happy path with chat.update throwing → markHandled NOT called (handled stays false).
 *   - Stale click (current request_id != action_id's): chat.update "already decided" +
 *     markHandled on success; leaves handled=false if chat.update throws.
 *   - ErrAlreadyDecided treated as success → chat.update lands + markHandled called.
 *   - No live entry → returns true, no chat call, no markHandled.
 *   - Generic get() failure → returns true, does NOT touch handled.
 *   - ErrSpawnNotFound from get() → treated as stale (chat.update "already decided" +
 *     markHandled on success).
 *   - Action ID that doesn't match the SR-2.2 shape → returns false.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { handlePermissionClick } from '../src/permission-click-handler.ts'
import { encodePermissionActionId } from '../src/permission-action-id.ts'
import {
  _resetPollerState,
  getLivePermission,
  markHandled,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedPermissionRequest,
  errAlreadyDecided,
  errGeneric,
  errSpawnNotFound,
} from './test-helpers/agent-director-stub.ts'

interface ChatCall { kind: 'postMessage' | 'update'; channel: string; ts?: string; text?: string }

function makeChatStub(opts?: { updateError?: Error }): {
  web: { chat: { postMessage: (...a: unknown[]) => Promise<{ ts: string }>; update: (...a: unknown[]) => Promise<unknown> } }
  calls: ChatCall[]
} {
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
          if (opts?.updateError) throw opts.updateError
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
  test('allow → get (matching request_id) → decide(allow) → chat.update succeeds → markHandled called', async () => {
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
    // markHandled was called by the click handler after update succeeded
    expect(getLivePermission('cscb_C')?.handled).toBe(true)
  })

  test('deny → decide(deny) → chat.update "Denied by" → markHandled called', async () => {
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
    expect(getLivePermission('cscb_C')?.handled).toBe(true)
  })

  test('success path with chat.update throwing → markHandled NOT called, handled stays false', async () => {
    await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 5 })
    // Use a separate chat stub that throws on update
    const chatForClick = makeChatStub({ updateError: new Error('Slack API down') })
    const getClient = () => ({
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 5 }),
      }),
      decide: async () => ({}),
    })

    const handled = await handlePermissionClick(
      'perm_allow_cscb_C_5',
      'U_USER1',
      {
        getClient,
        web: chatForClick.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    expect(handled).toBe(true)
    // handled must stay false because chat.update threw
    const entry = getLivePermission('cscb_C')
    expect(entry).toBeDefined()
    expect(entry?.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Stale clicks
// ---------------------------------------------------------------------------

describe('handlePermissionClick — stale clicks', () => {
  test('mismatched request_id → chat.update "already decided", no decide(), markHandled called on success', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 5 })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        // Fresh request_id is 99 — the action_id encoded 5 is stale.
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
    // markHandled was called after stale-click update succeeded
    expect(getLivePermission('cscb_C')?.handled).toBe(true)
  })

  test('stale-click chat.update throws → handled stays false', async () => {
    await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 5 })
    const chatForClick = makeChatStub({ updateError: new Error('network error') })
    const getClient = () => ({
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 99 }),
      }),
      decide: async () => ({}),
    })
    await handlePermissionClick(
      'perm_allow_cscb_C_5',
      'U_USER1',
      {
        getClient,
        web: chatForClick.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    const entry = getLivePermission('cscb_C')
    expect(entry).toBeDefined()
    expect(entry?.handled).toBe(false)
  })

  test('no live entry → no-op (true return, no chat call, no markHandled)', async () => {
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

  test('ErrSpawnNotFound from get() → treated as stale: chat.update "already decided" + markHandled on success', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 3 })
    const getClient = () => ({
      get: async () => { throw errSpawnNotFound() },
      decide: async () => ({}),
    })
    await handlePermissionClick(
      'perm_allow_cscb_C_3',
      'U_USER1',
      {
        getClient,
        web: seed.web.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('already decided')
    expect(getLivePermission('cscb_C')?.handled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Generic get() failure
// ---------------------------------------------------------------------------

describe('handlePermissionClick — generic get() failure', () => {
  test('generic get() failure returns true and does NOT touch handled', async () => {
    await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 5 })
    const chat = makeChatStub()
    const getClient = () => ({
      get: async () => { throw errGeneric('get', 'ErrInternal', 'transient failure') },
      decide: async () => ({}),
    })
    const handled = await handlePermissionClick(
      'perm_allow_cscb_C_5',
      'U_USER1',
      {
        getClient,
        web: chat.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    expect(handled).toBe(true)
    // handled must be untouched (still false) — tick will re-evaluate
    const entry = getLivePermission('cscb_C')
    expect(entry).toBeDefined()
    expect(entry?.handled).toBe(false)
    // No chat calls from the click handler
    expect(chat.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Decide idempotency
// ---------------------------------------------------------------------------

describe('handlePermissionClick — decide error paths', () => {
  test('ErrAlreadyDecided → treated as success, chat.update lands, markHandled called', async () => {
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
    expect(getLivePermission('cscb_C')?.handled).toBe(true)
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

// ---------------------------------------------------------------------------
// Stale-click guard (b.o5y round-2 regression)
// ---------------------------------------------------------------------------

describe('handlePermissionClick — stale click against advanced live entry', () => {
  test('stale click against an advanced live entry is a no-op (no chat.update against the new message)', async () => {
    // Seed a live entry with requestId=10
    await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestId: 10 })

    // Confirm the live entry exists with requestId=10 before the click
    const before = getLivePermission('cscb_C')
    expect(before).toBeDefined()
    expect(before?.requestId).toBe(10)
    expect(before?.handled).toBe(false)

    // Build a stale action_id encoding request_id=5 (lower than the live 10)
    const staleActionId = encodePermissionActionId('allow', 'cscb_C', 5)

    // deps whose getClient.get and decide should NEVER be called
    const chat = makeChatStub()
    let getCalled = false
    let decideCalled = false
    const getClient = () => ({
      get: async () => {
        getCalled = true
        return cannedGetResult({ claude_instance_id: 'cscb_C' })
      },
      decide: async () => {
        decideCalled = true
        return {}
      },
    })

    const handled = await handlePermissionClick(
      staleActionId,
      'U_X',
      {
        getClient,
        web: chat.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )

    expect(handled).toBe(true)
    expect(getCalled).toBe(false)
    expect(decideCalled).toBe(false)
    expect(chat.calls).toHaveLength(0)

    // Live entry is unchanged
    const after = getLivePermission('cscb_C')
    expect(after?.requestId).toBe(10)
    expect(after?.handled).toBe(false)
  })
})
