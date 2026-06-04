/**
 * permission-poller.test.ts — SR-2.1 / SR-2.4 / SR-5 / SR-8.4 poller behavior
 * under the plural-projection wire, composite-key live map, and verdict-
 * rendering newly-closed reconciliation.
 *
 * Coverage:
 *   - New row in `permission_requests` → posts Block Kit prompt + records
 *     live entry keyed on (claude_instance_id, request_token).
 *   - Two concurrent rows on a single tick → two distinct postMessage calls,
 *     two distinct map entries.
 *   - Repeat tick with the same plural projection → no duplicate postMessage,
 *     no map mutation (duplicate-tick no-op).
 *   - Empty `permission_requests` array → zero postMessage activity from
 *     the open-rows path; existing entries from prior ticks are reconciled
 *     via `getPermission` + verdict-distinct `chat.update` + drop (SR-2.4).
 *   - `null` / `undefined` open-rows → logs and skips, no state change.
 *   - Row disappearance → `getPermission` called for the disappeared token,
 *     verdict-distinct `chat.update` lands on that row's messageTs only,
 *     entry dropped from livePermissions (SR-2.4, SR-5.3).
 *   - SR-5.1 four verdict renderings: operator_allow, operator_deny,
 *     timeout, find_missing — each visually distinct.
 *   - SR-5.2 unknown `decision_reason` → fail-closed generic deny, log,
 *     no crash, sibling rows on the same tick still proceed.
 *   - SR-2.4 not-found (`ErrPermissionRequestNotFound`) → generic deny, log,
 *     drop, no retry on subsequent ticks.
 *   - Transient `getPermission` error → entry preserved, retried next tick.
 *   - SR-5.3 sibling independence on closure: chat.update targets only the
 *     disappeared row's messageTs; the sibling's entry + messageTs are
 *     untouched.
 *   - get() ErrSpawnNotFound → continue silently.
 *   - Skipped-tick observability (5+ consecutive in-flight ticks → warn).
 *   - buildPermissionBlocks emits the UUIDv4-anchored action_id shape.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetPollerState,
  buildPermissionBlocks,
  dropPermission,
  getLivePermission,
  markHandled,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import { _resetTrailFdForTests, type TrailEventBase } from '../src/permission-trail.ts'
import { parsePermissionActionId } from '../src/permission-action-id.ts'
import {
  cannedGetPermissionResponse,
  cannedGetResult,
  cannedGetResultPlural,
  cannedListRow,
  cannedPermissionRequest,
  cannedTwoRowPluralProjection,
  errGeneric,
  errPermissionRequestNotFound,
  errSpawnNotFound,
} from './test-helpers/agent-director-stub.ts'
import type { GetPermissionParams, GetPermissionResult } from '../src/agent-director-client.ts'

// ---------------------------------------------------------------------------
// SLACK_STATE_DIR isolation — any default emitTrail in the poller would
// otherwise land on the operator's real ~/.claude/channels/slack/.
// ---------------------------------------------------------------------------

let trailTempDir: string
let origStateDir: string | undefined

beforeAll(() => {
  trailTempDir = mkdtempSync(join(tmpdir(), 'poller-trail-isolation-'))
  origStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = trailTempDir
})

afterAll(() => {
  if (origStateDir === undefined) delete process.env['SLACK_STATE_DIR']
  else process.env['SLACK_STATE_DIR'] = origStateDir
  _resetTrailFdForTests()
  rmSync(trailTempDir, { recursive: true, force: true })
})

beforeEach(() => {
  _resetTrailFdForTests()
})

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

type CapturedTrailEvent = Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown }

interface TrailCapture {
  emit: (partial: CapturedTrailEvent) => void
  events: CapturedTrailEvent[]
}

function makeTrailCapture(): TrailCapture {
  const events: CapturedTrailEvent[] = []
  return {
    events,
    emit: (partial) => { events.push(partial) },
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
  test('empty `permission_requests` array → zero postMessage; prior entry reconciled via getPermission + verdict chat.update + drop (SR-2.4)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })

    let permissionsList: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const getPermissionCalls: GetPermissionParams[] = []
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: permissionsList,
      }),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })
      },
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

    // Tick 2: empty array → SR-2.4 set-diff sees TOK_A missing → getPermission
    // fires for TOK_A → verdict chat.update lands → entry dropped.
    permissionsList = []
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // No new posts from the open-rows path
    expect(chat.calls.filter((c) => c.kind === 'postMessage')).toHaveLength(1)
    // getPermission was called exactly once for the disappeared token
    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(TOKEN_A)
    // Verdict chat.update landed on the seeded entry's messageTs
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].ts).toBe(POST_TS)
    expect(updates[0].channel).toBe(CHANNEL_CH)
    expect(updates[0].text).toBe('*Permission* — Allowed')
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

describe('poller tick — row disappears from plural projection (SR-2.4 closure reconciliation)', () => {
  test('handled=false: getPermission called → verdict chat.update fires on disappeared row → entry dropped', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })

    let listReturn: import('agent-director').ListResult = {
      spawns: [checkPermRow()],
    }
    const getPermissionCalls: GetPermissionParams[] = []
    const getClient = () => ({
      list: async () => listReturn,
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({ request_token: params.request_token, decision: 'deny', decision_reason: 'timeout' })
      },
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

    // Tick 2: spawn no longer in check_permission → SR-2.4 reconciliation
    listReturn = { spawns: [] }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(TOKEN_A)
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].ts).toBe(POST_TS)
    expect(updates[0].text).toBe('⏱ *Permission* — Timed out')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
  })

  test('handled=true: SR-2.4 reconciliation still fires verdict chat.update + drops entry', async () => {
    // Epic 3 design note: the poller-side verdict rendering is unconditional —
    // it stands in for the case where the click handler's chat.update didn't
    // land. With handled=true the click's "Allowed by X" rendering is the
    // authoritative happy-path rendering; the poller-side overwrite with the
    // verdict surface is a known, acceptable tradeoff (see source comment on
    // `buildVerdictRendering`).
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })

    let listReturn: import('agent-director').ListResult = {
      spawns: [checkPermRow()],
    }
    const getPermissionCalls: GetPermissionParams[] = []
    const getClient = () => ({
      list: async () => listReturn,
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })
      },
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

    // Tick 2: spawn disappears → reconciliation runs regardless of handled.
    listReturn = { spawns: [] }
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(TOKEN_A)
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].ts).toBe(POST_TS)
    expect(updates[0].text).toBe('*Permission* — Allowed')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SR-2.4 / SR-5 — verdict-driven newly-closed reconciliation
// ---------------------------------------------------------------------------

/**
 * Drive one full tick of the closure-reconciliation path: seed a single live
 * entry by running the poll once with the row present, then run a second tick
 * with the row absent and a canned `getPermission` response. Returns the
 * chat stub + recorded `getPermission` params so individual tests can assert
 * verdict-rendering specifics.
 */
async function seedAndClose(opts: {
  getPermissionResult?: GetPermissionResult
  getPermissionError?: Error
  postTs?: string
  token?: string
}): Promise<{
  chat: ChatStub
  ivl: ReturnType<typeof makeInterval>
  getPermissionCalls: GetPermissionParams[]
  token: string
}> {
  const ivl = makeInterval()
  const chat = makeChatStub({ tsSequence: [opts.postTs ?? POST_TS] })
  const token = opts.token ?? TOKEN_A
  const getPermissionCalls: GetPermissionParams[] = []

  let rowsPresent = true
  const getClient = () => ({
    list: async () => ({ spawns: [checkPermRow()] }),
    get: async () => cannedGetResultPlural({
      claude_instance_id: INSTANCE_C,
      state: 'check_permission',
      permission_requests: rowsPresent
        ? [cannedPermissionRequest({ request_token: token, request_id: 1 })]
        : [],
    }),
    getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
      getPermissionCalls.push(params)
      if (opts.getPermissionError) throw opts.getPermissionError
      return opts.getPermissionResult
        ?? cannedGetPermissionResponse({ request_token: params.request_token })
    },
  })
  startPermissionPoller({
    getClient,
    web: chat.web as never,
    intervalMs: 1000,
    setInterval: ivl.setInterval,
    clearInterval: ivl.clearInterval,
    log: () => { /* swallow */ },
  })

  // Tick 1: seed
  ivl.pending[0].cb()
  await new Promise((r) => setTimeout(r, 10))

  // Tick 2: row disappears → closure path
  rowsPresent = false
  ivl.pending[0].cb()
  await new Promise((r) => setTimeout(r, 10))

  return { chat, ivl, getPermissionCalls, token }
}

describe('SR-2.4 / SR-5 — newly-closed reconciliation + verdict rendering', () => {
  test('SR-5.1 operator_allow rendering — decision=allow, decision_reason=null → "*Permission* — Allowed"', async () => {
    const { chat, getPermissionCalls, token } = await seedAndClose({
      getPermissionResult: cannedGetPermissionResponse({ decision: 'allow', decision_reason: null }),
    })

    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(token)
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].channel).toBe(CHANNEL_CH)
    expect(updates[0].ts).toBe(POST_TS)
    expect(updates[0].text).toBe('*Permission* — Allowed')
    expect(getLivePermission(INSTANCE_C, token)).toBeUndefined()
  })

  test('SR-5.1 operator_deny rendering — decision=deny, decision_reason="operator" → "*Permission* — Denied by operator"', async () => {
    const { chat, token } = await seedAndClose({
      getPermissionResult: cannedGetPermissionResponse({ decision: 'deny', decision_reason: 'operator' }),
    })

    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toBe('*Permission* — Denied by operator')
    expect(getLivePermission(INSTANCE_C, token)).toBeUndefined()
  })

  test('SR-5.1 timeout rendering — decision=deny, decision_reason="timeout" → "⏱ *Permission* — Timed out"', async () => {
    const { chat, token } = await seedAndClose({
      getPermissionResult: cannedGetPermissionResponse({ decision: 'deny', decision_reason: 'timeout' }),
    })

    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toBe('⏱ *Permission* — Timed out')
    expect(getLivePermission(INSTANCE_C, token)).toBeUndefined()
  })

  test('SR-5.1 find_missing rendering — decision=deny, decision_reason="find_missing" → distinct "session ended" text', async () => {
    const { chat, token } = await seedAndClose({
      getPermissionResult: cannedGetPermissionResponse({ decision: 'deny', decision_reason: 'find_missing' }),
    })

    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    const findMissingText = updates[0].text
    expect(findMissingText).toBe('🪦 *Permission* — Session ended')

    // SR-5.1 distinctness: find_missing must NOT collapse to operator-deny or timeout text.
    expect(findMissingText).not.toBe('*Permission* — Denied by operator')
    expect(findMissingText).not.toBe('⏱ *Permission* — Timed out')
    expect(findMissingText).not.toBe('*Permission* — Denied (closed)')
    expect(getLivePermission(INSTANCE_C, token)).toBeUndefined()
  })

  test('SR-5.2 unknown decision_reason → fail-closed generic deny, log fires, poller does not crash; sibling fresh-post still happens', async () => {
    // This test specifically exercises the "bad branch did not crash the
    // tick" assertion. Seed a live entry under TOK_A, then on the next tick
    // present a fresh row under TOK_B AND drop TOK_A from the projection.
    // The dropped TOK_A goes through the unknown-enum path; TOK_B should
    // still produce a chat.postMessage.
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS, POST_TS_2] })
    const logCalls: unknown[][] = []
    const getPermissionCalls: GetPermissionParams[] = []

    let rowsPresent: Array<{ token: string; req_id: number }> = [{ token: TOKEN_A, req_id: 1 }]
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: rowsPresent.map((r) =>
          cannedPermissionRequest({ request_token: r.token, request_id: r.req_id }),
        ),
      }),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({
          request_token: params.request_token,
          decision: 'deny',
          // Intentionally outside the canonical enum to exercise the SR-5.2
          // fail-closed path. AD 0.6.1+ types decision_reason as a strict
          // union; cast through unknown so the literal lands at runtime.
          decision_reason: 'something-new' as unknown as GetPermissionResult['decision_reason'],
        })
      },
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: (...args) => { logCalls.push(args) },
    })

    // Tick 1: seed TOK_A
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.messageTs).toBe(POST_TS)

    // Tick 2: TOK_A disappears (closure with unknown decision_reason),
    // TOK_B is a fresh open row. The unknown-enum branch must NOT crash the
    // tick; TOK_B's fresh-post must still land.
    rowsPresent = [{ token: TOKEN_B, req_id: 2 }]
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // Generic-deny rendering for TOK_A
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].ts).toBe(POST_TS)
    expect(updates[0].text).toBe('*Permission* — Denied (closed)')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()

    // Log fired with the unknown value
    const unknownLogs = logCalls.filter((args) => String(args[0]).includes('unknown verdict'))
    expect(unknownLogs.length).toBe(1)

    // SR-5.2 sanity — sibling fresh-post happened despite the bad branch
    const posts = chat.calls.filter((c) => c.kind === 'postMessage')
    expect(posts).toHaveLength(2) // tick 1 (TOK_A) + tick 2 (TOK_B)
    expect(getLivePermission(INSTANCE_C, TOKEN_B)?.messageTs).toBe(POST_TS_2)
  })

  test('SR-2.4 ErrPermissionRequestNotFound → generic deny, log fires, drop, no retry on the next tick', async () => {
    // Round 1: seed TOK_A, then close with not-found.
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const logCalls: unknown[][] = []
    const getPermissionCalls: GetPermissionParams[] = []

    let rowsPresent = true
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: rowsPresent
          ? [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]
          : [],
      }),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        throw errPermissionRequestNotFound()
      },
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: (...args) => { logCalls.push(args) },
    })

    // Tick 1: seed
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // Tick 2: row disappears → not-found path
    rowsPresent = false
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(getPermissionCalls).toHaveLength(1)
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toBe('*Permission* — Denied (closed)')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
    const nfLogs = logCalls.filter((args) => String(args[0]).includes('not-found'))
    expect(nfLogs.length).toBe(1)

    // Tick 3: same shape — entry is gone, so no second getPermission call.
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getPermissionCalls).toHaveLength(1)
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(1)
  })

  test('SR-2.4 transient getPermission error → entry preserved, retried next tick when call succeeds', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const getPermissionCalls: GetPermissionParams[] = []

    let rowsPresent = true
    let throwOnNext = true
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: rowsPresent
          ? [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]
          : [],
      }),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        if (throwOnNext) throw errGeneric('get-permission', 'ErrSomethingTransient', 'oops')
        return cannedGetPermissionResponse({
          request_token: params.request_token,
          decision: 'allow',
          decision_reason: null,
        })
      },
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: () => { /* swallow */ },
    })

    // Tick 1: seed
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // Tick 2: row disappears → transient error → entry preserved, no chat.update
    rowsPresent = false
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(getPermissionCalls).toHaveLength(1)
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeDefined()

    // Tick 3: getPermission now succeeds → reconciliation completes
    throwOnNext = false
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    expect(getPermissionCalls).toHaveLength(2)
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toBe('*Permission* — Allowed')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)).toBeUndefined()
  })

  test('SR-5.3 sibling independence on closure — only the disappeared row gets chat.update; sibling untouched', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS, POST_TS_2] })
    const getPermissionCalls: GetPermissionParams[] = []

    let presentRows: Array<{ token: string; req_id: number }> = [
      { token: TOKEN_A, req_id: 1 },
      { token: TOKEN_B, req_id: 2 },
    ]
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: presentRows.map((r) =>
          cannedPermissionRequest({ request_token: r.token, request_id: r.req_id }),
        ),
      }),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({
          request_token: params.request_token,
          decision: 'allow',
          decision_reason: null,
        })
      },
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // Tick 1: seed both siblings
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.messageTs).toBe(POST_TS)
    expect(getLivePermission(INSTANCE_C, TOKEN_B)?.messageTs).toBe(POST_TS_2)

    // Tick 2: TOK_A drops from the projection; TOK_B still present
    presentRows = [{ token: TOKEN_B, req_id: 2 }]
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // SR-5.3: getPermission fired exactly once for TOK_A only
    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(TOKEN_A)

    // SR-5.3: chat.update only on TOK_A's messageTs; sibling's ts never targeted
    const updates = chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].ts).toBe(POST_TS)
    expect(updates.every((u) => u.ts !== POST_TS_2)).toBe(true)

    // Sibling entry untouched
    const siblingAfter = getLivePermission(INSTANCE_C, TOKEN_B)
    expect(siblingAfter).toBeDefined()
    expect(siblingAfter?.messageTs).toBe(POST_TS_2)
    expect(siblingAfter?.handled).toBe(false)

    // Closed entry dropped
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

// ---------------------------------------------------------------------------
// SR-V Epic 2 — cscb.poller.row_decision + cscb.chat_post.attempted
// ---------------------------------------------------------------------------

describe('trail events — cscb.poller.row_decision and cscb.chat_post.attempted', () => {
  test('action=post_attempted on a brand-new row', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const trail = makeTrailCapture()
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const decisions = trail.events.filter(e => e.event === 'cscb.poller.row_decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!['action']).toBe('post_attempted')
    expect(decisions[0]!.claude_instance_id).toBe(INSTANCE_C)
    expect(decisions[0]!.request_token).toBe(TOKEN_A)
  })

  test('action=already_tracked on second tick over the same row', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const trail = makeTrailCapture()
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const decisions = trail.events.filter(e => e.event === 'cscb.poller.row_decision')
    const actions = decisions.map(e => e['action'])
    expect(actions).toEqual(['post_attempted', 'already_tracked'])
  })

  test('action=reconciled_closed when the row disappears with a verdict', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const trail = makeTrailCapture()
    let listProjection: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: listProjection,
      }),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> =>
        cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null }),
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    listProjection = []
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const reconciled = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'reconciled_closed',
    )
    expect(reconciled).toBeDefined()
    expect(reconciled!.request_token).toBe(TOKEN_A)
    expect(reconciled!.claude_instance_id).toBe(INSTANCE_C)
  })

  test('action=not_found_generic_deny when getPermission throws ErrPermissionRequestNotFound', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const trail = makeTrailCapture()
    let listProjection: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: listProjection,
      }),
      getPermission: async (_: GetPermissionParams): Promise<GetPermissionResult> => {
        throw errPermissionRequestNotFound()
      },
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
      log: () => { /* swallow */ },
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    listProjection = []
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const notFound = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'not_found_generic_deny',
    )
    expect(notFound).toBeDefined()
    expect(notFound!.request_token).toBe(TOKEN_A)
  })

  test('action=non_conforming_skipped omits request_token entirely (SR-V-1.1)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const trail = makeTrailCapture()
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResult({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: null,
      }),
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
      log: () => { /* swallow */ },
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const nc = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'non_conforming_skipped',
    )
    expect(nc).toBeDefined()
    expect(nc!.claude_instance_id).toBe(INSTANCE_C)
    // request_token MUST be absent — not an empty string (SR-V-1.1).
    expect('request_token' in nc!).toBe(false)
  })

  test('action=transient_retry when getPermission throws a non-not-found error', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const trail = makeTrailCapture()
    let listProjection: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: listProjection,
      }),
      getPermission: async (_: GetPermissionParams): Promise<GetPermissionResult> => {
        throw errGeneric('get-permission', 'ErrTransient', 'transient')
      },
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
      log: () => { /* swallow */ },
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))
    listProjection = []
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const transient = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'transient_retry',
    )
    expect(transient).toBeDefined()
    expect(transient!.request_token).toBe(TOKEN_A)
  })

  test('cscb.chat_post.attempted on success carries full text+blocks and Slack-returned ts', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const trail = makeTrailCapture()
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const post = trail.events.find(e => e.event === 'cscb.chat_post.attempted')
    expect(post).toBeDefined()
    expect(post!['ok']).toBe(true)
    expect(post!['slack_ts']).toBe(POST_TS)
    expect(post!.channel).toBe(CHANNEL_CH)
    expect(typeof post!['text']).toBe('string')
    expect(Array.isArray(post!['blocks'])).toBe(true)
  })

  test('SR-V-1.4 action_id decode round-trip from persisted blocks', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const trail = makeTrailCapture()
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const post = trail.events.find(e => e.event === 'cscb.chat_post.attempted')!
    const blocks = post['blocks'] as Array<Record<string, unknown>>
    const actions = blocks.find(b => b['type'] === 'actions') as
      { elements: Array<{ action_id: string }> } | undefined
    expect(actions).toBeDefined()
    const allow = actions!.elements[0]!.action_id
    const deny = actions!.elements[1]!.action_id

    const decAllow = parsePermissionActionId(allow)
    const decDeny = parsePermissionActionId(deny)
    expect(decAllow).toEqual({ decision: 'allow', claudeInstanceId: INSTANCE_C, requestToken: TOKEN_A })
    expect(decDeny).toEqual({ decision: 'deny', claudeInstanceId: INSTANCE_C, requestToken: TOKEN_A })
  })

  test('cscb.chat_post.attempted on Slack platform failure carries error class string, not Error.name', async () => {
    const ivl = makeInterval()
    const platformError = Object.assign(new Error('platform error'), {
      name: 'WebAPIPlatformError',
      data: { ok: false, error: 'channel_not_found' },
    })
    const chat = makeChatStub({ postMessageError: platformError })
    const trail = makeTrailCapture()
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
      log: () => { /* swallow */ },
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const post = trail.events.find(e => e.event === 'cscb.chat_post.attempted')
    expect(post).toBeDefined()
    expect(post!['ok']).toBe(false)
    expect(post!['error']).toBe('channel_not_found')
  })

  test('row_decision and chat_post.attempted share request_token on the same tick', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS] })
    const trail = makeTrailCapture()
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
    })

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const decision = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'post_attempted',
    )
    const post = trail.events.find(e => e.event === 'cscb.chat_post.attempted')
    expect(decision!.request_token).toBe(TOKEN_A)
    expect(post!.request_token).toBe(TOKEN_A)
    expect(decision!.claude_instance_id).toBe(post!.claude_instance_id)
  })
})

// ---------------------------------------------------------------------------
// SR-V Epic 3 — cscb.chat_update.attempted (poller-triggered)
// ---------------------------------------------------------------------------

describe('trail events — cscb.chat_update.attempted (poller-triggered)', () => {
  function makeClosureScenario(
    getPermissionImpl: (params: GetPermissionParams) => Promise<GetPermissionResult>,
    updateError?: Error,
  ): {
    ivl: ReturnType<typeof makeInterval>
    chat: ReturnType<typeof makeChatStub>
    trail: ReturnType<typeof makeTrailCapture>
    drive: () => Promise<void>
  } {
    const ivl = makeInterval()
    const chatOpts: { tsSequence: [string]; updateError?: Error } = { tsSequence: [POST_TS] }
    if (updateError !== undefined) chatOpts.updateError = updateError
    const chat = makeChatStub(chatOpts)
    const trail = makeTrailCapture()
    let listProjection: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: listProjection,
      }),
      getPermission: getPermissionImpl,
    })
    startPermissionPoller({
      getClient, web: chat.web as never, intervalMs: 1000,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      emitTrail: trail.emit,
      log: () => { /* swallow */ },
    })
    const drive = async (): Promise<void> => {
      ivl.pending[0].cb()
      await new Promise(r => setTimeout(r, 10))
      listProjection = []
      ivl.pending[0].cb()
      await new Promise(r => setTimeout(r, 10))
    }
    return { ivl, chat, trail, drive }
  }

  test('operator_allow → ok=true, triggered_by=poller, target ts matches prompt', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'allow', decision_reason: null }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure).toBeDefined()
    expect(closure!['verdict_tag']).toBe('operator_allow')
    expect(closure!['triggered_by']).toBe('poller')
    expect(closure!['ok']).toBe(true)
    expect(closure!.channel).toBe(CHANNEL_CH)
    expect(closure!.message_ts).toBe(POST_TS)
    expect(typeof closure!['text']).toBe('string')
    expect(Array.isArray(closure!['blocks'])).toBe(true)
  })

  test('operator_deny verdict tag', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'deny', decision_reason: 'operator' }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('operator_deny')
    expect(closure!['triggered_by']).toBe('poller')
  })

  test('timeout verdict tag', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'deny', decision_reason: 'timeout' }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('timeout')
  })

  test('find_missing verdict tag', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'deny', decision_reason: 'find_missing' }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('find_missing')
  })

  test('unknown verdict tag on weird decision/reason pair', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'deny', decision_reason: 'someone_else' as never }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('unknown')
  })

  test('not_found verdict tag when getPermission throws ErrPermissionRequestNotFound', async () => {
    const scenario = makeClosureScenario(async (_) => { throw errPermissionRequestNotFound() })
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('not_found')
  })

  test('closure chat.update failure → ok=false, error=Slack platform error class', async () => {
    const platformError = Object.assign(new Error('platform error'), {
      name: 'WebAPIPlatformError',
      data: { ok: false, error: 'message_not_found' },
    })
    const scenario = makeClosureScenario(
      async (p) => cannedGetPermissionResponse({ request_token: p.request_token, decision: 'allow', decision_reason: null }),
      platformError,
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure).toBeDefined()
    expect(closure!['ok']).toBe(false)
    expect(closure!['error']).toBe('message_not_found')
    expect(closure!['triggered_by']).toBe('poller')
  })
})
