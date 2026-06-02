/**
 * permission-click-handler.test.ts — SR-2.2 click → decide path.
 *
 * Covers:
 *   - Happy path: parse action_id → claim → getPermission → decide → chat.update
 *     "Allowed/Denied" → drop entry.
 *   - Stale click via ErrPermissionRequestNotFound: chat.update stale, no decide().
 *   - Stale click via decided row (non-null decision): chat.update stale, no decide().
 *   - ErrAmbiguousRequest on decide: no chat.update, buttons stay visible.
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
  getLivePermission,
  makePermKey,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import {
  cannedGetPermissionResult,
  cannedListRow,
  cannedPermissionRequest,
  errAlreadyDecided,
  errAmbiguousRequest,
  errPermissionRequestNotFound,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Test UUIDs
// ---------------------------------------------------------------------------
const TOKEN_1 = '550e8400-e29b-41d4-a716-446655440001'
const TOKEN_2 = '550e8400-e29b-41d4-a716-446655440002'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Seed a live entry in the poller's module map by running one tick.
 * `requestToken` drives both the list row's permission_request and the
 * getPermission pre-flight stub.
 */
async function seedLiveEntry(opts: { instanceId: string; channelId: string; requestToken: string }): Promise<{ web: ReturnType<typeof makeChatStub>; pending: ManualInterval[] }> {
  const ivl = makeIntervalStubs()
  const chat = makeChatStub()
  const getClient = () => ({
    list: async () => ({
      spawns: [cannedListRow({
        claude_instance_id: opts.instanceId,
        state: 'check_permission',
        labels: { service: 'cscb', channel: opts.channelId },
        permission_request: cannedPermissionRequest({ request_token: opts.requestToken }),
      } as never)],
    }),
    // Return open (decision: null) so the seeded entry stays alive after posting.
    getPermission: async () => cannedGetPermissionResult({ request_token: opts.requestToken, decision: null }),
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
  test('allow → claim → getPermission (open) → decide(allow) → chat.update Allowed', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestToken: TOKEN_1 })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN_1, decision: null }),
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })

    const handled = await handlePermissionClick(
      `perm_allow_cscb_C_${TOKEN_1}`,
      {
        getClient,
        web: seed.web.web as never,
      },
    )
    expect(handled).toBe(true)
    expect(decideCalls).toHaveLength(1)
    expect(decideCalls[0]).toEqual({ claude_instance_id: 'cscb_C', request_token: TOKEN_1, decision: 'allow' })
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('Allowed')
  })

  test('deny → decide(deny) → chat.update Denied', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestToken: TOKEN_1 })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN_1, decision: null }),
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })
    await handlePermissionClick(
      `perm_deny_cscb_C_${TOKEN_1}`,
      { getClient, web: seed.web.web as never },
    )
    expect(decideCalls[0].decision).toBe('deny')
    expect(decideCalls[0].request_token).toBe(TOKEN_1)
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates[0].text).toContain('Denied')
  })
})

// ---------------------------------------------------------------------------
// Stale clicks
// ---------------------------------------------------------------------------

describe('handlePermissionClick — stale clicks', () => {
  test('no live entry → no-op (true return, no chat call)', async () => {
    const decideCalls: import('agent-director').DecideParams[] = []
    const chat = makeChatStub()
    const handled = await handlePermissionClick(
      `perm_allow_cscb_NOTHERE_${TOKEN_1}`,
      {
        getClient: () => ({
          getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN_1, decision: null }),
          decide: async () => { decideCalls.push({} as never); return {} },
        }),
        web: chat.web as never,
      },
    )
    expect(handled).toBe(true)
    expect(decideCalls).toHaveLength(0)
    expect(chat.calls).toHaveLength(0)
  })

  test('ErrPermissionRequestNotFound → chat.update stale, no decide(), entry dropped', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestToken: TOKEN_1 })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      getPermission: async () => { throw errPermissionRequestNotFound() },
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })
    const handled = await handlePermissionClick(
      `perm_allow_cscb_C_${TOKEN_1}`,
      { getClient, web: seed.web.web as never },
    )
    expect(handled).toBe(true)
    expect(decideCalls).toHaveLength(0)
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toMatch(/stale|already decided/i)
    // Entry should be dropped
    expect(getLivePermission(makePermKey('cscb_C', TOKEN_1))).toBeUndefined()
  })

  test('getPermission returns decided row → chat.update stale, no decide(), entry dropped', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestToken: TOKEN_1 })
    const decideCalls: import('agent-director').DecideParams[] = []
    const getClient = () => ({
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN_1, decision: 'allow' }),
      decide: async (params: import('agent-director').DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    })
    const handled = await handlePermissionClick(
      `perm_allow_cscb_C_${TOKEN_1}`,
      { getClient, web: seed.web.web as never },
    )
    expect(handled).toBe(true)
    expect(decideCalls).toHaveLength(0)
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toMatch(/stale|already decided/i)
    // Entry should be dropped
    expect(getLivePermission(makePermKey('cscb_C', TOKEN_1))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Decide error paths
// ---------------------------------------------------------------------------

describe('handlePermissionClick — decide error paths', () => {
  test('ErrAlreadyDecided → counted as success, chat.update lands', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestToken: TOKEN_1 })
    let decideCalled = 0
    const getClient = () => ({
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN_1, decision: null }),
      decide: async () => {
        decideCalled++
        throw errAlreadyDecided()
      },
    })
    const handled = await handlePermissionClick(
      `perm_allow_cscb_C_${TOKEN_1}`,
      { getClient, web: seed.web.web as never },
    )
    expect(handled).toBe(true)
    expect(decideCalled).toBe(1)
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates[0].text).toContain('Allowed')
  })

  test('ErrAmbiguousRequest on decide → chat.update NOT called, buttons stay visible', async () => {
    const seed = await seedLiveEntry({ instanceId: 'cscb_C', channelId: 'CH', requestToken: TOKEN_2 })
    const logCalls: unknown[][] = []
    const getClient = () => ({
      getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN_2, decision: null }),
      decide: async () => { throw errAmbiguousRequest() },
    })
    const handled = await handlePermissionClick(
      `perm_allow_cscb_C_${TOKEN_2}`,
      {
        getClient,
        web: seed.web.web as never,
        log: (...args: unknown[]) => { logCalls.push(args) },
      },
    )
    expect(handled).toBe(true)
    const updates = seed.web.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(0)
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
      {
        getClient: () => ({
          getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN_1, decision: null }),
          decide: async () => ({}),
        }),
        web: chat.web as never,
      },
    )
    expect(handled).toBe(false)
  })

  test('returns false on malformed perm action id (no UUID suffix)', async () => {
    const chat = makeChatStub()
    const handled = await handlePermissionClick(
      'perm_allow_cscb_C_42',
      {
        getClient: () => ({
          getPermission: async () => cannedGetPermissionResult({ request_token: TOKEN_1, decision: null }),
          decide: async () => ({}),
        }),
        web: chat.web as never,
      },
    )
    expect(handled).toBe(false)
  })
})
