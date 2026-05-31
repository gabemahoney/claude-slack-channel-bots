/**
 * permission-poller.test.ts — SR-2.1 / SR-8.4 poller behavior under the
 * plural-projection wire and composite-key live map.
 *
 * Coverage:
 *   - New row in `permission_requests` → posts Block Kit prompt + records
 *     live entry keyed on (claude_instance_id, request_token).
 *   - Two concurrent rows on a single tick → two distinct postMessage calls,
 *     two distinct map entries.
 *   - Repeat tick with the same plural projection → no duplicate postMessage,
 *     no map mutation (duplicate-tick no-op).
 *   - Empty `permission_requests` array → zero postMessage activity from
 *     the open-rows path; existing entries from prior ticks drop via the
 *     sweep.
 *   - `null` / `undefined` open-rows → logs and skips, no state change.
 *   - Row disappearance (Case 5) → expire chat.update + drop.
 *   - get() ErrSpawnNotFound → continue silently.
 *   - Skipped-tick observability (5+ consecutive in-flight ticks → warn).
 *   - buildPermissionBlocks emits the UUIDv4-anchored action_id shape.
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
  cannedGetResultPlural,
  cannedListRow,
  cannedPermissionRequest,
  cannedTwoRowPluralProjection,
  errSpawnNotFound,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Shared fixtures — no inline magic strings (SR-8.1)
// ---------------------------------------------------------------------------

const INSTANCE_C = 'cscb_C'
const CHANNEL_CH = 'CH'
const POST_TS = 'TS1'
const POST_TS_2 = 'TS2'

// A handful of reusable UUIDv4-shaped tokens. CSCB treats them as opaque.
const TOKEN_A = '11111111-1111-4111-8111-111111111111'
const TOKEN_B = '22222222-2222-4222-8222-222222222222'

// ---------------------------------------------------------------------------
// Test plumbing: a manual interval stub + a chat-only WebClient fake
// ---------------------------------------------------------------------------

interface ManualInterval {
  cb: () => void
  ms: number
  cleared: boolean
}

function makeInterval(): {
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
  blocks?: unknown
}

interface ChatStub {
  web: {
    chat: {
      postMessage: (a: unknown) => Promise<{ ts?: string }>
      update: (a: unknown) => Promise<unknown>
    }
  }
  calls: ChatCall[]
}

/**
 * Chat stub where each successive `postMessage` consumes the next `ts` from
 * `tsSequence` (undefined → returns `{}` to model the "no ts" failure). Once
 * the sequence is exhausted, falls back to a generated ts.
 */
function makeChatStub(opts: { tsSequence?: Array<string | undefined>; postMessageError?: Error; updateError?: Error } = {}): ChatStub {
  const calls: ChatCall[] = []
  const seq = [...(opts.tsSequence ?? [])]
  let fallback = 0
  return {
    web: {
      chat: {
        async postMessage(args: unknown): Promise<{ ts?: string }> {
          const a = args as { channel: string; text: string; blocks?: unknown }
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text, blocks: a.blocks })
          if (opts.postMessageError) throw opts.postMessageError
          if (seq.length === 0) return { ts: `auto-${++fallback}` }
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

const checkPermRow = (instance: string = INSTANCE_C, channel: string = CHANNEL_CH) =>
  cannedListRow({
    claude_instance_id: instance,
    state: 'check_permission',
    labels: { service: 'cscb', channel },
  })

afterEach(() => {
  stopPermissionPoller()
  _resetPollerState()
})

// ---------------------------------------------------------------------------
// Block Kit builder
// ---------------------------------------------------------------------------

describe('buildPermissionBlocks (SR-2.2 action_id shape with request_token)', () => {
  test('emits perm_allow_<instance>_<token> and perm_deny_<instance>_<token>', () => {
    const blocks = buildPermissionBlocks('Bash', { command: 'rm -rf' }, INSTANCE_C, TOKEN_A) as Array<Record<string, unknown>>
    const actions = blocks[1] as { elements: Array<{ action_id: string }> }
    expect(actions.elements[0].action_id).toBe(`perm_allow_${INSTANCE_C}_${TOKEN_A}`)
    expect(actions.elements[1].action_id).toBe(`perm_deny_${INSTANCE_C}_${TOKEN_A}`)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — Case 1: new entry
// ---------------------------------------------------------------------------

describe('poller tick — Case 1: new entry', () => {
  test('posts Block Kit message and records live entry with handled=false', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const row = cannedPermissionRequest({ request_token: TOKEN_A, request_id: 7 })
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [row],
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

    const live = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(live).toBeDefined()
    expect(live?.channelId).toBe(CHANNEL_CH)
    expect(live?.messageTs).toBe(POST_TS)
    expect(live?.requestToken).toBe(TOKEN_A)
    expect(live?.requestId).toBe(7)
    expect(live?.handled).toBe(false)

    const postCalls = chat.calls.filter((c) => c.kind === 'postMessage')
    expect(postCalls).toHaveLength(1)
    expect(postCalls[0].channel).toBe(CHANNEL_CH)
  })

  test('skips when channel label is missing', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const getClient = () => ({
      list: async () => ({
        spawns: [
          cannedListRow({
            claude_instance_id: INSTANCE_C,
            state: 'check_permission',
            labels: { service: 'cscb' },
          }),
        ],
      }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A })],
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
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(0)
  })

  test('falls back to raw-string on unparseable tool_input', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, tool_input: '{not json' })],
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
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeDefined()
  })

  test('get() ErrSpawnNotFound → skip silently, no entry recorded', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
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
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
    expect(chat.calls).toHaveLength(0)
  })

  test('postMessage returns no ts → no live entry recorded', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [undefined] })
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A })],
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
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — duplicate-tick no-op (Cases 2/3 collapsed)
// ---------------------------------------------------------------------------

describe('poller tick — duplicate (claude_instance_id, request_token) is a no-op', () => {
  test('repeat tick with same plural projection → no extra postMessage, map entry unchanged', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const row = cannedPermissionRequest({ request_token: TOKEN_A, request_id: 5 })
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [row],
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
    const seeded = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(seeded?.handled).toBe(false)
    expect(seeded?.messageTs).toBe(POST_TS)

    // Tick 2: identical projection → no-op
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)

    // Entry untouched (ts and handled flag preserved)
    const after = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(after?.messageTs).toBe(POST_TS)
    expect(after?.handled).toBe(false)
  })

  test('handled=true + duplicate row appearance → still no-op (no fresh post, no extra chat.update)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const row = cannedPermissionRequest({ request_token: TOKEN_A, request_id: 5 })
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [row],
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: seed
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)

    // Simulate click handler marking handled
    markHandled(INSTANCE_C, TOKEN_A)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)

    // Tick 2: same projection, handled=true → still no-op
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — two concurrent rows on a single tick (Epic 1 AC)
// ---------------------------------------------------------------------------

describe('poller tick — two concurrent open rows on a single tick', () => {
  test('two `permission_requests` rows → two distinct postMessage calls + two distinct map entries', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS, POST_TS_2] })

    // Use the canonical two-row builder, then re-tag the tokens so the test
    // can assert specific keys.
    const projection = cannedTwoRowPluralProjection(INSTANCE_C)
    projection.permission_requests = [
      { ...projection.permission_requests![0], request_token: TOKEN_A },
      { ...projection.permission_requests![1], request_token: TOKEN_B },
    ]

    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => projection,
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

    const posts = chat.calls.filter((c) => c.kind === 'postMessage')
    expect(posts).toHaveLength(2)
    // Both prompts went to the same channel (same spawn)
    expect(posts.every((c) => c.channel === CHANNEL_CH)).toBe(true)

    const entryA = getLivePermission(INSTANCE_C, TOKEN_A)
    const entryB = getLivePermission(INSTANCE_C, TOKEN_B)
    expect(entryA).toBeDefined()
    expect(entryB).toBeDefined()
    expect(entryA?.messageTs).toBe(POST_TS)
    expect(entryB?.messageTs).toBe(POST_TS_2)
    expect(entryA?.requestToken).toBe(TOKEN_A)
    expect(entryB?.requestToken).toBe(TOKEN_B)
  })

  test('repeat tick with the same two-row projection → zero additional postMessage, map unchanged', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS, POST_TS_2] })

    const rows = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
      cannedPermissionRequest({ request_token: TOKEN_B, request_id: 2 }),
    ]
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: rows,
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: seed two entries
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(2)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.messageTs).toBe(POST_TS)
    expect(getLivePermission(INSTANCE_C, TOKEN_B)?.messageTs).toBe(POST_TS_2)

    // Tick 2: identical projection → no extra posts, no updates
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(2)
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — empty / null / undefined open-rows
// ---------------------------------------------------------------------------

describe('poller tick — non-positive open-rows responses', () => {
  test('empty `permission_requests` array → zero postMessage from open-rows path; prior entries drop via sweep', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })

    let permissionsList: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: permissionsList,
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: seed
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeDefined()

    // Switch to empty array — Case 5 sweep should expire + drop the seeded entry.
    permissionsList = []
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // No new posts from the open-rows path
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    // Expire chat.update fired (handled=false)
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('expired')
    // Entry dropped
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
  })

  test('null `permission_requests` → logs and skips the row, no postMessage', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const logCalls: unknown[][] = []

    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResult({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: null,
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: (...args) => { logCalls.push(args) },
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // No new posts: the open-rows path was skipped.
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(0)
    // No live entry was created from this row.
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
    // Non-conformance was logged
    const nonConfLogs = logCalls.filter((args) => String(args[0]).includes('non-conforming'))
    expect(nonConfLogs.length).toBeGreaterThan(0)
  })

  test('null `permission_requests` preserves prior entries for that instance (SR-2.1)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })

    let projectionMode: 'present' | 'null' = 'present'
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => projectionMode === 'present'
        ? cannedGetResultPlural({
            claude_instance_id: INSTANCE_C,
            state: 'check_permission',
            permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 3 })],
          })
        : cannedGetResult({
            claude_instance_id: INSTANCE_C,
            state: 'check_permission',
            permission_requests: null,
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

    // Tick 1: seed entry (handled=false so a naive sweep would expire it)
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(false)

    // Tick 2: get() returns null projection — SR-2.1 says the sweep must skip
    // entries on the non-conforming instance.
    projectionMode = 'null'
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeDefined()
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1) // tick 1 only
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
  })

  test('undefined `permission_requests` preserves prior entries for that instance (SR-2.1)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })

    let projectionMode: 'present' | 'undefined' = 'present'
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => projectionMode === 'present'
        ? cannedGetResultPlural({
            claude_instance_id: INSTANCE_C,
            state: 'check_permission',
            permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 3 })],
          })
        // permission_requests field omitted entirely
        : cannedGetResult({
            claude_instance_id: INSTANCE_C,
            state: 'check_permission',
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

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(false)

    projectionMode = 'undefined'
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeDefined()
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
  })

  test('undefined `permission_requests` → same as null (logs + skips)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const logCalls: unknown[][] = []

    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      // permission_requests field omitted entirely
      get: async () => cannedGetResult({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: (...args) => { logCalls.push(args) },
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(chat.calls).toHaveLength(0)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
    const nonConfLogs = logCalls.filter((args) => String(args[0]).includes('non-conforming'))
    expect(nonConfLogs.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — Case 5: row disappears
// ---------------------------------------------------------------------------

describe('poller tick — Case 5: row disappears from plural projection', () => {
  test('handled=false: expire chat.update fires + entry dropped', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })

    let listReturn: import('agent-director').ListResult = {
      spawns: [checkPermRow()],
    }
    const getClient = () => ({
      list: async () => listReturn,
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
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
    const seeded = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(seeded).toBeDefined()
    expect(seeded?.handled).toBe(false)

    // Tick 2: spawn no longer in check_permission → expire path
    listReturn = { spawns: [] }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('expired')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
  })

  test('handled=true: NO chat.update fires, entry dropped silently', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })

    let listReturn: import('agent-director').ListResult = {
      spawns: [checkPermRow()],
    }
    const getClient = () => ({
      list: async () => listReturn,
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: post, then simulate click handler success
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    markHandled(INSTANCE_C, TOKEN_A)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)

    // Tick 2: spawn disappears, handled=true → suppress chat.update
    listReturn = { spawns: [] }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
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

    // Tick 1 goes in-flight (list() hangs) and never finishes
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 5))

    // Fire 5 more ticks while the first is still in-flight → 5 skips
    for (let i = 0; i < 5; i++) {
      ivl.pending[0].cb()
    }
    await new Promise((r) => setTimeout(r, 5))

    const warnLogs = logCalls.filter((args) => String(args[0]).includes('skipped'))
    expect(warnLogs.length).toBeGreaterThan(0)

    // Unblock the hanging tick so cleanup works
    resolveTick()
    await new Promise((r) => setTimeout(r, 10))
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
      get: async () => cannedGetResult({ claude_instance_id: 'x' }),
    })
    const deps = { getClient, web: chat.web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval }
    startPermissionPoller(deps)
    startPermissionPoller(deps)
    startPermissionPoller(deps)
    expect(ivl.pending).toHaveLength(1)
  })

  test('stopPermissionPoller is safe when not started', () => {
    expect(() => stopPermissionPoller()).not.toThrow()
  })

  test('dropPermission removes the live entry', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({ getClient, web: chat.web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval })
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeDefined()
    dropPermission(INSTANCE_C, TOKEN_A)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
  })

  test('markHandled returns false when no live entry exists', () => {
    expect(markHandled('nonexistent_id', TOKEN_A)).toBe(false)
  })

  test('markHandled returns true and sets handled=true when entry exists', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({ getClient, web: chat.web as never, intervalMs: 1000, setInterval: ivl.setInterval, clearInterval: ivl.clearInterval })
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(false)
    expect(markHandled(INSTANCE_C, TOKEN_A)).toBe(true)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
  })
})
