/**
 * permission-click-handler.test.ts — SR-2.2 click → decide path under the
 * request_token / plural-projection wire.
 *
 * Contract pins (Epic 1 — full pre-decide rewrite is Epic 2):
 *   - Happy path: parse action_id → get (token still in `permission_requests`)
 *     → decide → chat.update "Allowed/Denied by <user>" → markHandled ONLY
 *     after update succeeds.
 *   - Happy path with chat.update throwing → markHandled NOT called.
 *   - Stale click (token absent from current `permission_requests`):
 *     chat.update "already decided" + markHandled on success.
 *   - ErrAlreadyDecided treated as success → chat.update lands + markHandled.
 *   - No live entry → returns true, no chat call, no markHandled.
 *   - Generic get() failure → returns true, does NOT touch handled.
 *   - ErrSpawnNotFound from get() → treated as stale.
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
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import {
  cannedGetResult,
  cannedGetResultPlural,
  cannedListRow,
  cannedPermissionRequest,
  errAlreadyDecided,
  errGeneric,
  errSpawnNotFound,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Shared fixtures — no inline magic strings (SR-8.1)
// ---------------------------------------------------------------------------

const INSTANCE_C = 'cscb_C'
const CHANNEL_CH = 'CH'
const TOKEN_A = '11111111-1111-4111-8111-111111111111'
const TOKEN_B = '22222222-2222-4222-8222-222222222222'
const TOKEN_C = '33333333-3333-4333-8333-333333333333'
const USER_ID = 'U_USER1'

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
async function seedLiveEntry(opts: { instanceId: string; channelId: string; requestToken: string; requestId?: number }): Promise<{ web: ReturnType<typeof makeChatStub>; pending: ManualInterval[] }> {
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
    get: async () => cannedGetResultPlural({
      claude_instance_id: opts.instanceId,
      state: 'check_permission',
      permission_requests: [cannedPermissionRequest({ request_token: opts.requestToken, request_id: opts.requestId ?? 1 })],
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
  test('allow → get (token still open) → decide(allow) → chat.update succeeds → markHandled called', async () => {
    const seed = await seedLiveEntry({ instanceId: INSTANCE_C, channelId: CHANNEL_CH, requestToken: TOKEN_A })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })

    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      USER_ID,
      {
        getClient,
        web: seed.web.web as never,
        resolveUserName: async () => 'alice',
      },
    )
    expect(handled).toBe(true)
    expect(decideCalls).toHaveLength(1)
    // Epic 1: decide still takes only (claude_instance_id, decision). Epic 2
    // threads request_token through and removes the pre-decide refetch.
    expect(decideCalls[0]).toEqual({ claude_instance_id: INSTANCE_C, decision: 'allow' })
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('Allowed by alice')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
  })

  test('deny → decide(deny) → chat.update "Denied by" → markHandled called', async () => {
    const seed = await seedLiveEntry({ instanceId: INSTANCE_C, channelId: CHANNEL_CH, requestToken: TOKEN_A })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })
    await handlePermissionClick(
      encodePermissionActionId('deny', INSTANCE_C, TOKEN_A),
      USER_ID,
      { getClient, web: seed.web.web as never, resolveUserName: async () => 'bob' },
    )
    expect(decideCalls[0].decision).toBe('deny')
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates[0].text).toContain('Denied by bob')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
  })

  test('success path with chat.update throwing → markHandled NOT called, handled stays false', async () => {
    await seedLiveEntry({ instanceId: INSTANCE_C, channelId: CHANNEL_CH, requestToken: TOKEN_A })
    const chatForClick = makeChatStub({ updateError: new Error('Slack API down') })
    const getClient = () => ({
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
      decide: async () => ({}),
    })

    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      USER_ID,
      {
        getClient,
        web: chatForClick.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    expect(handled).toBe(true)
    const entry = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(entry).toBeDefined()
    expect(entry?.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Stale clicks
// ---------------------------------------------------------------------------

describe('handlePermissionClick — stale clicks', () => {
  test('action_id token absent from current `permission_requests` → "already decided" + markHandled on success, no decide()', async () => {
    const seed = await seedLiveEntry({ instanceId: INSTANCE_C, channelId: CHANNEL_CH, requestToken: TOKEN_A })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      // Fresh refetch shows a DIFFERENT token open — the clicked token has
      // closed out (decided or replaced).
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_B, request_id: 99 })],
      }),
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      USER_ID,
      { getClient, web: seed.web.web as never, resolveUserName: async () => 'alice' },
    )
    expect(decideCalls).toHaveLength(0)
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('already decided')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
  })

  test('empty `permission_requests` is also a stale-click signal', async () => {
    const seed = await seedLiveEntry({ instanceId: INSTANCE_C, channelId: CHANNEL_CH, requestToken: TOKEN_A })
    const getClient = () => ({
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [],
      }),
      decide: async () => ({}),
    })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      USER_ID,
      { getClient, web: seed.web.web as never, resolveUserName: async () => 'alice' },
    )
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('already decided')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
  })

  test('stale-click chat.update throws → handled stays false', async () => {
    await seedLiveEntry({ instanceId: INSTANCE_C, channelId: CHANNEL_CH, requestToken: TOKEN_A })
    const chatForClick = makeChatStub({ updateError: new Error('network error') })
    const getClient = () => ({
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_B, request_id: 99 })],
      }),
      decide: async () => ({}),
    })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      USER_ID,
      {
        getClient,
        web: chatForClick.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    const entry = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(entry).toBeDefined()
    expect(entry?.handled).toBe(false)
  })

  test('no live entry → no-op (true return, no chat call, no markHandled)', async () => {
    const decideCalls: import('agent-director').DecideParams[] = []
    const chat = makeChatStub()
    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', 'cscb_NOTHERE', TOKEN_C),
      USER_ID,
      {
        getClient: () => ({
          get: async () => cannedGetResult({ claude_instance_id: 'x' }),
          decide: async () => { decideCalls.push({} as never); return {} },
        }),
        web: chat.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    expect(handled).toBe(true)
    expect(decideCalls).toHaveLength(0)
    expect(chat.calls).toHaveLength(0)
  })

  test('ErrSpawnNotFound from get() → treated as stale: "already decided" + markHandled on success', async () => {
    const seed = await seedLiveEntry({ instanceId: INSTANCE_C, channelId: CHANNEL_CH, requestToken: TOKEN_A })
    const getClient = () => ({
      get: async () => { throw errSpawnNotFound() },
      decide: async () => ({}),
    })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      USER_ID,
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
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Generic get() failure
// ---------------------------------------------------------------------------

describe('handlePermissionClick — generic get() failure', () => {
  test('generic get() failure returns true and does NOT touch handled', async () => {
    await seedLiveEntry({ instanceId: INSTANCE_C, channelId: CHANNEL_CH, requestToken: TOKEN_A })
    const chat = makeChatStub()
    const getClient = () => ({
      get: async () => { throw errGeneric('get', 'ErrInternal', 'transient failure') },
      decide: async () => ({}),
    })
    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      USER_ID,
      {
        getClient,
        web: chat.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    expect(handled).toBe(true)
    const entry = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(entry).toBeDefined()
    expect(entry?.handled).toBe(false)
    expect(chat.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Decide idempotency
// ---------------------------------------------------------------------------

describe('handlePermissionClick — decide error paths', () => {
  test('ErrAlreadyDecided → treated as success, chat.update lands, markHandled called', async () => {
    const seed = await seedLiveEntry({ instanceId: INSTANCE_C, channelId: CHANNEL_CH, requestToken: TOKEN_A })
    let decideCalled = 0
    const getClient = () => ({
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 3 })],
      }),
      decide: async () => {
        decideCalled++
        throw errAlreadyDecided()
      },
    })
    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      USER_ID,
      { getClient, web: seed.web.web as never, resolveUserName: async () => 'eve' },
    )
    expect(handled).toBe(true)
    expect(decideCalled).toBe(1)
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates[0].text).toContain('Allowed by eve')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
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
      USER_ID,
      {
        getClient: () => ({ get: async () => cannedGetResult({ claude_instance_id: 'x' }), decide: async () => ({}) }),
        web: chat.web as never,
        resolveUserName: async () => 'alice',
      },
    )
    expect(handled).toBe(false)
  })

  test('returns false on malformed perm action id (missing cscb_ prefix on instance)', async () => {
    const chat = makeChatStub()
    const handled = await handlePermissionClick(
      `perm_allow_NOT_CSCB_PREFIX_${TOKEN_A}`,
      USER_ID,
      {
        getClient: () => ({ get: async () => cannedGetResult({ claude_instance_id: 'x' }), decide: async () => ({}) }),
        web: chat.web as never,
        resolveUserName: async () => 'alice',
      },
    )
    expect(handled).toBe(false)
  })

  test('returns false on perm action id with non-UUID trailing segment', async () => {
    const chat = makeChatStub()
    const handled = await handlePermissionClick(
      `perm_allow_${INSTANCE_C}_42`,
      USER_ID,
      {
        getClient: () => ({ get: async () => cannedGetResult({ claude_instance_id: 'x' }), decide: async () => ({}) }),
        web: chat.web as never,
        resolveUserName: async () => 'alice',
      },
    )
    expect(handled).toBe(false)
  })
})
