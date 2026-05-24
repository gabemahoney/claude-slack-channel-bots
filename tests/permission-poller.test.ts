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
 *   - get() ErrSpawnNotFound → skip silently.
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
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedPermissionRequest,
  errSpawnNotFound,
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
  test('emits perm_allow_<instance>_<request_id> and perm_deny_<instance>_<request_id>', () => {
    const blocks = buildPermissionBlocks('Bash', { command: 'rm -rf' }, 'cscb_C012345', 42) as Array<Record<string, unknown>>
    const actions = blocks[1] as { elements: Array<{ action_id: string }> }
    expect(actions.elements[0].action_id).toBe('perm_allow_cscb_C012345_42')
    expect(actions.elements[1].action_id).toBe('perm_deny_cscb_C012345_42')
  })
})

// ---------------------------------------------------------------------------
// Tick behavior
// ---------------------------------------------------------------------------

describe('poller tick — new check_permission row', () => {
  test('posts Block Kit message and records live entry', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: '99.88' })
    const getClient = () => ({
      list: async () => ({
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_C',
            state: 'check_permission',
            labels: { service: 'cscb', channel: 'CH123' },
          }),
        ],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 7 }),
      }),
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

    const live = getLivePermission('cscb_C')
    expect(live).toBeDefined()
    expect(live?.channelId).toBe('CH123')
    expect(live?.messageTs).toBe('99.88')
    expect(live?.requestId).toBe(7)

    const postCalls = chat.calls.filter((c) => c.kind === 'postMessage')
    expect(postCalls).toHaveLength(1)
    expect(postCalls[0].channel).toBe('CH123')

    stopPermissionPoller()
  })

  test('skips when channel label is missing', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const getClient = () => ({
      list: async () => ({
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_C',
            state: 'check_permission',
            labels: { service: 'cscb' }, // no channel
          }),
        ],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 1 }),
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
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(0)
    stopPermissionPoller()
  })

  test('falls back to raw-string on unparseable tool_input', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: '99.88' })
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ tool_input: '{not json' }),
      }),
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
    expect(getLivePermission('cscb_C')).toBeDefined()
    stopPermissionPoller()
  })

  test('skips when get() returns ErrSpawnNotFound', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
      }),
      get: async () => { throw errSpawnNotFound() },
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
    expect(getLivePermission('cscb_C')).toBeUndefined()
    expect(chat.calls).toHaveLength(0)
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
    let listReturn: import('agent-director').ListResult = {
      spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
    }
    const getClient = () => ({
      list: async () => listReturn,
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 1 }),
      }),
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
    expect(getLivePermission('cscb_C')).toBeDefined()

    // Tick 2: spawn no longer in check_permission → expire
    listReturn = { spawns: [] }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('expired')
    expect(getLivePermission('cscb_C')).toBeUndefined()

    stopPermissionPoller()
  })

  test('finalizedAt within 30s window suppresses the expired update', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'TS1' })
    let listReturn: import('agent-director').ListResult = {
      spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
    }
    const getClient = () => ({
      list: async () => listReturn,
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 1 }),
      }),
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

    // Click handler claims the message (simulated)
    claimPermission('cscb_C')

    // Tick 2: spawn disappears, but the claim should suppress the update.
    listReturn = { spawns: [] }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(0)
    expect(getLivePermission('cscb_C')).toBeUndefined() // dropped regardless

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
    const getClient = () => ({ list: async () => ({ spawns: [] }), get: async () => cannedGetResult({ claude_instance_id: 'x' }) })
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
    const getClient = () => ({
      list: async () => ({ spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })] }),
      get: async () => cannedGetResult({ claude_instance_id: 'cscb_C', state: 'check_permission', permission_request: cannedPermissionRequest({ request_id: 1 }) }),
    })
    startPermissionPoller({ getClient, web: chat.web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval })
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission('cscb_C')).toBeDefined()
    dropPermission('cscb_C')
    expect(getLivePermission('cscb_C')).toBeUndefined()
    stopPermissionPoller()
  })
})
