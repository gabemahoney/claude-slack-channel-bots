/**
 * permission-poller.test.ts — SR-2.1 poller behavior.
 *
 * Drives the poller directly via injected setInterval/clearInterval stubs
 * + WebClient.chat stub + agent-director client stub. Coverage:
 *
 *   - New check_permission row → posts Block Kit message to spawn's
 *     `channel` label and records the live entry (case 1).
 *   - request_id matches, handled=false → no-op (case 2).
 *   - request_id matches, handled=true  → no-op (case 3).
 *   - request_id advances, handled=false → chat.update "no longer active"
 *     + dropPermission + fresh postMessage (case 4 handled=false).
 *   - request_id advances, handled=true  → dropPermission + fresh
 *     postMessage, NO chat.update (case 4 handled=true).
 *   - Spawn disappears, handled=false → expire chat.update + drop (case 5
 *     handled=false).
 *   - Spawn disappears, handled=true → drop only, NO chat.update (case 5
 *     handled=true).
 *   - permission_request===null in get() while in check_permission →
 *     transient race; no post, no drop, no update; existing entry untouched.
 *   - tool_input JSON-parses; un-parseable falls back to raw-string.
 *   - get() ErrSpawnNotFound → skip silently.
 *   - postMessage returns no ts → no live entry recorded.
 *   - Skipped-tick observability (5+ consecutive skips logs WARN).
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetPollerState,
  buildPermissionBlocks,
  dropPermission,
  getLivePermission,
  markHandled,
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
  stopPermissionPoller()
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
// Tick behavior — case 1: no live entry
// ---------------------------------------------------------------------------

describe('poller tick — case 1: no live entry', () => {
  test('posts Block Kit message and records live entry with handled=false', async () => {
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

    expect(ivl.pending).toHaveLength(1)
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const live = getLivePermission('cscb_C')
    expect(live).toBeDefined()
    expect(live?.channelId).toBe('CH123')
    expect(live?.messageTs).toBe('99.88')
    expect(live?.requestId).toBe(7)
    expect(live?.handled).toBe(false)

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

  test('get() ErrSpawnNotFound → skip silently, no entry recorded', async () => {
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

  test('postMessage returns no ts → no live entry recorded', async () => {
    const ivl = makeInterval()
    // Override postMessage to return no ts
    const calls: ChatCall[] = []
    const web = {
      chat: {
        async postMessage(args: unknown): Promise<{ ts?: string }> {
          const a = args as { channel: string; text: string }
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text })
          return {} // no ts
        },
        async update(args: unknown): Promise<unknown> {
          const a = args as { channel: string; ts: string; text: string }
          calls.push({ kind: 'update', channel: a.channel, ts: a.ts, text: a.text })
          return {}
        },
      },
    }
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 1 }),
      }),
    })
    startPermissionPoller({
      getClient,
      web: web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: () => { /* swallow */ },
    })
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(getLivePermission('cscb_C')).toBeUndefined()
    stopPermissionPoller()
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — cases 2 & 3: request_id matches → no-op
// ---------------------------------------------------------------------------

describe('poller tick — cases 2 & 3: request_id matches (no-op)', () => {
  test('case 2: request_id matches, handled=false → no-op (no extra postMessage)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'TS1' })
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 5 }),
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: seeds the live entry (handled=false by default)
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(getLivePermission('cscb_C')?.handled).toBe(false)

    // Tick 2: same request_id, handled=false → no-op
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1) // still 1
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
    stopPermissionPoller()
  })

  test('case 3: request_id matches, handled=true → no-op (no extra postMessage, no chat.update)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'TS1' })
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 5 }),
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: seeds the live entry
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)

    // Simulate click handler marking handled
    markHandled('cscb_C')
    expect(getLivePermission('cscb_C')?.handled).toBe(true)

    // Tick 2: same request_id, handled=true → no-op
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1) // still 1
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
    stopPermissionPoller()
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — case 4: request_id advanced
// ---------------------------------------------------------------------------

describe('poller tick — case 4: request_id advanced', () => {
  test('handled=false: chat.update "no longer active" fires + entry dropped + fresh postMessage', async () => {
    const ivl = makeInterval()
    // Track postMessage ts: first post gets 'TS1', second gets 'TS2'
    const tsList = ['TS1', 'TS2']
    const calls: ChatCall[] = []
    const web = {
      chat: {
        async postMessage(args: unknown): Promise<{ ts: string }> {
          const a = args as { channel: string; text: string }
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text })
          return { ts: tsList.shift() ?? 'TS-fallback' }
        },
        async update(args: unknown): Promise<unknown> {
          const a = args as { channel: string; ts: string; text: string }
          calls.push({ kind: 'update', channel: a.channel, ts: a.ts, text: a.text })
          return {}
        },
      },
    }

    let currentRequestId = 10
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: currentRequestId }),
      }),
    })
    startPermissionPoller({ getClient, web: web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval })

    // Tick 1: post for request_id=10
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(getLivePermission('cscb_C')?.handled).toBe(false)

    // Advance request_id (entry still handled=false)
    currentRequestId = 11

    // Tick 2: request_id advanced, handled=false
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const updates = calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('no longer active')
    expect(updates[0].ts).toBe('TS1') // old ts

    const posts = calls.filter((c) => c.kind === 'postMessage')
    expect(posts).toHaveLength(2)

    // Old entry dropped; new entry for request_id=11 recorded
    const live = getLivePermission('cscb_C')
    expect(live).toBeDefined()
    expect(live?.requestId).toBe(11)
    expect(live?.messageTs).toBe('TS2')

    stopPermissionPoller()
  })

  test('handled=true: NO chat.update fires, entry dropped, fresh postMessage for new request_id', async () => {
    const ivl = makeInterval()
    const tsList = ['TS1', 'TS2']
    const calls: ChatCall[] = []
    const web = {
      chat: {
        async postMessage(args: unknown): Promise<{ ts: string }> {
          const a = args as { channel: string; text: string }
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text })
          return { ts: tsList.shift() ?? 'TS-fallback' }
        },
        async update(args: unknown): Promise<unknown> {
          const a = args as { channel: string; ts: string; text: string }
          calls.push({ kind: 'update', channel: a.channel, ts: a.ts, text: a.text })
          return {}
        },
      },
    }

    let currentRequestId = 10
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: currentRequestId }),
      }),
    })
    startPermissionPoller({ getClient, web: web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval })

    // Tick 1: post + mark handled (simulating click handler success)
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    markHandled('cscb_C')
    expect(getLivePermission('cscb_C')?.handled).toBe(true)

    // Advance request_id
    currentRequestId = 11

    // Tick 2: request_id advanced, handled=true → NO chat.update
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const updates = calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(0) // suppressed because handled=true

    const posts = calls.filter((c) => c.kind === 'postMessage')
    expect(posts).toHaveLength(2) // fresh post for new request_id

    const live = getLivePermission('cscb_C')
    expect(live?.requestId).toBe(11)

    stopPermissionPoller()
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — case 5: spawn disappears
// ---------------------------------------------------------------------------

describe('poller tick — case 5: spawn disappears from list', () => {
  test('handled=false: expire chat.update fires + entry dropped', async () => {
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
    expect(getLivePermission('cscb_C')?.handled).toBe(false)

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

  test('handled=true: NO chat.update fires, entry dropped silently', async () => {
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

    // Tick 1: post, then simulate click handler success (markHandled)
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    markHandled('cscb_C')
    expect(getLivePermission('cscb_C')?.handled).toBe(true)

    // Tick 2: spawn disappears, handled=true → suppress chat.update
    listReturn = { spawns: [] }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(0) // suppressed
    expect(getLivePermission('cscb_C')).toBeUndefined() // dropped regardless

    stopPermissionPoller()
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — transient race: permission_request===null
// ---------------------------------------------------------------------------

describe('poller tick — transient race: permission_request null', () => {
  test('get() returns permission_request=null → no post, no drop, no update; existing entry untouched', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'TS1' })

    let returnNullPermission = false
    const getClient = () => ({
      list: async () => ({
        spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        permission_request: returnNullPermission ? undefined : cannedPermissionRequest({ request_id: 3 }),
      }),
    })
    startPermissionPoller({ getClient, web: chat.web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval })

    // Tick 1: normal → entry seeded
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission('cscb_C')).toBeDefined()
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)

    // Now get() will return no permission_request (transient race)
    returnNullPermission = true

    // Tick 2: permission_request=null → skip; existing entry untouched
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1) // no new post
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0) // no update
    const live = getLivePermission('cscb_C')
    expect(live).toBeDefined() // not dropped
    expect(live?.requestId).toBe(3) // unchanged

    stopPermissionPoller()
  })
})

// ---------------------------------------------------------------------------
// Skipped-tick observability
// ---------------------------------------------------------------------------

describe('poller tick — skipped-tick observability', () => {
  test('5+ consecutive skips logs WARN', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const logCalls: unknown[][] = []

    // Build a blocking tick: list() hangs forever (never resolves during test)
    let resolveTick: () => void = () => {}
    const getClient = () => ({
      list: async () => {
        await new Promise<void>((resolve) => { resolveTick = resolve })
        return { spawns: [] }
      },
      get: async () => cannedGetResult({ claude_instance_id: 'x' }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: (...args) => { logCalls.push(args) },
    })

    // Fire tick 1 — it goes in-flight (list() hangs) and never finishes
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 5)) // let tick start

    // Fire 5 more ticks while the first is still in-flight → 5 skips
    for (let i = 0; i < 5; i++) {
      ivl.pending[0].cb()
    }
    await new Promise((r) => setTimeout(r, 5))

    // Should have logged at least one WARN about skipped ticks
    const warnLogs = logCalls.filter((args) => String(args[0]).includes('skipped'))
    expect(warnLogs.length).toBeGreaterThan(0)

    // Unblock the hanging tick so cleanup works
    resolveTick()
    await new Promise((r) => setTimeout(r, 10))
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

  test('markHandled returns false when no live entry exists', () => {
    const result = markHandled('nonexistent_id')
    expect(result).toBe(false)
  })

  test('markHandled returns true and sets handled=true when entry exists', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ postMessageTs: 'X' })
    const getClient = () => ({
      list: async () => ({ spawns: [cannedListRow({ claude_instance_id: 'cscb_C', state: 'check_permission', labels: { service: 'cscb', channel: 'CH' } })] }),
      get: async () => cannedGetResult({ claude_instance_id: 'cscb_C', state: 'check_permission', permission_request: cannedPermissionRequest({ request_id: 1 }) }),
    })
    startPermissionPoller({ getClient, web: chat.web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval })
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission('cscb_C')?.handled).toBe(false)
    const result = markHandled('cscb_C')
    expect(result).toBe(true)
    expect(getLivePermission('cscb_C')?.handled).toBe(true)
    stopPermissionPoller()
  })
})
