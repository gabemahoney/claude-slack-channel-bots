/**
 * relay-repro.test.ts — Epic 3 SR-8.4 capstone acceptance scenario.
 *
 * Drives the full two-row permission-relay flow end-to-end against stubs:
 *
 *   Tick N
 *     ├── list() reports 1 spawn in check_permission
 *     ├── get() returns the plural projection carrying two open rows
 *     │   (row_A = TOK_A, row_B = TOK_B) on the same claude_instance_id
 *     └── poller posts TWO distinct chat.postMessage calls + records two
 *         pending-map entries keyed on (claudeInstanceId, TOK_*)
 *
 *   Click row A as allow
 *     └── handlePermissionClick → decide({decision:'allow', request_token: TOK_A})
 *         → chat.update on row_A's messageTs ("*Permission* — Allowed")
 *         → markHandled(TOK_A)
 *
 *   Click row B as deny
 *     └── handlePermissionClick → decide({decision:'deny',  request_token: TOK_B})
 *         → chat.update on row_B's messageTs ("*Permission* — Denied by operator")
 *         → markHandled(TOK_B)
 *
 *   Tick N+1
 *     ├── list() reports 1 spawn still in check_permission
 *     ├── get() returns the plural projection with permission_requests: []
 *     ├── set-diff identifies TOK_A and TOK_B as newly closed
 *     ├── getPermission(TOK_A) → allow/null,  getPermission(TOK_B) → deny/operator
 *     └── exactly two chat.update calls (one per row), each on its own
 *         messageTs, with verdict-distinct text
 *
 * Coverage of SR-8.4 capstone bullets:
 *   - Two concurrent `permission_requests` entries → two distinct prompts
 *   - One allow + one deny click → two decide calls, each carrying the
 *     matching `request_token`
 *   - Tick N+1 observes both tokens absent → two `getPermission` calls
 *   - Two `chat.update` calls land on the correct Slack message timestamps
 *   - livePermissions empty at the end
 *   - No `chat.update` ever targets a sibling's messageTs in response to a
 *     single-row event (SR-4.5 / SR-5.3 compounded)
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { Client, DecideParams, DecideResult, ListResult } from 'agent-director'

import { handlePermissionClick } from '../src/permission-click-handler.ts'
import { _resetOutageState, initOutageState } from '../src/outage-state.ts'
import { encodePermissionActionId } from '../src/permission-action-id.ts'
import {
  _resetPollerState,
  getLivePermission,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import type { GetPermissionParams, GetPermissionResult } from '../src/agent-director-client.ts'
import {
  cannedGetPermissionResponse,
  cannedGetResultPlural,
  cannedListRow,
  cannedPermissionRequest,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Pinned constants (no inline magic strings per SR-8.1)
// ---------------------------------------------------------------------------

const INSTANCE_C = 'cscb_C'
const CHANNEL_CH = 'CH'
const POST_TS_A = 'TS.row_A'
const POST_TS_B = 'TS.row_B'

// Well-formed UUIDv4-shaped opaque tokens. CSCB treats them as opaque strings.
const TOK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'


// ---------------------------------------------------------------------------
// Shared test plumbing — manual interval + chat-recording stub
// ---------------------------------------------------------------------------

interface ManualInterval { cb: () => void; ms: number; cleared: boolean }
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
}

function makeChatStub(opts: { tsSequence: string[] }): {
  web: {
    chat: {
      postMessage: (args: unknown) => Promise<{ ts: string }>
      update: (args: unknown) => Promise<unknown>
    }
  }
  calls: ChatCall[]
} {
  const calls: ChatCall[] = []
  const seq = [...opts.tsSequence]
  let fallback = 0
  return {
    web: {
      chat: {
        async postMessage(args: unknown): Promise<{ ts: string }> {
          const a = args as { channel: string; text: string }
          const ts = seq.shift() ?? `auto-${++fallback}`
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text, ts })
          return { ts }
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

afterEach(() => {
  stopPermissionPoller()
  _resetPollerState()
  _resetOutageState()
})

// ---------------------------------------------------------------------------
// SR-8.4 capstone
// ---------------------------------------------------------------------------

describe('SR-8.4 capstone — two-row plural projection end-to-end', () => {
  test('two prompts → one allow + one deny click → next tick reconciles both via getPermission', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ tsSequence: [POST_TS_A, POST_TS_B] })

    // Tick-N projection presence is mutable: starts with both rows, then
    // empties for tick N+1 to drive the closure path.
    let openRows: Array<{ token: string; req_id: number; tool_name: string; tool_input: string }> = [
      { token: TOK_A, req_id: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'ls /tmp' }) },
      { token: TOK_B, req_id: 2, tool_name: 'Edit', tool_input: JSON.stringify({ file_path: '/etc/hosts' }) },
    ]

    const listResult: ListResult = {
      spawns: [
        cannedListRow({
          claude_instance_id: INSTANCE_C,
          state: 'check_permission',
          labels: { service: 'cscb', channel: CHANNEL_CH },
        }),
      ],
    }

    const decideCalls: DecideParams[] = []
    const getPermissionCalls: GetPermissionParams[] = []

    // A single getClient factory shared by the poller + click handler so
    // every AD-bound mutation lands on the same recording arrays.
    const sharedClient = {
      list: async (): Promise<ListResult> => listResult,
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: openRows.map((r) =>
          cannedPermissionRequest({
            request_token: r.token,
            request_id: r.req_id,
            tool_name: r.tool_name,
            tool_input: r.tool_input,
          }),
        ),
      }),
      decide: async (params: DecideParams): Promise<DecideResult> => {
        decideCalls.push(params)
        return {}
      },
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        // Deterministic per-token canned response so tick N+1 reconciles
        // TOK_A as operator-allow and TOK_B as operator-deny.
        if (params.request_token === TOK_A) {
          return cannedGetPermissionResponse({
            request_token: TOK_A,
            decision: 'allow',
            decision_reason: null,
          })
        }
        return cannedGetPermissionResponse({
          request_token: TOK_B,
          decision: 'deny',
          decision_reason: 'operator',
        })
      },
    }
    const getClient = () => sharedClient

    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    // -----------------------------------------------------------------
    // Tick N — two open rows produce two distinct prompts
    // -----------------------------------------------------------------
    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    const tickNPosts = chat.calls.filter((c) => c.kind === 'postMessage')
    expect(tickNPosts).toHaveLength(2)
    expect(tickNPosts.every((c) => c.channel === CHANNEL_CH)).toBe(true)
    // Two distinct ts values, matching the seeded sequence
    const tickNTs = new Set(tickNPosts.map((c) => c.ts))
    expect(tickNTs).toEqual(new Set([POST_TS_A, POST_TS_B]))

    // Two pending-map entries, each on the composite key
    const entryA = getLivePermission(INSTANCE_C, TOK_A)
    const entryB = getLivePermission(INSTANCE_C, TOK_B)
    expect(entryA).toBeDefined()
    expect(entryB).toBeDefined()
    expect(entryA?.messageTs).toBe(POST_TS_A)
    expect(entryB?.messageTs).toBe(POST_TS_B)
    expect(entryA?.requestToken).toBe(TOK_A)
    expect(entryB?.requestToken).toBe(TOK_B)

    // -----------------------------------------------------------------
    // Click row A as ALLOW
    // -----------------------------------------------------------------
    initOutageState({ getClient: getClient as unknown as () => Client, postToChannel: () => {} })
    const allowActionId = encodePermissionActionId('allow', INSTANCE_C, TOK_A)
    const allowHandled = await handlePermissionClick(allowActionId, {
      web: chat.web as never,
    })
    expect(allowHandled).toBe(true)

    // Exactly one decide call so far: allow on TOK_A
    expect(decideCalls).toHaveLength(1)
    expect(decideCalls[0]).toEqual({
      claude_instance_id: INSTANCE_C,
      decision: 'allow',
      request_token: TOK_A,
    } as DecideParams & { request_token: string })
    // Exactly one chat.update, on row_A's ts
    const afterAllowUpdates = chat.calls.filter((c) => c.kind === 'update')
    expect(afterAllowUpdates).toHaveLength(1)
    expect(afterAllowUpdates[0].ts).toBe(POST_TS_A)
    expect(afterAllowUpdates[0].text).toBe('*Permission* — Allowed')
    // markHandled landed on TOK_A only
    expect(getLivePermission(INSTANCE_C, TOK_A)?.handled).toBe(true)
    expect(getLivePermission(INSTANCE_C, TOK_B)?.handled).toBe(false)

    // -----------------------------------------------------------------
    // Click row B as DENY
    // -----------------------------------------------------------------
    const denyActionId = encodePermissionActionId('deny', INSTANCE_C, TOK_B)
    const denyHandled = await handlePermissionClick(denyActionId, {
      web: chat.web as never,
    })
    expect(denyHandled).toBe(true)

    // Two decide calls now: allow(TOK_A) followed by deny(TOK_B)
    expect(decideCalls).toHaveLength(2)
    expect(decideCalls[1]).toEqual({
      claude_instance_id: INSTANCE_C,
      decision: 'deny',
      request_token: TOK_B,
    } as DecideParams & { request_token: string })
    // Two chat.updates: one per row's ts
    const afterDenyUpdates = chat.calls.filter((c) => c.kind === 'update')
    expect(afterDenyUpdates).toHaveLength(2)
    expect(afterDenyUpdates[1].ts).toBe(POST_TS_B)
    expect(afterDenyUpdates[1].text).toBe('*Permission* — Denied by operator')
    // markHandled landed on both now
    expect(getLivePermission(INSTANCE_C, TOK_A)?.handled).toBe(true)
    expect(getLivePermission(INSTANCE_C, TOK_B)?.handled).toBe(true)

    // -----------------------------------------------------------------
    // Tick N+1 — both rows closed in AD; reconciliation runs
    // -----------------------------------------------------------------
    openRows = []
    const postsBeforeTickNPlus1 = chat.calls.filter((c) => c.kind === 'postMessage').length
    const updatesBeforeTickNPlus1 = chat.calls.filter((c) => c.kind === 'update').length

    ivl.pending[0].cb()
    await new Promise((r) => setTimeout(r, 10))

    // Zero new postMessage activity on the closure tick
    expect(chat.calls.filter((c) => c.kind === 'postMessage').length).toBe(postsBeforeTickNPlus1)

    // Exactly two getPermission calls, one per token (order-insensitive)
    expect(getPermissionCalls).toHaveLength(2)
    expect(new Set(getPermissionCalls.map((c) => c.request_token))).toEqual(new Set([TOK_A, TOK_B]))

    // Two new chat.update calls beyond what the clicks produced
    const allUpdates = chat.calls.filter((c) => c.kind === 'update')
    const tickNPlus1Updates = allUpdates.slice(updatesBeforeTickNPlus1)
    expect(tickNPlus1Updates).toHaveLength(2)

    // Each verdict-distinct update lands on its own row's messageTs
    const byTs = new Map(tickNPlus1Updates.map((u) => [u.ts, u.text]))
    expect(byTs.get(POST_TS_A)).toBe('*Permission* — Allowed')
    expect(byTs.get(POST_TS_B)).toBe('*Permission* — Denied by operator')

    // SR-5.3 sanity: no closure-tick chat.update accidentally targeted the
    // wrong sibling's ts.
    for (const u of tickNPlus1Updates) {
      expect(u.ts === POST_TS_A || u.ts === POST_TS_B).toBe(true)
    }

    // Both entries dropped — livePermissions is empty
    expect(getLivePermission(INSTANCE_C, TOK_A)).toBeUndefined()
    expect(getLivePermission(INSTANCE_C, TOK_B)).toBeUndefined()
  })
})
