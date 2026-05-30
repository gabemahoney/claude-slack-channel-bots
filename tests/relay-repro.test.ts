/**
 * relay-repro.test.ts — relay bug reproducers and acceptance tests for b.o5y.
 *
 * Scenario A (b.5um / b.o5y acceptance #1): consecutive request_id on same spawn.
 * Scenario B (b.yuy / b.o5y acceptance #1): click-handler generic error must not stall relay.
 * New scenario b.o5y #2: handled=true + request_id advances → NO stale-update, fresh post.
 * New scenario b.o5y #3: handled=true + spawn leaves check_permission → NO chat.update, entry dropped.
 * New scenario b.o5y #6: click chat.update failure leaves handled=false → tick fires second-chance update.
 *
 * NOTE: Scenario E (postMessage no-ts duplicate) has moved to b.dym and is tracked separately.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetPollerState,
  getLivePermission,
  markHandled,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import { handlePermissionClick } from '../src/permission-click-handler.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedPermissionRequest,
  errGeneric,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Local plumbing (mirrors permission-poller.test.ts)
// ---------------------------------------------------------------------------

interface ManualInterval { cb: () => void; ms: number; cleared: boolean }

function makeIntervalStubs(): {
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  pending: ManualInterval[]
} {
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

/**
 * chat stub where chat.postMessage's return value can vary per call.
 * `tsSequence` is consumed FIFO; an `undefined` slot returns `{}` (no ts),
 * a string slot returns `{ ts: <string> }`. Falls back to `{ ts: 'fallback' }`
 * once exhausted.
 */
function makeFlexibleChatStub(opts: { tsSequence?: Array<string | undefined>; updateError?: Error } = {}): {
  web: { chat: { postMessage: (a: unknown) => Promise<{ ts?: string }>; update: (a: unknown) => Promise<unknown> } }
  calls: ChatCall[]
} {
  const calls: ChatCall[] = []
  const seq = [...(opts.tsSequence ?? [])]
  return {
    web: {
      chat: {
        async postMessage(args: unknown): Promise<{ ts?: string }> {
          const a = args as { channel: string; text: string }
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text })
          if (seq.length === 0) return { ts: 'fallback-ts' }
          const next = seq.shift()
          return next === undefined ? {} : { ts: next }
        },
        async update(args: unknown): Promise<unknown> {
          const a = args as { channel: string; ts: string; text: string }
          calls.push({ kind: 'update', channel: a.channel, ts: a.ts, text: a.text })
          if (opts.updateError) throw opts.updateError
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
// Scenario A — consecutive permission requests on same spawn
// (b.5um / b.o5y acceptance #1)
//
// Under the new tick-driven request_id reconciliation design (b.o5y), the
// poller calls client.get() every tick and compares request_id. When it
// advances (7→8), the tick detects the mismatch and posts a fresh Block Kit.
// The old code failed because it skipped on livePermissions.has() without
// inspecting the underlying request_id.
// ---------------------------------------------------------------------------

describe('b.o5y Scenario A — consecutive request_id on same spawn', () => {
  test('request_id advances from 7→8 while spawn stays in check_permission; the new request must be posted', async () => {
    const ivl = makeIntervalStubs()
    const chat = makeFlexibleChatStub({ tsSequence: ['ts-req7', 'ts-req8'] })

    let currentRequestId = 7
    const getClient = () => ({
      list: async () => ({
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_A',
            state: 'check_permission',
            labels: { service: 'cscb', channel: 'CH_A' },
          }),
        ],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_A',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: currentRequestId }),
      }),
    })

    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: () => { /* swallow */ },
    })

    // Tick 1 — poller posts a prompt for request_id=7.
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(getLivePermission('cscb_A')?.requestId).toBe(7)

    // Agent-director advanced to a new permission request on the same spawn.
    currentRequestId = 8

    // Tick 2 — list() still returns the spawn, get() returns req 8.
    // New design: mismatch detected, handled=false → chat.update "no longer
    // active" + drop + fresh post for req 8.
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Scenario B — click-handler non-fatal error must not stall relay
// (b.yuy / b.o5y acceptance #1)
//
// Under the new design, the 30-second claim window is gone. A generic
// get() failure in the click handler leaves handled=false. On tick 2, when
// request_id has advanced, the poller detects the mismatch, sees handled=false,
// sends "no longer active", drops the entry, and posts the fresh Block Kit.
// ---------------------------------------------------------------------------

describe('b.o5y Scenario B — click-handler non-fatal error must not stall subsequent relays', () => {
  test('after click-handler get() throws generic AgentDirectorError, a NEW request_id on same spawn must still be posted', async () => {
    const ivl = makeIntervalStubs()
    const chat = makeFlexibleChatStub({ tsSequence: ['ts-req5', 'ts-req6'] })

    let currentRequestId = 5
    const pollerGetClient = () => ({
      list: async () => ({
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_B',
            state: 'check_permission',
            labels: { service: 'cscb', channel: 'CH_B' },
          }),
        ],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_B',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: currentRequestId }),
      }),
    })

    startPermissionPoller({
      getClient: pollerGetClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: () => { /* swallow */ },
    })

    // Tick 1 — seed the live entry for request_id=5.
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(getLivePermission('cscb_B')).toBeDefined()

    // Operator clicks Allow. The click-handler's client.get() throws a
    // generic AgentDirectorError (NOT ErrSpawnNotFound, NOT ErrAlreadyDecided).
    // Per click-handler contract, handler returns true WITHOUT touching handled.
    const clickGetClient = () => ({
      get: async () => { throw errGeneric('get', 'ErrInternal', 'transient AD failure') },
      decide: async () => ({}),
    })

    const handled = await handlePermissionClick(
      'perm_allow_cscb_B_5',
      'U_USER',
      {
        getClient: clickGetClient,
        web: chat.web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    expect(handled).toBe(true)

    // Bug precondition: live entry still here, handled=false (get() threw before
    // any chat.update was attempted — the click handler left handled untouched).
    const stalled = getLivePermission('cscb_B')
    expect(stalled).toBeDefined()
    expect(stalled?.handled).toBe(false)

    // Agent-director has progressed: request_id=6 is now the open request.
    currentRequestId = 6

    // Tick 2 — spawn still in check_permission with a new request.
    // New design: mismatch + handled=false → chat.update "no longer active" +
    // drop + fresh post for req 6.
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// b.o5y acceptance #2 — request_id advances after click does not stomp decision update
// ---------------------------------------------------------------------------

describe('b.o5y — request_id advance after click does not stomp decision update', () => {
  test('handled=true + request_id advances → NO chat.update on old ts, entry dropped, fresh post for new request_id', async () => {
    const ivl = makeIntervalStubs()
    const chat = makeFlexibleChatStub({ tsSequence: ['ts-req1', 'ts-req2'] })

    let currentRequestId = 1
    const getClient = () => ({
      list: async () => ({
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_X',
            state: 'check_permission',
            labels: { service: 'cscb', channel: 'CH_X' },
          }),
        ],
      }),
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_X',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: currentRequestId }),
      }),
    })

    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: () => { /* swallow */ },
    })

    // Tick 1: post for request_id=1
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(getLivePermission('cscb_X')?.messageTs).toBe('ts-req1')

    // Simulate click handler success: markHandled directly
    markHandled('cscb_X')
    expect(getLivePermission('cscb_X')?.handled).toBe(true)

    // Agent-director advances to request_id=2
    currentRequestId = 2

    // Tick 2: request_id changed, handled=true → NO chat.update ("no longer active"
    // suppressed because the click handler already wrote "Allowed/Denied by …")
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // No chat.update against the old ts
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(0)

    // Fresh postMessage for request_id=2
    const posts = chat.calls.filter((c) => c.kind === 'postMessage')
    expect(posts).toHaveLength(2)

    // Old entry dropped; new entry recorded with new request_id
    const live = getLivePermission('cscb_X')
    expect(live).toBeDefined()
    expect(live?.requestId).toBe(2)
    expect(live?.messageTs).toBe('ts-req2')
  })
})

// ---------------------------------------------------------------------------
// b.o5y acceptance #3 — spawn leaves check_permission after click does not stomp decision update
// ---------------------------------------------------------------------------

describe('b.o5y — spawn leaves check_permission after click does not stomp decision update', () => {
  test('handled=true + spawn leaves check_permission → NO chat.update, entry dropped', async () => {
    const ivl = makeIntervalStubs()
    const chat = makeFlexibleChatStub({ tsSequence: ['ts-req1'] })

    let listReturn: import('agent-director').ListResult = {
      spawns: [
        cannedListRow({
          claude_instance_id: 'cscb_Y',
          state: 'check_permission',
          labels: { service: 'cscb', channel: 'CH_Y' },
        }),
      ],
    }
    const getClient = () => ({
      list: async () => listReturn,
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_Y',
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
      log: () => { /* swallow */ },
    })

    // Tick 1: post for request_id=1
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)

    // Simulate click handler success
    markHandled('cscb_Y')
    expect(getLivePermission('cscb_Y')?.handled).toBe(true)

    // Spawn leaves check_permission (e.g., AD transitions to running)
    listReturn = { spawns: [] }

    // Tick 2: spawn no longer in list, handled=true → suppress chat.update, just drop
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // No expire chat.update (would stomp the "Allowed/Denied by …" message)
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)

    // Entry dropped
    expect(getLivePermission('cscb_Y')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// b.o5y acceptance #6 — click handler chat.update failure leaves handled=false
// so next tick clears buttons via expire path
// ---------------------------------------------------------------------------

describe('b.o5y — click handler chat.update failure leaves handled=false so next tick clears buttons', () => {
  test('decide() succeeds but chat.update throws → handled=false → next tick fires expire chat.update', async () => {
    const ivl = makeIntervalStubs()

    // postMessage returns ts; update never throws for the poller (only for click handler)
    const pollerPostTs = 'ts-perm1'
    const calls: ChatCall[] = []
    let updateCallCount = 0
    const web = {
      chat: {
        async postMessage(args: unknown): Promise<{ ts: string }> {
          const a = args as { channel: string; text: string }
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text })
          return { ts: pollerPostTs }
        },
        async update(args: unknown): Promise<unknown> {
          const a = args as { channel: string; ts: string; text: string }
          calls.push({ kind: 'update', channel: a.channel, ts: a.ts, text: a.text })
          updateCallCount++
          // The click handler's update call (first update call) throws.
          // Subsequent poller expire calls should succeed.
          if (updateCallCount === 1) throw new Error('Slack rate limit')
          return {}
        },
      },
    }

    let listReturn: import('agent-director').ListResult = {
      spawns: [
        cannedListRow({
          claude_instance_id: 'cscb_Z',
          state: 'check_permission',
          labels: { service: 'cscb', channel: 'CH_Z' },
        }),
      ],
    }

    const pollerGetClient = () => ({
      list: async () => listReturn,
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_Z',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 1 }),
      }),
    })

    startPermissionPoller({
      getClient: pollerGetClient,
      web: web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: () => { /* swallow */ },
    })

    // Tick 1: post the prompt
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(getLivePermission('cscb_Z')).toBeDefined()

    // Click handler: decide() succeeds, chat.update throws → handled stays false
    const clickGetClient = () => ({
      get: async () => cannedGetResult({
        claude_instance_id: 'cscb_Z',
        state: 'check_permission',
        permission_request: cannedPermissionRequest({ request_id: 1 }),
      }),
      decide: async () => ({}),
    })

    const clickResult = await handlePermissionClick(
      'perm_allow_cscb_Z_1',
      'U_USER',
      {
        getClient: clickGetClient,
        web: web as never,
        resolveUserName: async () => 'alice',
        log: () => { /* swallow */ },
      },
    )
    expect(clickResult).toBe(true)

    // Entry still present, handled=false (chat.update threw)
    const entry = getLivePermission('cscb_Z')
    expect(entry).toBeDefined()
    expect(entry?.handled).toBe(false)

    // Spawn leaves check_permission (AD moved on)
    listReturn = { spawns: [] }

    // Tick 2: spawn no longer in list, handled=false → expire chat.update fires
    // (second-chance update to remove the buttons)
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const expireUpdates = calls.filter((c) => c.kind === 'update')
    // First update call was the click handler's (threw), second is the expire call
    expect(expireUpdates).toHaveLength(2)
    expect(expireUpdates[1].text).toContain('expired')

    // Entry is now dropped
    expect(getLivePermission('cscb_Z')).toBeUndefined()
  })
})
